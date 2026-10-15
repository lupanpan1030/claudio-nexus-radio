/**
 * Hand-over context for one DJ line: what is ending, what actually played
 * before it, and lines generated recently. Pure formatting, no I/O, so the
 * v1 writer and its tests can use it without the legacy database.
 */
export interface DjHandoverTrack {
  readonly title: string;
  readonly artist: string;
  readonly album?: string;
}

export interface DjHandoverContext {
  /** The track playing before the hand-over, when known. */
  readonly from: DjHandoverTrack | null;
  /** Tracks confirmed started, newest first (listening history, not selections). */
  readonly recentStarted: readonly DjHandoverTrack[];
  /** Lines generated recently, newest first. Generated is not the same as aired. */
  readonly recentGenerated: readonly string[];
}

const MAX_STARTED = 6;
const MAX_GENERATED = 4;
const MAX_LINE_CHARS = 120;

function describe(track: DjHandoverTrack): string {
  const name = `${track.artist}《${track.title}》`;
  return track.album ? `${name}（专辑：${track.album}）` : name;
}

/** Empty string when there is nothing to say; callers then leave the prompt unchanged. */
export function formatHandoverContext(context: DjHandoverContext): string {
  const lines: string[] = [];
  if (context.from) lines.push(`上一首（正在结束）：${describe(context.from)}`);
  const started = context.recentStarted.slice(0, MAX_STARTED);
  if (started.length > 0) {
    lines.push("最近实际播放过（新→旧）：", ...started.map((track) => `- ${describe(track)}`));
  }
  const generated = context.recentGenerated
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_GENERATED);
  if (generated.length > 0) {
    lines.push(
      "最近生成过的串词（只用于避免重复措辞；不代表已经播出，不要当作已经说过的话来引用）：",
      ...generated.map((text) => `- ${text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text}`)
    );
  }
  return lines.join("\n");
}
