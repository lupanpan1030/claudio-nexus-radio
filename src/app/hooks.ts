import { useEffect, useState } from "react";
import type { HostView } from "@claudio/playback-web";
import type { ClockReader } from "@claudio/playback-web";
import { pageClock, positionAt, programMusicSample, voiceSample, displayedMusicSample } from "../playback/clock";

/**
 * Re-renders a small subtree on a fixed cadence while `active`; the rest of
 * the app re-renders only on snapshot changes, never per media frame.
 */
export function useTicker(active: boolean, intervalMs = 250): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return tick;
}

/** Program music position (ms) for progress bars: live on the owner, honest snapshot extrapolation on observers. */
export function useProgramPosition(view: HostView, live: ClockReader | null): number | null {
  const playing = view.snapshot?.transport === "playing";
  useTicker(playing, 250);
  const sample = programMusicSample(view.snapshot, live);
  return sample ? positionAt(sample, pageClock()) : null;
}

/** Position of the music the display follows (lyrics). */
export function useDisplayedPosition(view: HostView, live: ClockReader | null, active: boolean): number | null {
  useTicker(active && view.snapshot?.transport === "playing", 200);
  const sample = displayedMusicSample(view.snapshot, live);
  return sample ? positionAt(sample, pageClock()) : null;
}

/** Voice position (ms) for DJ subtitles; never the song's position. */
export function useVoicePosition(view: HostView, live: ClockReader | null, active: boolean): number | null {
  const speaking = view.snapshot?.voice?.status === "speaking";
  useTicker(active && speaking, 150);
  const sample = voiceSample(view.snapshot, live);
  return sample ? positionAt(sample, pageClock()) : null;
}
