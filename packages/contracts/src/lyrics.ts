import type { AssetId, RecordingId, SourceRevision } from "./ids.js";
import { checkInterval, timingProvenanceDecoder, type TimingProvenance } from "./timing.js";
import { array, id, literal, number, object, optional, refine, string, tagged, type Decoder } from "./validation.js";

export interface LyricWord {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface LyricLine {
  /** Absent for plain-text lyrics. */
  readonly startMs?: number;
  readonly endMs?: number;
  readonly text: string;
  /** Only present when timing is "native-word". */
  readonly words?: readonly LyricWord[];
}

/**
 * Lyrics bound to the exact resolved recording. A different sourceRevision
 * means this asset must not be displayed, even for a same-titled track.
 */
export interface LyricsAsset {
  readonly assetId: AssetId;
  readonly recordingId: RecordingId;
  readonly sourceRevision: SourceRevision;
  readonly timing: TimingProvenance;
  /** Positive values delay the lyrics relative to media time. */
  readonly offsetMs: number;
  readonly lines: readonly LyricLine[];
}

export type LyricsAvailability =
  | { readonly status: "available"; readonly asset: LyricsAsset }
  | { readonly status: "missing"; readonly reason: "not-found" | "instrumental" | "unsupported" }
  /** Lyrics exist but cannot be proven to match this recording. */
  | { readonly status: "unmatched" };

/**
 * True unless the result carries an asset bound to another recording or
 * revision than the one requested. A same-revision asset of a different
 * recording is still a mismatch: the revision alone is not the identity.
 */
export function lyricsResultMatches(
  result: LyricsAvailability,
  expected: { readonly recordingId: RecordingId; readonly sourceRevision: SourceRevision }
): boolean {
  if (result.status !== "available") return true;
  return result.asset.recordingId === expected.recordingId && result.asset.sourceRevision === expected.sourceRevision;
}

const lyricWordDecoder =object<LyricWord>({
  startMs: number({ min: 0 }),
  endMs: number({ min: 0 }),
  text: string({ max: 200 })
});

const lyricLineDecoder = object<LyricLine>({
  startMs: optional(number({ min: 0 })),
  endMs: optional(number({ min: 0 })),
  text: string({ max: 2000 }),
  words: optional(array(lyricWordDecoder, { max: 500 }))
});

/**
 * Timing rules that follow from the asset alone:
 *  - plain-text: no line times, no words;
 *  - native-line/estimated/native-word: every line has `startMs`, lines are
 *    ordered by start (overlap is allowed: duets), `endMs` is optional;
 *  - words only under native-word, ordered, each with end >= start;
 *  - any present interval has end >= start.
 * Not checked: whether words sit inside their line (LRC word tags may lead
 * the line tag) or whether native timing is truthful; that is the producer's
 * provenance claim.
 */
export const lyricsAssetDecoder: Decoder<LyricsAsset> = refine(
  object<LyricsAsset>({
    assetId: id<AssetId>(),
    recordingId: id<RecordingId>(),
    sourceRevision: id<SourceRevision>(),
    timing: timingProvenanceDecoder,
    offsetMs: number({ min: -600_000, max: 600_000 }),
    lines: array(lyricLineDecoder, { max: 5000 })
  }),
  (asset, report) => {
    const timed = asset.timing !== "plain-text";
    let previousStart = -Infinity;
    asset.lines.forEach((line, index) => {
      const at = `.lines[${index}]`;
      checkInterval(line, at, timed, report);
      if (line.startMs !== undefined) {
        if (line.startMs < previousStart) report(`${at}.startMs`, "lines must be ordered by startMs");
        previousStart = line.startMs;
      }
      if (line.words === undefined) return;
      if (asset.timing !== "native-word") return report(`${at}.words`, `words are only allowed with native-word timing, not ${asset.timing}`);
      let previousWord = -Infinity;
      line.words.forEach((word, wordIndex) => {
        const wordAt = `${at}.words[${wordIndex}]`;
        if (word.endMs < word.startMs) report(`${wordAt}.endMs`, "endMs before startMs");
        if (word.startMs < previousWord) report(`${wordAt}.startMs`, "words must be ordered by startMs");
        previousWord = word.startMs;
      });
    });
  }
);

export const lyricsAvailabilityDecoder: Decoder<LyricsAvailability> = tagged<LyricsAvailability, "status">("status", {
  available: object({ status: literal("available"), asset: lyricsAssetDecoder }),
  missing: object({ status: literal("missing"), reason: literal("not-found", "instrumental", "unsupported") }),
  unmatched: object({ status: literal("unmatched") })
});
