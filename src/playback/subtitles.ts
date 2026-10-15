import type { LyricsAsset, LyricsView, SubtitleTrack, TimingProvenance } from "@claudio/contracts";

/**
 * Index of the lyric line at media position `positionMs`, or -1. Positive
 * offsetMs delays lyrics: a line timed at T is current from T + offset.
 * Plain-text lyrics have no current line.
 */
export function activeLyricIndex(asset: LyricsAsset, positionMs: number): number {
  if (asset.timing === "plain-text") return -1;
  const lyricTime = positionMs - asset.offsetMs;
  let active = -1;
  for (let index = 0; index < asset.lines.length; index += 1) {
    const start = asset.lines[index]?.startMs;
    if (start === undefined || start > lyricTime) break;
    active = index;
  }
  return active;
}

/**
 * Index of the DJ subtitle segment at voice position `positionMs` (voice
 * media clock, rate 1 — the unit of both native and estimated segments), or
 * -1. Plain text has no current segment: the whole script is shown instead.
 * Estimated segments do have one, and every view labels them as estimates.
 */
export function activeSegmentIndex(track: SubtitleTrack | null, positionMs: number): number {
  if (!track || track.timing === "plain-text") return -1;
  let active = -1;
  for (let index = 0; index < track.segments.length; index += 1) {
    const start = track.segments[index]?.startMs;
    if (start === undefined || start > positionMs) break;
    active = index;
  }
  return active;
}

/** The whole DJ script as one string (the plain-text fallback). */
export function scriptText(track: SubtitleTrack | null, text: string | null): string {
  return (text ?? track?.segments.map((segment) => segment.text).join("") ?? "").trim();
}

/** Lines to show for a DJ script: timed segments, else the full text split at sentence ends (display only). */
export function subtitleLines(track: SubtitleTrack | null, text: string | null): readonly string[] {
  if (track && track.segments.length > 0 && track.timing !== "plain-text") return track.segments.map((segment) => segment.text);
  const source = scriptText(track, text);
  if (!source) return [];
  return source
    .replace(/([。！？!?])\s*/g, "$1\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export const PROVENANCE_LABEL: Readonly<Record<TimingProvenance, string>> = Object.freeze({
  "native-word": "逐字对时",
  "native-line": "逐行对时",
  estimated: "时间为估算",
  "plain-text": "未对时"
});

/** Honest Chinese status for a lyrics view that has no lines to show. */
export function lyricsStatusText(view: LyricsView | null): string {
  if (!view) return "";
  switch (view.status) {
    case "none":
      return "";
    case "loading":
      return "正在查找歌词…";
    case "missing":
      return view.reason === "instrumental" ? "纯音乐，没有歌词" : view.reason === "unsupported" ? "当前音源不提供歌词" : "没有找到这首歌的歌词";
    case "unmatched":
      return "找到的歌词和正在播放的录音版本对不上，暂不显示";
    case "failed":
      return "歌词加载失败";
    case "available":
      return view.asset.lines.length === 0 ? "歌词为空" : "";
  }
}
