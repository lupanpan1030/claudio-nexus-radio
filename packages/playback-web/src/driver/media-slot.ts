import type { DurationInfo, ErrorInfo, MediaEvent, PlayRejection } from "@claudio/contracts";
import type { Timers } from "../ports.js";
import type { ChannelClock, PausedObservation } from "./types.js";

export interface MediaTimeouts {
  /** From load start until `canplay`. */
  readonly loadMs: number;
  /** From a play request until `playing` (covers a play() promise that never settles). */
  readonly startMs: number;
  /** Continuous `waiting` while playback is wanted. */
  readonly stallMs: number;
  /** AudioContext.resume() before reporting the play as not allowed. */
  readonly unlockMs: number;
}

/** Bounds, not measured optima; a stalled stream is reported instead of hanging silently forever. */
export const DEFAULT_MEDIA_TIMEOUTS: MediaTimeouts = Object.freeze({ loadMs: 20_000, startMs: 15_000, stallMs: 20_000, unlockMs: 4_000 });

export interface MediaSlotOptions {
  readonly element: HTMLAudioElement;
  readonly context: AudioContext;
  readonly input: AudioNode;
  readonly url: string;
  readonly crossOrigin: "anonymous" | "use-credentials" | null;
  readonly startAtMs: number;
  readonly playbackRate: number;
  readonly emit: (event: MediaEvent) => void;
  readonly timers: Timers;
  readonly timeouts: MediaTimeouts;
  readonly clock: () => number;
  /** Minimum spacing of `time` observations forwarded from `timeupdate`. */
  readonly timeIntervalMs: number;
  /** Resolves true once the shared AudioContext is running (bounded by the caller). */
  readonly ensureRunning: () => Promise<boolean> | true;
}

type Watchdog = "load" | "start" | "stall";

/**
 * One load of one media element. A new load always gets a new element and a
 * new MediaElementAudioSourceNode; releasing removes every listener through
 * one AbortController before the element is emptied. Queued DOM tasks and
 * play() promises of an old load therefore cannot reach the runtime under a
 * newer identity: the listeners are gone and every callback checks `released`
 * and the play token it was issued with.
 */
export class MediaSlot {
  private readonly element: HTMLAudioElement;
  private readonly source: MediaElementAudioSourceNode;
  private readonly listeners = new AbortController();
  private readonly watchdogs = new Map<Watchdog, unknown>();
  private released = false;
  private failed = false;
  private wantPlay = false;
  private waiting = false;
  private everPlayed = false;
  private playToken = 0;
  private pendingSeekMs: number | null;
  private lastTimeEmit = -Infinity;
  private lastDurationMs: number | null | undefined = undefined;
  /** Own pause() calls made while the element was playing, each answered by one `pause` event. */
  private requestedPauses = 0;

  constructor(private readonly options: MediaSlotOptions) {
    const element = options.element;
    this.element = element;
    this.pendingSeekMs = options.startAtMs > 0 ? options.startAtMs : null;
    element.preload = "auto";
    if (options.crossOrigin) element.crossOrigin = options.crossOrigin;
    this.source = options.context.createMediaElementSource(element);
    this.source.connect(options.input);
    this.listen();
    element.playbackRate = options.playbackRate;
    element.defaultPlaybackRate = options.playbackRate;
    element.src = options.url;
    this.arm("load", options.timeouts.loadMs, () => this.fail({ class: "retryable", code: "media_load_timeout" }));
    element.load();
  }

  get isReleased(): boolean {
    return this.released;
  }

  play(): void {
    if (this.released || this.failed) return;
    this.wantPlay = true;
    // Already rolling: play() would resolve without a new `playing` event, so no start watchdog.
    if (!this.element.paused && this.everPlayed) return;
    const token = ++this.playToken;
    this.arm("start", this.options.timeouts.startMs, () => {
      if (token === this.playToken) this.fail({ class: "retryable", code: "media_start_timeout" });
    });
    const ready = this.options.ensureRunning();
    if (ready === true) return this.callPlay(token);
    ready.then(
      (running) => {
        if (token !== this.playToken || this.released) return;
        if (running) return this.callPlay(token);
        this.disarm("start");
        this.wantPlay = false;
        this.options.emit({ kind: "play-rejected", reason: "not-allowed" });
      },
      () => {
        if (token !== this.playToken || this.released) return;
        this.disarm("start");
        this.wantPlay = false;
        this.options.emit({ kind: "play-rejected", reason: "not-allowed" });
      }
    );
  }

  pause(): void {
    if (this.released) return;
    this.wantPlay = false;
    this.playToken += 1; // a pending play() rejection caused by this pause is expected, not reported
    this.disarm("start");
    this.disarm("stall");
    // pause() on an already paused element fires no event, so only count calls that will be answered.
    if (!this.element.paused) this.requestedPauses += 1;
    this.element.pause();
  }

  seek(positionMs: number): void {
    if (this.released || this.failed) return;
    const target = Math.max(0, positionMs);
    if (this.element.readyState >= HAVE_METADATA) this.element.currentTime = target / 1000;
    else this.pendingSeekMs = target;
  }

  readClock(): ChannelClock {
    const el = this.element;
    const observedAt = this.options.clock();
    return { positionMs: el.currentTime * 1000, rate: this.rate(), observedAt, state: this.state() };
  }

  /** Re-report the current position (after a background period, the timeupdate cadence may have lapsed). */
  resample(): void {
    if (this.released || this.failed || this.element.readyState < HAVE_METADATA) return;
    this.lastTimeEmit = this.options.clock();
    this.options.emit({ kind: "time", positionMs: this.element.currentTime * 1000, rate: this.rate() });
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.wantPlay = false;
    this.playToken += 1;
    for (const kind of [...this.watchdogs.keys()]) this.disarm(kind);
    this.listeners.abort();
    const el = this.element;
    try {
      el.pause();
      el.removeAttribute("src");
      el.load(); // drops the network request and decoded buffers
    } catch {
      // element already torn down
    }
    try {
      this.source.disconnect();
    } catch {
      // already disconnected
    }
  }

  private state(): ChannelClock["state"] {
    const el = this.element;
    if (this.failed) return "failed";
    if (el.ended) return "ended";
    if (!this.everPlayed && el.paused) return el.readyState >= HAVE_FUTURE_DATA ? "paused" : "loading";
    if (el.paused) return "paused";
    return this.waiting ? "waiting" : "playing";
  }

  private rate(): number {
    const el = this.element;
    if (this.released || this.failed || el.paused || el.ended || this.waiting || el.readyState < HAVE_FUTURE_DATA) return 0;
    return el.playbackRate;
  }

  private callPlay(token: number): void {
    let pending: Promise<void> | undefined;
    try {
      pending = this.element.play();
    } catch (error) {
      pending = Promise.reject(error);
    }
    // play() resolving is not "playing": only the `playing` event is reported as such.
    pending?.catch((error: unknown) => {
      if (token !== this.playToken || this.released || this.failed) return;
      this.disarm("start");
      this.wantPlay = false;
      this.options.emit({ kind: "play-rejected", reason: rejectionOf(error) });
    });
  }

  private listen(): void {
    const el = this.element;
    const signal = this.listeners.signal;
    const on = (type: string, handler: () => void) =>
      el.addEventListener(
        type,
        () => {
          if (!this.released) handler();
        },
        { signal }
      );
    const position = () => el.currentTime * 1000;

    on("loadedmetadata", () => {
      if (this.pendingSeekMs !== null) {
        el.currentTime = this.pendingSeekMs / 1000;
        this.pendingSeekMs = null;
      }
      this.emitDuration();
    });
    // Streams can refine their duration later; each change is a new measurement.
    on("durationchange", () => {
      if (el.readyState >= HAVE_METADATA) this.emitDuration();
    });
    on("canplay", () => {
      this.disarm("load");
      this.emitIfLive({ kind: "can-play", through: false });
    });
    on("canplaythrough", () => {
      this.disarm("load");
      this.emitIfLive({ kind: "can-play", through: true });
    });
    on("playing", () => {
      this.waiting = false;
      this.everPlayed = true;
      this.disarm("start");
      this.disarm("stall");
      this.emitIfLive({ kind: "playing", positionMs: position() });
    });
    on("waiting", () => {
      this.waiting = true;
      if (this.wantPlay) this.arm("stall", this.options.timeouts.stallMs, () => this.fail({ class: "retryable", code: "media_stall_timeout" }));
      this.emitIfLive({ kind: "waiting", positionMs: position() });
    });
    on("stalled", () => this.emitIfLive({ kind: "stalled" }));
    on("pause", () => {
      this.waiting = false;
      this.disarm("stall");
      const requested = this.requestedPauses > 0;
      if (requested) this.requestedPauses -= 1;
      const observation: PausedObservation = { kind: "paused", positionMs: position(), atEnd: el.ended, requested };
      this.emitIfLive(observation);
    });
    on("seeked", () => this.emitIfLive({ kind: "seeked", positionMs: position() }));
    on("ratechange", () => this.emitIfLive({ kind: "time", positionMs: position(), rate: this.rate() }));
    on("timeupdate", () => {
      const now = this.options.clock();
      if (now - this.lastTimeEmit < this.options.timeIntervalMs) return;
      this.lastTimeEmit = now;
      this.emitIfLive({ kind: "time", positionMs: position(), rate: this.rate() });
    });
    on("ended", () => {
      this.wantPlay = false;
      this.waiting = false;
      this.disarm("start");
      this.disarm("stall");
      this.emitIfLive({ kind: "ended" });
    });
    on("error", () => this.fail(mediaErrorInfo(el.error)));
  }

  private emitDuration(): void {
    const duration = durationOf(this.element);
    const ms = duration.kind === "known" ? duration.ms : null;
    if (ms === this.lastDurationMs) return;
    this.lastDurationMs = ms;
    this.emitIfLive({ kind: "metadata", duration });
  }

  private emitIfLive(event: MediaEvent): void {
    if (this.released || this.failed) return;
    this.options.emit(event);
  }

  /** Terminal for this load: one classified error, then silence until released. */
  private fail(error: ErrorInfo): void {
    if (this.released || this.failed) return;
    // Settle locally first: the runtime may react to the error re-entrantly (unload, refresh).
    this.failed = true;
    this.wantPlay = false;
    this.playToken += 1;
    for (const kind of [...this.watchdogs.keys()]) this.disarm(kind);
    try {
      this.element.pause();
    } catch {
      // ignore
    }
    this.options.emit({ kind: "error", error });
  }

  private arm(kind: Watchdog, ms: number, onExpire: () => void): void {
    this.disarm(kind);
    const handle = this.options.timers.setTimeout(() => {
      if (this.watchdogs.get(kind) !== handle) return;
      this.watchdogs.delete(kind);
      onExpire();
    }, ms);
    this.watchdogs.set(kind, handle);
  }

  private disarm(kind: Watchdog): void {
    const handle = this.watchdogs.get(kind);
    if (handle === undefined) return;
    this.options.timers.clearTimeout(handle);
    this.watchdogs.delete(kind);
  }
}

const HAVE_METADATA = 1;
const HAVE_FUTURE_DATA = 3;

function durationOf(el: HTMLMediaElement): DurationInfo {
  const seconds = el.duration;
  // Live/unknown streams report Infinity or NaN: unknown stays unknown.
  return Number.isFinite(seconds) && seconds > 0 ? { kind: "known", ms: seconds * 1000, source: "media-element" } : { kind: "unknown" };
}

function rejectionOf(error: unknown): PlayRejection {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
      return "not-allowed";
    case "AbortError":
      return "aborted";
    case "NotSupportedError":
      return "unsupported";
    default:
      return "unknown";
  }
}

export function mediaErrorInfo(error: MediaError | null): ErrorInfo {
  switch (error?.code) {
    case 1: // MEDIA_ERR_ABORTED: fetching stopped without a user action we know of
      return { class: "retryable", code: "media_aborted", message: error.message || undefined };
    case 2: // MEDIA_ERR_NETWORK
      return { class: "retryable", code: "media_network", message: error.message || undefined };
    case 3: // MEDIA_ERR_DECODE
      return { class: "unavailable", code: "media_decode", message: error.message || undefined };
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED (also 404 / unsupported type)
      return { class: "unavailable", code: "media_unsupported", message: error.message || undefined };
    default:
      return { class: "unavailable", code: "media_error" };
  }
}
