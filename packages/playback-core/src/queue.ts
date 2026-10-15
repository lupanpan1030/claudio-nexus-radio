import type { HistoryOutcome, QueueItem, QueueItemId } from "@claudio/contracts";
import type { CoreState, QueueEntry } from "./state.js";

/** Queue partition: ordered entries with reservations, plus bounded history. */

export function findEntry(s: CoreState, itemId: QueueItemId): QueueEntry | undefined {
  return s.queue.find((entry) => entry.item.itemId === itemId);
}

/** First entry that is not the current program item. */
export function nextEntry(s: CoreState): QueueEntry | undefined {
  const programId = s.program?.item.itemId;
  return s.queue.find((entry) => entry.item.itemId !== programId);
}

export function removeEntry(s: CoreState, itemId: QueueItemId): QueueEntry | undefined {
  const index = s.queue.findIndex((entry) => entry.item.itemId === itemId);
  if (index < 0) return undefined;
  const [removed] = s.queue.splice(index, 1);
  return removed;
}

/**
 * Insert after any entries that must stay ahead: the program entry (until it
 * is consumed) and a transition target that is already executing.
 */
export function insertEntries(s: CoreState, items: readonly QueueItem[], position: "next" | "end", lockedIds: readonly QueueItemId[]): void {
  const entries = items.map((item): QueueEntry => ({ item, reservation: "none", lastError: null }));
  if (position === "end") {
    s.queue.push(...entries);
    return;
  }
  let index = 0;
  while (index < s.queue.length && lockedIds.includes(s.queue[index]!.item.itemId)) index += 1;
  s.queue.splice(index, 0, ...entries);
}

export function moveToFront(s: CoreState, itemId: QueueItemId): QueueEntry | undefined {
  const entry = removeEntry(s, itemId);
  if (entry) s.queue.unshift(entry);
  return entry;
}

export function pushHistory(s: CoreState, item: QueueItem, outcome: HistoryOutcome, started: boolean): void {
  s.history.push({ item, outcome, started });
  if (s.history.length > s.config.historyLimit) s.history.splice(0, s.history.length - s.config.historyLimit);
}
