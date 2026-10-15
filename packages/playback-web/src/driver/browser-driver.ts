import type { CueId, DeckId, LoadId, MediaEvent, VoiceLoadId } from "@claudio/contracts";
import { hostTimers, performanceClock, silentLog, type LogPort, type RuntimeClock, type StreamUrlPort, type Timers } from "../ports.js";
import { MixerGraph } from "./audio-graph.js";
import { DEFAULT_MEDIA_TIMEOUTS, MediaSlot, type MediaTimeouts } from "./media-slot.js";
import type { ClockReading, DeckClock, DriverEffect, MediaFact, PlaybackDriver, SpectrumReader, VoiceClock } from "./types.js";

export interface BrowserDriverOptions {
  readonly urls: StreamUrlPort;
  readonly clock?: RuntimeClock;
  readonly timers?: Timers;
  readonly log?: LogPort;
  readonly timeouts?: Partial<MediaTimeouts>;
  /** Minimum spacing of `time` facts per channel; clocks are read live regardless. */
  readonly timeFactIntervalMs?: number;
  readonly createContext?: () => AudioContext;
  readonly createElement?: () => HTMLAudioElement;
  /** Document whose visibility triggers a clock resample; null disables. */
  readonly document?: Document | null;
  /** Test seam: a node inserted after master (e.g. a PCM meter worklet). Built with the driver's own context. */
  readonly outputTap?: (context: AudioContext) => AudioNode | Promise<AudioNode>;
  readonly safetyLimiter?: boolean;
}

interface DeckSlot {
  readonly deck: DeckId;
  readonly loadId: LoadId;
  readonly slot: MediaSlot;
}

interface VoiceSlot {
  readonly cueId: CueId;
  readonly voiceLoadId: VoiceLoadId;
  readonly slot: MediaSlot;
}

/** Diagnostic, read-only view for tests and debug overlays. */
export interface DriverDiagnostics {
  readonly contextState: AudioContextState | "closed";
  readonly sampleRate: number;
  readonly liveElements: number;
  readonly createdElements: number;
  readonly releasedElements: number;
  readonly deckGains: { readonly A: number; readonly B: number };
  readonly disposed: boolean;
}

export interface BrowserDriver extends PlaybackDriver {
  diagnostics(): DriverDiagnostics;
}

/**
 * The only code that touches HTMLAudioElement, MediaElementAudioSourceNode
 * and gain nodes. One AudioContext, two music decks and one voice channel; at
 * most three live elements at any time. It executes core effects and reports
 * observations; it never decides what plays next.
 */
export async function createBrowserDriver(options: BrowserDriverOptions): Promise<BrowserDriver> {
  const context = options.createContext?.() ?? new AudioContext({ latencyHint: "playback" });
  let tap: AudioNode | null = null;
  try {
    tap = options.outputTap ? await options.outputTap(context) : null;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
  return new Driver(options, new MixerGraph(context, { tap, safetyLimiter: options.safetyLimiter }));
}

class Driver implements BrowserDriver {
  private sink: ((fact: MediaFact) => void) | null = null;
  private readonly decks: { A: DeckSlot | null; B: DeckSlot | null } = { A: null, B: null };
  private voice: VoiceSlot | null = null;
  private readonly clock: RuntimeClock;
  private readonly timers: Timers;
  private readonly log: LogPort;
  private readonly timeouts: MediaTimeouts;
  private readonly visibilityListener = new AbortController();
  private disposed = false;
  private disposing: Promise<void> | null = null;
  private created = 0;
  private releasedCount = 0;
  private unlockWait: Promise<boolean> | null = null;
  private abandonUnlock: (() => void) | null = null;

  readonly spectrum: SpectrumReader;

  constructor(
    private readonly options: BrowserDriverOptions,
    private readonly graph: MixerGraph
  ) {
    this.clock = options.clock ?? performanceClock;
    this.timers = options.timers ?? hostTimers;
    this.log = options.log ?? silentLog;
    this.timeouts = { ...DEFAULT_MEDIA_TIMEOUTS, ...options.timeouts };
    this.spectrum = Object.freeze({
      readMusic: (target: Uint8Array) => (this.disposed ? 0 : graph.readMusic(target)),
      readVoice: (target: Uint8Array) => (this.disposed ? 0 : graph.readVoice(target)),
      voiceLevel: () => (this.disposed ? 0 : graph.voiceLevel())
    });
    const doc = options.document === undefined ? (typeof document === "undefined" ? null : document) : options.document;
    doc?.addEventListener(
      "visibilitychange",
      () => {
        // Timers and timeupdate may have been throttled while hidden: re-anchor clocks from the elements.
        if (doc.visibilityState !== "visible" || this.disposed) return;
        this.log({ level: "debug", event: "driver.resample", at: this.clock(), data: { reason: "visible" } });
        this.decks.A?.slot.resample();
        this.decks.B?.slot.resample();
        this.voice?.slot.resample();
      },
      { signal: this.visibilityListener.signal }
    );
  }

  connect(sink: (fact: MediaFact) => void): void {
    this.sink = sink;
  }

  execute(effect: DriverEffect): void {
    if (this.disposed) return;
    switch (effect.type) {
      case "deck.load":
        return this.loadDeck(effect.deck, effect.loadId, this.options.urls.music(effect.media.stream.handle), effect.startAtMs);
      case "deck.play":
        return this.deckSlot(effect.deck, effect.loadId)?.play();
      case "deck.pause": {
        const current = this.deckSlot(effect.deck, effect.loadId);
        if (!current) return;
        current.pause();
        // Contract: pausing a deck cancels its pending gain automation; the core re-issues gains after resume.
        this.graph.holdDeckGain(effect.deck);
        return;
      }
      case "deck.seek":
        return this.deckSlot(effect.deck, effect.loadId)?.seek(effect.positionMs);
      case "deck.gain":
        if (!this.deckSlot(effect.deck, effect.loadId)) return;
        return this.graph.setDeckGain(effect.deck, effect.gain, effect.rampMs);
      case "deck.unload": {
        if (!this.deckSlot(effect.deck, effect.loadId)) return;
        this.releaseDeck(effect.deck);
        return;
      }
      case "voice.load":
        return this.loadVoice(effect.cueId, effect.voiceLoadId, effect.asset.voice.stream.handle, effect.asset.voice.playbackRate);
      case "voice.play":
        return this.voiceSlot(effect.cueId, effect.voiceLoadId)?.play();
      case "voice.pause":
        return this.voiceSlot(effect.cueId, effect.voiceLoadId)?.pause();
      case "voice.stop":
        if (!this.voiceSlot(effect.cueId, effect.voiceLoadId)) return;
        return this.releaseVoice();
      case "output.volume":
        this.graph.setMusicVolume(effect.music);
        this.graph.setVoiceVolume(effect.voice);
        this.graph.setMuted(effect.muted);
        return;
    }
  }

  readClock(): ClockReading {
    const deckClock = (entry: DeckSlot | null): DeckClock | null =>
      entry ? Object.freeze({ deck: entry.deck, loadId: entry.loadId, ...entry.slot.readClock() }) : null;
    const voice = this.voice;
    const voiceClock: VoiceClock | null = voice ? Object.freeze({ cueId: voice.cueId, voiceLoadId: voice.voiceLoadId, ...voice.slot.readClock() }) : null;
    return Object.freeze({
      at: this.clock(),
      source: "media-element" as const,
      decks: Object.freeze({ A: deckClock(this.decks.A), B: deckClock(this.decks.B) }),
      voice: voiceClock
    });
  }

  unlock(): void {
    if (this.disposed) return;
    const ctx = this.graph.context;
    if (ctx.state !== "running") ctx.resume().catch((error: unknown) => this.log({ level: "warn", event: "driver.unlock-failed", at: this.clock(), data: String(error) }));
  }

  diagnostics(): DriverDiagnostics {
    const live = (this.decks.A ? 1 : 0) + (this.decks.B ? 1 : 0) + (this.voice ? 1 : 0);
    return Object.freeze({
      contextState: this.graph.context.state,
      sampleRate: this.graph.context.sampleRate,
      liveElements: live,
      createdElements: this.created,
      releasedElements: this.releasedCount,
      deckGains: Object.freeze({ A: this.graph.deckGain("A"), B: this.graph.deckGain("B") }),
      disposed: this.disposed
    });
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.visibilityListener.abort();
    this.releaseDeck("A");
    this.releaseDeck("B");
    this.releaseVoice();
    this.sink = null;
    this.abandonUnlock?.();
    this.disposing = this.graph.close();
    return this.disposing;
  }

  // ------------------------------------------------------------------ internals

  private deckSlot(deck: DeckId, loadId: LoadId): MediaSlot | null {
    const entry = this.decks[deck];
    if (entry && entry.loadId === loadId) return entry.slot;
    this.log({ level: "debug", event: "driver.stale-effect", at: this.clock(), data: { deck, loadId, current: entry?.loadId ?? null } });
    return null;
  }

  private voiceSlot(cueId: CueId, voiceLoadId: VoiceLoadId): MediaSlot | null {
    const entry = this.voice;
    if (entry && entry.cueId === cueId && entry.voiceLoadId === voiceLoadId) return entry.slot;
    this.log({ level: "debug", event: "driver.stale-effect", at: this.clock(), data: { cueId, voiceLoadId } });
    return null;
  }

  private loadDeck(deck: DeckId, loadId: LoadId, spec: { url: string; crossOrigin: "anonymous" | "use-credentials" | null }, startAtMs: number): void {
    this.releaseDeck(deck);
    this.graph.holdDeckGain(deck);
    const emit = (event: MediaEvent) => this.sink?.({ type: "deck.media", deck, loadId, event });
    const slot = this.newSlot(this.graph.deckInput(deck), spec, startAtMs, 1, emit);
    this.decks[deck] = { deck, loadId, slot };
  }

  private loadVoice(cueId: CueId, voiceLoadId: VoiceLoadId, handle: Parameters<StreamUrlPort["voice"]>[0], playbackRate: number): void {
    this.releaseVoice();
    const emit = (event: MediaEvent) => this.sink?.({ type: "voice.media", cueId, voiceLoadId, event });
    const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
    const slot = this.newSlot(this.graph.voiceInput(), this.options.urls.voice(handle), 0, rate, emit);
    this.voice = { cueId, voiceLoadId, slot };
  }

  private newSlot(
    input: AudioNode,
    spec: { url: string; crossOrigin: "anonymous" | "use-credentials" | null },
    startAtMs: number,
    playbackRate: number,
    emit: (event: MediaEvent) => void
  ): MediaSlot {
    const element = this.options.createElement?.() ?? new Audio();
    this.created += 1;
    return new MediaSlot({
      element,
      context: this.graph.context,
      input,
      url: spec.url,
      crossOrigin: spec.crossOrigin,
      startAtMs,
      playbackRate,
      emit,
      timers: this.timers,
      timeouts: this.timeouts,
      clock: this.clock,
      timeIntervalMs: this.options.timeFactIntervalMs ?? 1000,
      ensureRunning: () => this.ensureRunning()
    });
  }

  private releaseDeck(deck: DeckId): void {
    const entry = this.decks[deck];
    if (!entry) return;
    this.decks[deck] = null;
    entry.slot.release();
    this.releasedCount += 1;
    this.graph.holdDeckGain(deck);
  }

  private releaseVoice(): void {
    const entry = this.voice;
    if (!entry) return;
    this.voice = null;
    entry.slot.release();
    this.releasedCount += 1;
  }

  /** `true` synchronously when running; otherwise a bounded wait for resume(). */
  private ensureRunning(): Promise<boolean> | true {
    const ctx = this.graph.context;
    if (ctx.state === "running") return true;
    if (this.unlockWait) return this.unlockWait;
    const wait = new Promise<boolean>((resolve) => {
      let done = false;
      let timer: unknown = null;
      const finish = (running: boolean) => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        this.unlockWait = null;
        this.abandonUnlock = null;
        resolve(running);
      };
      this.abandonUnlock = () => finish(false);
      timer = this.timers.setTimeout(() => finish(ctx.state === "running"), this.timeouts.unlockMs);
      ctx.resume().then(
        () => finish(ctx.state === "running"),
        () => finish(false)
      );
    });
    this.unlockWait = wait;
    return wait;
  }
}
