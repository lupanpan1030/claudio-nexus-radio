import type { DurationInfo, ErrorInfo, MediaEvent, PlayRejection, PlayRequestId } from "@claudio/contracts";
import type { Timers } from "../ports.js";
import type { ChannelClock } from "./types.js";

export interface MediaTimeouts {
  /** From load start until `canplay`. */
  readonly loadMs: number;
  /** From a play request until `playing` (covers a play() promise that never settles). */
  readonly startMs: number;
  /** Continuous `waiting` while playback is wanted. */
  readonly stallMs: number;
  /** AudioContext.resume() before reporting the play as not allowed. */
  readonly unlockMs: number;
  /**
   * How often an unanswered seek is checked. While `element.seeking` the
   * check re-arms; once the element is no longer seeking and no `seeked`
   * came, the seek is answered from the element's actual position.
   */
  readonly seekCheckMs: number;
}

/** Bounds, not measured optima; a stalled stream is reported instead of hanging silently forever. */
export const DEFAULT_MEDIA_TIMEOUTS: MediaTimeouts = Object.freeze({ loadMs: 20_000, startMs: 15_000, stallMs: 20_000, unlockMs: 4_000, seekCheckMs: 1_000 });

/** What waiting for the shared AudioContext to run ended with. */
export type OutputReadiness = "running" | "not-allowed" | "closed";

/** The shared output can never run again (context closed outside our dispose). */
export const OUTPUT_CLOSED: ErrorInfo = Object.freeze({ class: "unavailable", code: "audio_output_closed" });

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
  /** "running" synchronously when the shared AudioContext runs; otherwise a bounded wait (see BrowserDriver). */
  readonly ensureRunning: () => Promise<OutputReadiness> | OutputReadiness;
  /** Whether the shared AudioContext is running when the slot is created; later changes arrive via setOutputRunning. */
  readonly outputRunning: boolean;
  /** Debug notes (dropped/synthesized observations) for logs and test evidence. */
  readonly note?: (event: string, data?: unknown) => void;
}

type Watchdog = "load" | "start" | "stall" | "seek";

/**
 * One load of one media element. A new load always gets a new element and a
 * new MediaElementAudioSourceNode; releasing removes every listener through
 * one AbortController before the element is emptied. Queued DOM tasks and
 * play() promises of an old load therefore cannot reach the runtime under a
 * newer identity: the listeners are gone and every callback checks `released`
 * and the play token it was issued with.
 *
 * Within one load, media events are queued on the element's own task source
 * and dispatched in order. That order is what attributes them:
 *  - every paused→playing transition of the element is followed by exactly
 *    one `pause` event when it pauses again (own pause(), natural end, OS),
 *    and each such transition queues one `play` event. The slot counts the
 *    transitions it observes from `element.paused` — at every own call and
 *    at every event it handles, so also unpauses by other code whose `play`
 *    event is still queued — and so knows how many `pause` events are still
 *    owed and which one, by ordinal, answers a pause() call: the next one if
 *    the call paused the element, an earlier still-queued one if the element
 *    was already paused, none if nothing is owed (then it acknowledges at once);
 *  - a `playing`/`waiting` dispatched while a `pause` event is still owed was
 *    queued before that pause and belongs to a superseded play, so it is not
 *    reported (a later play's `playing` follows the `pause`);
 *  - a `pause` event still owed when play() is called predates that request
 *    (the platform, another agent or the natural end paused the element
 *    before it was asked to play again): it is superseded, not reported as an
 *    interruption, unless it answers a pause() call;
 *  - an `ended` dispatched once the element is no longer ended (a seek or
 *    play since moved it off the end) describes the old position and is not
 *    reported; it changes nothing the slot wants;
 *  - a `seeked` dispatched while the element is seeking again answers an
 *    older target; only the latest seek is acknowledged.
 * Not attributable: a pause and an unpause by other code in the same task,
 * with no slot call or event between them, leave `element.paused` unchanged;
 * that `pause` is reported as an interruption.
 * DOM events carry no request identity; only a play() promise does, so only
 * `play-rejected` names the play request (playId) it answers.
 *
 * The element's clock only advances while the shared AudioContext renders.
 * While it does not (suspended, interrupted), the slot reports rate 0 and a
 * `waiting` for a channel that was reported playing; when it runs again a
 * channel that still wants to play and whose element is still unpaused
 * reports `playing` at its actual position. A paused, ended or released
 * element is never revived by the context resuming.
 */
export class MediaSlot {
  private readonly element: HTMLAudioElement;
  private readonly source: MediaElementAudioSourceNode;
  private readonly listeners = new AbortController();
  private readonly watchdogs = new Map<Watchdog, unknown>();
  private released = false;
  private failed = false;
  private wantPlay = false;
  /** Network starvation (`waiting` event), independent of the output state. */
  private waiting = false;
  private everPlayed = false;
  private playToken = 0;
  private pendingSeekMs: number | null;
  /** An own seek has not been acknowledged with `seeked` yet. */
  private seekUnanswered = false;
  private lastTimeEmit = -Infinity;
  private lastDurationMs: number | null | undefined = undefined;
  /** element.paused as last observed; a difference found later is a transition by other code. */
  private lastKnownPaused = true;
  /** paused→playing transitions observed so far, by own play() or anyone else. */
  private unpauses = 0;
  /** Of those, transitions whose `play` event has not been dispatched yet. */
  private playEventsAhead = 0;
  private pauseEventsSeen = 0;
  /** `pause` events up to this ordinal predate a later play() and are not interruptions. */
  private supersededThrough = 0;
  /** Pause acknowledgements owed, keyed by the ordinal of the `pause` event that answers them. */
  private readonly pendingAcks = new Map<number, number>();
  private outputRunning: boolean;
  /** The last rolling observation sent was `playing` (the core may extrapolate). */
  private reportedPlaying = false;
  /** A `playing` is owed once the output runs again. */
  private owedPlaying = false;
  /** Watchdogs suspended while the output is not running (a frozen clock is not a stall). */
  private readonly heldWatchdogs = new Set<"start" | "stall">();

  constructor(private readonly options: MediaSlotOptions) {
    const element = options.element;
    this.element = element;
    this.outputRunning = options.outputRunning;
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

  play(playId: PlayRequestId): void {
    if (this.released || this.failed) return;
    this.observePaused();
    // Every `pause` still owed was queued before this request: it no longer describes what is wanted.
    this.supersededThrough = Math.max(this.supersededThrough, this.pauseTransitions());
    this.wantPlay = true;
    // Already rolling: play() would resolve without a new `playing` event, so no start watchdog.
    if (!this.element.paused && this.everPlayed) return;
    const token = ++this.playToken;
    this.armStart();
    const ready = this.options.ensureRunning();
    if (typeof ready === "string") return ready === "running" ? this.callPlay(token, playId) : this.refusePlay(ready, playId);
    ready.then(
      (result) => {
        if (token !== this.playToken || this.released || this.failed) return;
        if (result === "running") return this.callPlay(token, playId);
        this.refusePlay(result, playId);
      },
      () => {
        if (token !== this.playToken || this.released || this.failed) return;
        this.refusePlay("not-allowed", playId);
      }
    );
  }

  pause(): void {
    if (this.released) return;
    this.wantPlay = false;
    this.owedPlaying = false;
    this.playToken += 1; // a pending play() rejection caused by this pause is expected, not reported
    this.disarm("start");
    this.disarm("stall");
    this.heldWatchdogs.clear();
    const el = this.element;
    this.observePaused();
    el.pause();
    this.observePaused();
    // The `pause` event ordinal that answers this call: the one this call caused,
    // or the latest one still queued. None owed: the element is settled, acknowledge now.
    const answeredBy = this.pauseTransitions();
    if (answeredBy > this.pauseEventsSeen) this.pendingAcks.set(answeredBy, (this.pendingAcks.get(answeredBy) ?? 0) + 1);
    else this.emitIfLive({ kind: "paused", positionMs: el.currentTime * 1000, atEnd: el.ended, requested: true });
  }

  seek(positionMs: number): void {
    if (this.released || this.failed) return;
    const target = Math.max(0, positionMs);
    this.observePaused();
    if (this.element.readyState >= HAVE_METADATA) this.startSeek(target);
    else this.pendingSeekMs = target; // answered after loadedmetadata applies it
  }

  /** The shared AudioContext started or stopped rendering. */
  setOutputRunning(running: boolean): void {
    if (this.released || this.failed || running === this.outputRunning) return;
    this.outputRunning = running;
    const el = this.element;
    if (!running) {
      for (const kind of ["start", "stall"] as const) {
        if (!this.watchdogs.has(kind)) continue;
        this.disarm(kind);
        this.heldWatchdogs.add(kind);
      }
      if (this.reportedPlaying) {
        this.reportedPlaying = false;
        this.owedPlaying = true;
        this.emitIfLive({ kind: "waiting", positionMs: el.currentTime * 1000 });
      }
      return;
    }
    const held = new Set(this.heldWatchdogs);
    this.heldWatchdogs.clear();
    if (held.has("start") && this.wantPlay) this.armStart();
    if (held.has("stall") && this.wantPlay && this.waiting) this.armStall();
    if (!this.owedPlaying) return;
    this.owedPlaying = false;
    // Only a channel that still wants to play and whose element was never paused meanwhile resumes.
    if (!this.wantPlay || el.paused || el.ended || this.waiting || el.readyState < HAVE_FUTURE_DATA || this.pauseOwed()) return;
    this.reportPlaying();
  }

  /** The shared output is gone for good: terminal for this load. */
  failOutput(error: ErrorInfo): void {
    this.fail(error);
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
    this.heldWatchdogs.clear();
    this.pendingAcks.clear(); // unloaded first: nothing is acknowledged any more
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
    return this.waiting || !this.outputRunning ? "waiting" : "playing";
  }

  private rate(): number {
    const el = this.element;
    if (this.released || this.failed || !this.outputRunning || el.paused || el.ended || this.waiting || el.readyState < HAVE_FUTURE_DATA) return 0;
    return el.playbackRate;
  }

  /**
   * Count a paused→playing transition made since the last observation (by
   * other code, its `play` event still queued). A playing→paused one needs no
   * bookkeeping: `pauseTransitions` reads it from element.paused directly.
   */
  private observePaused(): void {
    const paused = this.element.paused;
    if (this.lastKnownPaused && !paused) {
      this.unpauses += 1;
      this.playEventsAhead += 1;
    }
    this.lastKnownPaused = paused;
  }

  /** Paused→playing transitions so far, minus the current one if the element is playing now = pause transitions. */
  private pauseTransitions(): number {
    return this.unpauses - (this.element.paused ? 0 : 1);
  }

  /** A `pause` event is still queued: anything dispatched now was queued before it. */
  private pauseOwed(): boolean {
    return this.pauseTransitions() > this.pauseEventsSeen || this.pendingAcks.size > 0;
  }

  private refusePlay(result: Exclude<OutputReadiness, "running">, playId: PlayRequestId): void {
    if (result === "closed") return this.fail(OUTPUT_CLOSED);
    this.disarm("start");
    this.heldWatchdogs.delete("start");
    this.wantPlay = false;
    this.options.emit({ kind: "play-rejected", reason: "not-allowed", playId });
  }

  private callPlay(token: number, playId: PlayRequestId): void {
    const el = this.element;
    this.observePaused();
    let pending: Promise<void> | undefined;
    try {
      pending = el.play();
    } catch (error) {
      pending = Promise.reject(error);
    }
    // A play() refused up front (no user activation) leaves the element paused and queues nothing.
    this.observePaused();
    // play() resolving is not "playing": only the `playing` event is reported as such.
    pending?.catch((error: unknown) => {
      if (token !== this.playToken || this.released || this.failed) return;
      this.disarm("start");
      this.heldWatchdogs.delete("start");
      this.wantPlay = false;
      this.options.emit({ kind: "play-rejected", reason: rejectionOf(error), playId });
    });
  }

  private reportPlaying(): void {
    this.reportedPlaying = true;
    this.emitIfLive({ kind: "playing", positionMs: this.element.currentTime * 1000 });
  }

  private startSeek(targetMs: number): void {
    const el = this.element;
    this.seekUnanswered = true;
    el.currentTime = targetMs / 1000;
    // The seek algorithm sets `seeking` synchronously; if it is false the element
    // declined to seek (e.g. nothing seekable) and no `seeked` will ever answer.
    if (!el.seeking) {
      this.options.note?.("seek.not-started", { targetMs, positionMs: el.currentTime * 1000 });
      return this.answerSeek();
    }
    this.armSeekCheck();
  }

  private armSeekCheck(): void {
    this.arm("seek", this.options.timeouts.seekCheckMs, () => {
      if (!this.seekUnanswered) return;
      if (this.element.seeking) return this.armSeekCheck();
      this.options.note?.("seek.unanswered", { positionMs: this.element.currentTime * 1000 });
      this.answerSeek();
    });
  }

  private answerSeek(): void {
    this.seekUnanswered = false;
    this.disarm("seek");
    this.emitIfLive({ kind: "seeked", positionMs: this.element.currentTime * 1000 });
  }

  private armStart(): void {
    const token = this.playToken;
    const expire = () => {
      if (token === this.playToken) this.fail({ class: "retryable", code: "media_start_timeout" });
    };
    if (this.outputRunning) this.arm("start", this.options.timeouts.startMs, expire);
    else this.heldWatchdogs.add("start");
  }

  private armStall(): void {
    if (this.outputRunning) this.arm("stall", this.options.timeouts.stallMs, () => this.fail({ class: "retryable", code: "media_stall_timeout" }));
    else this.heldWatchdogs.add("stall");
  }

  private listen(): void {
    const el = this.element;
    const signal = this.listeners.signal;
    const on = (type: string, handler: () => void) =>
      el.addEventListener(
        type,
        () => {
          if (this.released) return;
          this.observePaused();
          handler();
        },
        { signal }
      );
    const position = () => el.currentTime * 1000;

    on("loadedmetadata", () => {
      const pending = this.pendingSeekMs;
      this.pendingSeekMs = null;
      if (pending !== null) this.startSeek(pending);
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
    on("play", () => {
      if (this.playEventsAhead > 0) this.playEventsAhead -= 1;
      else this.unpauses += 1; // unpaused and paused again by other code between two observations
    });
    on("playing", () => {
      if (this.pauseOwed()) {
        // Queued before a pause that has not been dispatched yet: it belongs to a superseded play.
        this.options.note?.("playing.superseded", { positionMs: position() });
        return;
      }
      this.waiting = false;
      this.everPlayed = true;
      this.disarm("start");
      this.disarm("stall");
      this.heldWatchdogs.clear();
      if (!this.outputRunning) {
        // The element started but nothing renders: not audible, and its clock will not advance.
        this.owedPlaying = true;
        this.reportedPlaying = false;
        this.emitIfLive({ kind: "waiting", positionMs: position() });
        return;
      }
      this.reportPlaying();
    });
    on("waiting", () => {
      if (this.pauseOwed()) return; // from before a queued pause, like `playing` above
      this.waiting = true;
      this.reportedPlaying = false;
      if (this.wantPlay) this.armStall();
      this.emitIfLive({ kind: "waiting", positionMs: position() });
    });
    on("stalled", () => this.emitIfLive({ kind: "stalled" }));
    on("pause", () => {
      const ordinal = ++this.pauseEventsSeen;
      let acks = 0;
      for (const [answeredBy, count] of this.pendingAcks) {
        if (answeredBy > ordinal) continue;
        acks += count;
        this.pendingAcks.delete(answeredBy);
      }
      if (acks === 0 && ordinal <= this.supersededThrough) {
        // Paused before a later play() was asked for (that play, or its refusal, is what counts now).
        this.options.note?.("pause.superseded", { positionMs: position(), ordinal });
        return;
      }
      this.waiting = false;
      this.reportedPlaying = false;
      this.owedPlaying = false;
      this.disarm("stall");
      this.heldWatchdogs.delete("stall");
      const observed = { kind: "paused", positionMs: position(), atEnd: el.ended } as const;
      if (acks === 0) return this.emitIfLive({ ...observed, requested: false });
      // One acknowledgement per pause() call this event answers.
      for (let i = 0; i < acks; i += 1) this.emitIfLive({ ...observed, requested: true });
    });
    on("seeked", () => {
      // Still seeking: a later seek superseded this one and its own `seeked` follows.
      if (el.seeking || !this.seekUnanswered) return;
      this.answerSeek();
    });
    on("ratechange", () => this.emitIfLive({ kind: "time", positionMs: position(), rate: this.rate() }));
    on("timeupdate", () => {
      const now = this.options.clock();
      if (now - this.lastTimeEmit < this.options.timeIntervalMs) return;
      this.lastTimeEmit = now;
      this.emitIfLive({ kind: "time", positionMs: position(), rate: this.rate() });
    });
    on("ended", () => {
      if (!el.ended) {
        // Queued at the end, dispatched after a seek/play moved the element off it: the old position's end.
        this.options.note?.("ended.obsolete", { positionMs: position(), seeking: el.seeking });
        return;
      }
      this.wantPlay = false;
      this.waiting = false;
      this.reportedPlaying = false;
      this.owedPlaying = false;
      this.disarm("start");
      this.disarm("stall");
      this.heldWatchdogs.clear();
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
    this.heldWatchdogs.clear();
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
