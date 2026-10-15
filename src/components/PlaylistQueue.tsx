import type { CSSProperties } from "react";
import type { PlaybackSnapshot, QueueEntryRequest, QueueItem } from "@claudio/contracts";
import type { PlaybackController } from "../playback/controller";
import { upcomingEntries } from "../playback/radio-refill";
import type { PlaylistSuggestion } from "../types";

type PlaylistQueueProps = {
  snapshot: PlaybackSnapshot | null;
  controller: PlaybackController | null;
  canControl: boolean;
  /** Chat playlist metadata (title, unmatched tracks); the rows always come from the real queue. */
  playlist: PlaylistSuggestion | null;
};

type Row = { readonly item: QueueItem; readonly kind: "played" | "current" | "queued"; readonly queueIndex: number };

const ORIGIN_LABEL: Readonly<Record<QueueItem["origin"], string>> = { user: "点播", radio: "电台", chat: "聊天", restore: "上次" };

function toRequest(item: QueueItem): QueueEntryRequest {
  return { track: item.track, display: item.display, origin: "user" };
}

/**
 * The real queue: recently played (confirmed started), the current program
 * and what comes next. Each row is one occurrence keyed by its item id, so a
 * song queued twice shows twice and only the playing occurrence is marked.
 */
export function PlaylistQueue({ snapshot, controller, canControl, playlist }: PlaylistQueueProps) {
  const upcoming = snapshot ? upcomingEntries(snapshot) : [];
  const played = snapshot ? snapshot.history.filter((entry) => entry.started).slice(-3) : [];
  const program = snapshot?.program?.item ?? null;
  const restoredHead = !program && snapshot?.transport === "idle" ? upcoming[0]?.item ?? null : null;
  const rows: Row[] = [
    ...played.map((entry) => ({ item: entry.item, kind: "played" as const, queueIndex: -1 })),
    ...(program ? [{ item: program, kind: "current" as const, queueIndex: -1 }] : []),
    ...upcoming.map((entry, index) => ({ item: entry.item, kind: entry.item.itemId === restoredHead?.itemId ? ("current" as const) : ("queued" as const), queueIndex: index }))
  ];

  if (rows.length === 0) {
    return (
      <section className="playlist-queue empty" aria-label="播放队列">
        <div className="playlist-empty">歌单会在这里显示</div>
      </section>
    );
  }

  const select = (row: Row) => {
    if (!controller || !canControl) return;
    if (row.kind === "played") return controller.playTrack(toRequest(row.item));
    if (row.queueIndex >= 0) controller.playFrom(upcoming.map((entry) => toRequest(entry.item)), row.queueIndex);
  };

  const missingTracks = playlist?.missingTracks ?? [];
  const isCacheOnly = (track: NonNullable<PlaylistSuggestion["missingTracks"]>[number]) =>
    (track.candidates?.length ?? 0) > 0 && track.candidates!.every((candidate) => candidate.playable === false || candidate.source === "kugou-cache");
  const visibleMissingTracks = missingTracks.filter((track) => !isCacheOnly(track)).slice(0, 3);
  const cacheOnlyCount = missingTracks.length - missingTracks.filter((track) => !isCacheOnly(track)).length;

  return (
    <section className="playlist-queue" aria-label="播放队列">
      <div className="playlist-queue-list">
        {rows.map((row, index) => {
          const title = row.item.display?.title || "未知歌曲";
          const artist = row.item.display?.artist || "未知歌手";
          const clickable = canControl && (row.kind !== "current" || row.queueIndex >= 0);
          return (
            <button
              type="button"
              key={row.item.itemId}
              className={`playlist-track ${row.kind}`}
              style={{ "--queue-delay": `${Math.min(index, 8) * 28}ms` } as CSSProperties & Record<string, string>}
              onClick={() => select(row)}
              disabled={!clickable}
              aria-current={row.kind === "current" ? "true" : undefined}
              title={row.kind === "current" ? `正在播放 ${artist} - ${title}` : `播放 ${artist} - ${title}`}
            >
              <span className="playlist-index">{row.kind === "played" ? "··" : String(index + 1 - played.length).padStart(2, "0")}</span>
              <div>
                <strong>{title}</strong>
                <small>
                  {artist} · {ORIGIN_LABEL[row.item.origin]}
                </small>
              </div>
            </button>
          );
        })}
      </div>
      {missingTracks.length > 0 && (
        <div className="playlist-missing" aria-label="未匹配的歌单歌曲">
          <strong>{visibleMissingTracks.length > 0 ? `${missingTracks.length} 首未自动匹配` : `${cacheOnlyCount} 首暂不可播放`}</strong>
          {visibleMissingTracks.map((track) => (
            <small key={`${track.title}-${track.artist ?? ""}`}>
              {track.title}
              {track.artist ? ` / ${track.artist}` : ""}
              {track.candidates?.[0]
                ? ` · 候选：${track.candidates[0].artist} - ${track.candidates[0].title}${track.candidates[0].playable === false ? `（不可播放 ${track.candidates[0].extension ?? ""}）` : ""}`
                : ""}
            </small>
          ))}
          {cacheOnlyCount > 0 && <small>{cacheOnlyCount} 首在酷狗缓存中找到，但网页播放器暂不可播放；补 mp3/flac 后可导入。</small>}
        </div>
      )}
    </section>
  );
}
