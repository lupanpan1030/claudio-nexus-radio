import { isRecord, type PlaybackCommand, type PlaybackSnapshot, type QueueEntryRequest } from "@claudio/contracts";
import { decodeRef, type CatalogIndex } from "./catalog";
import { upcomingEntries } from "./radio-refill";

/** The playback-relevant part of a chat reply, as the server sends it (v1 adds `track` to picks). */
export interface ChatPickWire {
  readonly songId: string;
  readonly track?: unknown;
}

export interface ChatReplyWire {
  readonly pick?: ChatPickWire;
  readonly queuePick?: ChatPickWire;
  readonly playlist?: { readonly title?: string; readonly picks: readonly ChatPickWire[] };
}

export type ChatIntentKind = "none" | "play-now" | "queue-next" | "load-playlist" | "play-playlist";

/**
 * One explicit queue intent normalized from a reply that may carry several
 * fields. `destructive` = it changes what plays now or replaces the queue.
 * `autoStarts` = applying it may start sound by itself (e.g. the core is
 * exhausted and starts the next enqueued item).
 */
export interface ChatPlan {
  readonly kind: ChatIntentKind;
  readonly commands: readonly PlaybackCommand[];
  readonly destructive: boolean;
  readonly autoStarts: boolean;
  /** Chinese one-liner for the chat log / suggestion button. */
  readonly summary: string;
  /** Songs the client could not map to a TrackRef (skipped, never guessed). */
  readonly unresolved: readonly string[];
}

const NONE: ChatPlan = Object.freeze({ kind: "none", commands: [], destructive: false, autoStarts: false, summary: "", unresolved: [] });

function entryOf(pick: ChatPickWire | undefined, catalog: CatalogIndex, unresolved: string[]): QueueEntryRequest | null {
  if (!pick || !isRecord(pick) || typeof pick.songId !== "string") return null;
  const known = catalog.byLegacyId(pick.songId);
  const track = decodeRef(pick.track) ?? known?.ref ?? null;
  if (!track) {
    unresolved.push(pick.songId);
    return null;
  }
  const display = known && (known.display.title || known.display.artist) ? known.display : (catalog.byTrack(track)?.display ?? null);
  return { track, display, origin: "chat" };
}

function title(entry: QueueEntryRequest): string {
  return entry.display ? `${entry.display.title}${entry.display.artist ? ` / ${entry.display.artist}` : ""}` : "这首歌";
}

/**
 * Decides at answer time (with the current snapshot, not the one when the
 * question was asked) what the reply means for the queue, as exactly one
 * command — the runtime may process facts between two dispatches:
 *  - playlist (+pick/queuePick in front): replace-queue; plays first only with a pick;
 *  - pick: next while listening with more lined up, else played now
 *    (with a queuePick: one replace-queue keeping what was waiting);
 *  - queuePick: queued next.
 */
export function planChatReply(reply: ChatReplyWire, snapshot: PlaybackSnapshot | null, catalog: CatalogIndex): ChatPlan {
  if (!snapshot) return NONE;
  const unresolved: string[] = [];
  const pick = entryOf(reply.pick, catalog, unresolved);
  const queuePick = entryOf(reply.queuePick, catalog, unresolved);
  const playlist = Array.isArray(reply.playlist?.picks)
    ? reply.playlist.picks.map((item) => entryOf(item, catalog, unresolved)).filter((entry): entry is QueueEntryRequest => entry !== null)
    : null;
  const listening = snapshot.program !== null && ["requested", "loading", "playing", "waiting"].includes(snapshot.transport);
  // enqueue into an exhausted queue starts playback by itself (core semantics).
  const idleQueueStarts = snapshot.program === null && snapshot.transport === "exhausted";

  if (playlist && playlist.length > 0) {
    // pick + playlist plays the pick first; otherwise the list loads behind the program.
    const entries = [...(pick ? [pick] : []), ...(queuePick ? [queuePick] : []), ...playlist];
    const autoplay = pick !== null;
    return {
      kind: autoplay ? "play-playlist" : "load-playlist",
      commands: [{ type: "replace-queue", entries, autoplay }],
      destructive: true,
      autoStarts: autoplay,
      summary: `${autoplay ? "播放" : "载入"}歌单「${reply.playlist?.title ?? "新歌单"}」（${entries.length} 首）`,
      unresolved
    };
  }
  if (pick) {
    const upcoming = upcomingEntries(snapshot);
    // Listening with more lined up: the request joins as the next song (previous product rule).
    if (listening && upcoming.length > 0) {
      return {
        kind: "queue-next",
        commands: [{ type: "enqueue", entries: [pick, ...(queuePick ? [queuePick] : [])], position: "next" }],
        destructive: false,
        autoStarts: idleQueueStarts,
        summary: `下一首播放 ${title(pick)}`,
        unresolved
      };
    }
    if (queuePick) {
      // Two songs in one reply stay one command: play the pick, the queued one next, then what was waiting.
      const rest = upcoming.map((entry) => ({ track: entry.item.track, display: entry.item.display, origin: entry.item.origin }));
      return {
        kind: "play-now",
        commands: [{ type: "replace-queue", entries: [pick, queuePick, ...rest], autoplay: true }],
        destructive: true,
        autoStarts: true,
        summary: `播放 ${title(pick)}，下一首 ${title(queuePick)}`,
        unresolved
      };
    }
    return { kind: "play-now", commands: [{ type: "select", target: { kind: "track", entry: pick } }], destructive: true, autoStarts: true, summary: `播放 ${title(pick)}`, unresolved };
  }
  if (queuePick) {
    return {
      kind: "queue-next",
      commands: [{ type: "enqueue", entries: [queuePick], position: "next" }],
      destructive: false,
      autoStarts: idleQueueStarts,
      summary: `下一首播放 ${title(queuePick)}`,
      unresolved
    };
  }
  return { ...NONE, unresolved };
}

/**
 * A reply that arrives after the listener changed playback in the meantime
 * is not applied if it would change what plays or could start sound by
 * itself; it is offered as a suggestion the listener can adopt explicitly.
 */
export function shouldDeliver(plan: ChatPlan, overtaken: boolean): "apply" | "suggest" | "nothing" {
  if (plan.commands.length === 0) return "nothing";
  if (!overtaken) return "apply";
  return plan.destructive || plan.autoStarts ? "suggest" : "apply";
}
