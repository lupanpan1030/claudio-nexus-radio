import type { LoadId, MediaClockSample, PlaybackSnapshot, VoiceLoadId } from "@claudio/contracts";
import type { ClockReader } from "@claudio/playback-web";

/** Same convention as the runtime clock: epoch-aligned monotonic ms. */
export const pageClock = (): number => performance.timeOrigin + performance.now();

/** Beyond this, a sample is too old to extrapolate; the position freezes (honest staleness). */
export const MAX_EXTRAPOLATION_MS = 1500;

export interface ChannelSample extends MediaClockSample {
  /** Where the sample came from: the live element (owner) or a broadcast snapshot (observer). */
  readonly source: "media-element" | "snapshot";
}

export interface MusicSample extends ChannelSample {
  readonly loadId: LoadId;
}

export interface VoiceSample extends ChannelSample {
  readonly voiceLoadId: VoiceLoadId;
}

/**
 * Clock of the music the display follows. The owner reads its element live;
 * an observer uses the executor's broadcast sample with its original
 * observedAt, so staleness stays visible instead of being re-stamped as fresh.
 */
export function displayedMusicSample(snapshot: PlaybackSnapshot | null, live: ClockReader | null): MusicSample | null {
  const display = snapshot?.display;
  if (!snapshot || !display || display.kind !== "music" || !display.deck || !display.loadId) return null;
  const deck = snapshot.decks[display.deck];
  if (deck.loadId !== display.loadId) return null;
  if (live) {
    const reading = live.read();
    const clock = reading.source === "media-element" ? reading.decks[display.deck] : null;
    if (clock && clock.loadId === display.loadId) {
      return { loadId: clock.loadId, positionMs: clock.positionMs, observedAt: clock.observedAt, rate: clock.rate, source: "media-element" };
    }
  }
  return deck.clock ? { loadId: display.loadId, ...deck.clock, source: "snapshot" } : null;
}

/** Program music clock regardless of what the display shows (progress bar while the DJ talks over it). */
export function programMusicSample(snapshot: PlaybackSnapshot | null, live: ClockReader | null): MusicSample | null {
  const program = snapshot?.program;
  if (!snapshot || !program?.deck || !program.loadId) return null;
  const deck = snapshot.decks[program.deck];
  if (deck.loadId !== program.loadId) return null;
  if (live) {
    const reading = live.read();
    const clock = reading.source === "media-element" ? reading.decks[program.deck] : null;
    if (clock && clock.loadId === program.loadId) {
      return { loadId: clock.loadId, positionMs: clock.positionMs, observedAt: clock.observedAt, rate: clock.rate, source: "media-element" };
    }
  }
  return deck.clock ? { loadId: program.loadId, ...deck.clock, source: "snapshot" } : null;
}

export function voiceSample(snapshot: PlaybackSnapshot | null, live: ClockReader | null): VoiceSample | null {
  const voice = snapshot?.voice;
  if (!voice?.voiceLoadId) return null;
  if (live) {
    const reading = live.read();
    const clock = reading.source === "media-element" ? reading.voice : null;
    if (clock && clock.voiceLoadId === voice.voiceLoadId && clock.cueId === voice.cueId) {
      return { voiceLoadId: clock.voiceLoadId, positionMs: clock.positionMs, observedAt: clock.observedAt, rate: clock.rate, source: "media-element" };
    }
  }
  return voice.clock ? { voiceLoadId: voice.voiceLoadId, ...voice.clock, source: "snapshot" } : null;
}

/** Position at `now`, extrapolating at most MAX_EXTRAPOLATION_MS past the sample. */
export function positionAt(sample: MediaClockSample, now: number, maxExtrapolationMs = MAX_EXTRAPOLATION_MS): number {
  const elapsed = Math.min(Math.max(0, now - sample.observedAt), maxExtrapolationMs);
  return sample.positionMs + elapsed * Math.max(0, sample.rate);
}
