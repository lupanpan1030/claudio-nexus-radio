import type { CueId, DeckId, LoadId, MediaEvent, PlaybackEffect, PlaybackFact, VoiceLoadId } from "@claudio/contracts";

/** Effects executed by the media owner; everything else is runtime work. */
export type DriverEffect = Extract<PlaybackEffect, { type: `deck.${string}` | `voice.${string}` | "output.volume" }>;

export type MediaFact = Extract<PlaybackFact, { type: "deck.media" | "voice.media" }>;

export function isDriverEffect(effect: PlaybackEffect): effect is DriverEffect {
  return effect.type.startsWith("deck.") || effect.type.startsWith("voice.") || effect.type === "output.volume";
}

/**
 * `paused` as observed on the element (contract MediaEvent):
 *  - atEnd: `element.ended` read in the handler (HTML fires `pause` right before `ended`);
 *  - requested: this event answers one of the driver's own pause() calls for a
 *    deck.pause/voice.pause effect (counted only when the element was not
 *    already paused, one consumed per event); false = OS/platform/other agent.
 */
export type PausedObservation = Extract<MediaEvent, { kind: "paused" }>;

/** Live clock of one channel, read from the media element when asked. */
export interface ChannelClock {
  readonly positionMs: number;
  /** 0 while paused, waiting, ended, not yet playing, or while the audio output is not running. */
  readonly rate: number;
  /** Runtime clock ms at which `positionMs` was observed (for snapshot clocks: when the executor observed it). */
  readonly observedAt: number;
  readonly state: "loading" | "playing" | "waiting" | "paused" | "ended" | "failed";
}

export interface DeckClock extends ChannelClock {
  readonly deck: DeckId;
  readonly loadId: LoadId;
}

export interface VoiceClock extends ChannelClock {
  readonly cueId: CueId;
  readonly voiceLoadId: VoiceLoadId;
}

/**
 * Read-only clock view handed to subtitles/stage. Carries identities, never elements.
 *  media-element: sampled from the executor's elements at `at` (observedAt = at);
 *  snapshot:      an observer's copy of the executor's last broadcast samples,
 *                 each with its original observedAt; extrapolate with a bound
 *                 (projectClock) instead of treating it as a fresh reading.
 */
export interface ClockReading {
  readonly at: number;
  readonly source: "media-element" | "snapshot";
  readonly decks: { readonly A: DeckClock | null; readonly B: DeckClock | null };
  readonly voice: VoiceClock | null;
}

export interface ClockReader {
  read(): ClockReading;
}

/** Copy-out spectrum access; no AnalyserNode or AudioContext escapes the driver. */
export interface SpectrumReader {
  /** Writes byte frequency data into `target`; returns the number of bins written (0 when unavailable). */
  readMusic(target: Uint8Array): number;
  readVoice(target: Uint8Array): number;
  /** 0..1 RMS-ish level of the voice bus. */
  voiceLevel(): number;
}

export const SILENT_SPECTRUM: SpectrumReader = Object.freeze({
  readMusic: () => 0,
  readVoice: () => 0,
  voiceLevel: () => 0
});

/**
 * The single owner of audible media. Executes driver effects synchronously
 * (never awaiting the network) and reports element observations as facts
 * carrying the deck/load or cue/voice-load identity they belong to.
 */
export interface PlaybackDriver {
  /** Called once by the runtime before any effect. */
  connect(sink: (fact: MediaFact) => void): void;
  execute(effect: DriverEffect): void;
  readClock(): ClockReading;
  readonly spectrum: SpectrumReader;
  /** Call inside a user gesture handler so the audio output may start. */
  unlock(): void;
  /** Releases elements, nodes, listeners and timers. Idempotent. */
  dispose(): Promise<void>;
}
