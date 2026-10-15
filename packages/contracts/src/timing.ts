import { literal, number, object, tagged, type Decoder } from "./validation.js";

/**
 * Where a text timeline came from. Consumers must not upgrade a weaker
 * provenance (e.g. render "estimated" as if it were word-accurate).
 */
export type TimingProvenance = "native-word" | "native-line" | "estimated" | "plain-text";

export const timingProvenanceDecoder = literal("native-word", "native-line", "estimated", "plain-text");

/**
 * Shared interval rule for lyric lines and subtitle segments: timed tracks
 * need `startMs`, plain text carries no times, and end never precedes start.
 */
export function checkInterval(
  span: { readonly startMs?: number; readonly endMs?: number },
  at: string,
  timed: boolean,
  report: (subPath: string, message: string) => void
): void {
  if (!timed) {
    if (span.startMs !== undefined || span.endMs !== undefined) report(at, "plain-text timing carries no start/end times");
    return;
  }
  if (span.startMs === undefined) return report(`${at}.startMs`, "timed track requires startMs");
  if (span.endMs !== undefined && span.endMs < span.startMs) report(`${at}.endMs`, "endMs before startMs");
}

/** How a duration was obtained. */
export type DurationSource = "provider-metadata" | "container-metadata" | "decoded" | "media-element";

/**
 * Durations may be unknown. Unknown must stay unknown: budgets that need a
 * length (e.g. overlapping voice on an intro) are simply not available.
 */
export type DurationInfo =
  | { readonly kind: "known"; readonly ms: number; readonly source: DurationSource }
  | { readonly kind: "unknown" };

export const UNKNOWN_DURATION: DurationInfo = Object.freeze({ kind: "unknown" });

export const durationInfoDecoder: Decoder<DurationInfo> = tagged<DurationInfo, "kind">("kind", {
  known: object<Extract<DurationInfo, { kind: "known" }>>({
    kind: literal("known"),
    ms: number({ min: 0, max: 24 * 3600_000 }),
    source: literal("provider-metadata", "container-metadata", "decoded", "media-element")
  }),
  unknown: object<Extract<DurationInfo, { kind: "unknown" }>>({ kind: literal("unknown") })
});

export function knownDurationMs(duration: DurationInfo): number | null {
  return duration.kind === "known" ? duration.ms : null;
}

/**
 * A media clock observation: at monotonic time `observedAt` the element was
 * at `positionMs` advancing at `rate` (0 while paused/waiting). Consumers
 * extrapolate between samples; they never invent a position without one.
 */
export interface MediaClockSample {
  readonly positionMs: number;
  readonly observedAt: number;
  readonly rate: number;
}

export function extrapolatePosition(sample: MediaClockSample, now: number): number {
  return sample.positionMs + Math.max(0, now - sample.observedAt) * sample.rate;
}
