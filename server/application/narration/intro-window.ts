/**
 * How much of a DJ voice may overlap the next track's intro — a planning
 * helper only. Nothing in prepare/narration or the playback core calls it
 * yet, so it does not make any transition talk over an intro today.
 *
 * Two different inputs are kept apart on purpose:
 *  - `lyricOnsetHintMs`: the first sung line of source-timed lyrics. The plan
 *    does not treat this as a trusted vocal entry (synced lyrics can be
 *    offset from the recording); it is a hint for whoever verifies a window.
 *  - `TrustedIntroWindow`: a vocal entry someone set by hand or verified
 *    against this exact recording. Only this may produce an overlap budget;
 *    without it the answer is "unavailable" (sequential talk, talk over the
 *    crossfade, or no talk).
 *
 * Adapted (rewritten in TypeScript) from:
 *  - Music Assistant `providers/ai_radio/post_window.py` (is_sung / lyric_onset)
 *    and `rendering.py` + `constants.py` (overlap = min(W − ramp, B − head),
 *    minimum overlap), Apache-2.0, commit ee26f6cc29ec904b9608de35c4b9c078b23df94a.
 *  - SUB/WAVE `controller/src/broadcast/vocal-runway.ts` (measured vocal onset
 *    below a floor refuses talk-over; unknown stays unknown), MIT,
 *    commit b5d1c4c159d5146239a9a933d36397a681fd1039.
 * See server/THIRD_PARTY_NOTICES.md. Changes: Chinese credit/section lines,
 * contract LyricsAsset input for the hint, the overlap budget requires an
 * explicitly trusted window (a lyric line alone never qualifies), explicit
 * "unavailable" reasons, no words-per-second estimate — only a measured
 * voice duration is accepted.
 */
import type { LyricsAsset, SourceRevision } from "@claudio/contracts";

/** Music back at full level this long before the vocal (MA VOICE_OVER_RAMP 0.4 s). */
export const VOICE_OVER_RAMP_MS = 400;
/** Shortest overlap worth doing (MA POST_MIN_SECONDS 1.5 s). */
export const MIN_OVERLAP_MS = 1500;
/** The voice keeps at least this much before the record comes in (MA POST_MIN_HEAD_SECONDS 1 s). */
export const MIN_VOICE_HEAD_MS = 1000;
/** A trusted vocal entry earlier than this refuses talk-over entirely (SUB/WAVE floor 2.5 s). */
export const VOCAL_RUNWAY_FLOOR_MS = 2500;

const SECTION_MARKERS = new Set([
  "intro", "introduction", "verse", "pre-chorus", "prechorus", "pre chorus", "chorus", "refrain", "bridge",
  "outro", "instrumental", "instrumental break", "solo", "guitar solo", "drum solo", "interlude", "hook",
  "break", "breakdown", "music", "musical interlude", "silence", "no vocals",
  "前奏", "间奏", "尾奏", "主歌", "副歌", "桥段", "纯音乐", "伴奏", "音乐", "独白"
]);

// Credit rows common at the top of Chinese LRC/KRC files ("作词 : 某某").
const CREDIT_LINE =
  /^(作词|作曲|编曲|填词|词|曲|原唱|翻唱|制作人|制作|监制|混音|缩混|母带|和声|和音|录音|吉他|贝斯|鼓|键盘|弦乐|配唱|出品|发行|企划|统筹|op|sp|lyrics?|lyricist|composer|composed|music|arranged|arranger|producer|produced|mixed|mastered|vocals?)(\s*by)?\s*[:：]/i;

const SYMBOL_ONLY = /^[\s♩-♯*~\-_.·•…]+$/u;
const MARKER_INDEX = /\s*[0-9ivxIVX]+\s*$/;

/** True when a lyric line represents someone singing (unknown bracketed text counts as sung). */
export function isSungLine(text: string): boolean {
  const stripped = text.trim();
  if (!stripped || SYMBOL_ONLY.test(stripped)) return false;
  if (CREDIT_LINE.test(stripped)) return false;
  let inner = stripped;
  if ((inner.startsWith("[") && inner.endsWith("]")) || (inner.startsWith("(") && inner.endsWith(")")) || (inner.startsWith("（") && inner.endsWith("）"))) {
    inner = inner.slice(1, -1);
  }
  const candidate = inner.trim().toLowerCase().replace(MARKER_INDEX, "").trim().replace(/^[\s:\-]+|[\s:\-]+$/g, "");
  return !SECTION_MARKERS.has(candidate);
}

/**
 * Media time (ms) of the first sung line in source-timed lyrics. A hint
 * only: synced lyrics may be offset from the recording, so this is not a
 * vocal onset and never enables an overlap by itself. Plain or estimated
 * timelines yield null.
 */
export function lyricOnsetHintMs(asset: LyricsAsset): number | null {
  if (asset.timing !== "native-line" && asset.timing !== "native-word") return null;
  const first = asset.lines
    .filter((line) => typeof line.startMs === "number" && isSungLine(line.text))
    .reduce<number | null>((earliest, line) => (earliest === null || line.startMs! < earliest ? line.startMs! : earliest), null);
  return first === null ? null : Math.max(0, first + asset.offsetMs);
}

/**
 * A vocal entry that may be relied on for one exact recording revision:
 * set by hand ("manual") or checked against the audio ("verified").
 */
export interface TrustedIntroWindow {
  readonly sourceRevision: SourceRevision;
  readonly vocalOnsetMs: number;
  readonly evidence: "manual" | "verified";
}

export type IntroOverlap =
  | {
      readonly kind: "overlap";
      /** Last `overlapMs` of the voice play over the next track's intro. */
      readonly overlapMs: number;
      /** Voice starts this long before the next track starts. */
      readonly leadMs: number;
      readonly vocalOnsetMs: number;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "no-trusted-intro-window" | "voice-duration-unknown" | "vocals-too-early" | "voice-too-short";
    };

/**
 * Decides talk-over-intro for one cue. `window` must be explicit trusted
 * evidence for the revision about to play (a lyric hint is not accepted);
 * `spokenMs` must be a measured voice length at its real playback rate
 * (contract `spokenDurationMs`). Missing either is "unavailable".
 */
export function planIntroOverlap(input: {
  readonly sourceRevision: SourceRevision;
  readonly window: TrustedIntroWindow | null;
  readonly spokenMs: number | null;
}): IntroOverlap {
  const window = input.window;
  if (!window || window.sourceRevision !== input.sourceRevision || (window.evidence !== "manual" && window.evidence !== "verified")) {
    return { kind: "unavailable", reason: "no-trusted-intro-window" };
  }
  const onset = window.vocalOnsetMs;
  if (!Number.isFinite(onset) || onset < VOCAL_RUNWAY_FLOOR_MS) return { kind: "unavailable", reason: "vocals-too-early" };
  if (input.spokenMs === null || !Number.isFinite(input.spokenMs)) return { kind: "unavailable", reason: "voice-duration-unknown" };
  const room = onset - VOICE_OVER_RAMP_MS;
  if (room < MIN_OVERLAP_MS) return { kind: "unavailable", reason: "vocals-too-early" };
  const overlapMs = Math.min(room, input.spokenMs - MIN_VOICE_HEAD_MS);
  if (overlapMs < MIN_OVERLAP_MS) return { kind: "unavailable", reason: "voice-too-short" };
  return { kind: "overlap", overlapMs, leadMs: input.spokenMs - overlapMs, vocalOnsetMs: onset };
}
