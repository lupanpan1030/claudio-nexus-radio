import type { QueueItem } from "@claudio/contracts";
import type { PlaybackState } from "./state.js";

/**
 * Items a fresh executor should queue up again after a reload or takeover:
 * the program first, then the queue in order, each itemId once. A program
 * whose own deck already played to its end is left out — it is still the
 * program only while the hand-over to the next item (e.g. the DJ talking
 * after it) finishes, and has been heard. A paused, playing or not yet
 * loaded program stays first.
 */
export function resumableQueueItems(state: PlaybackState): readonly QueueItem[] {
  const program = state.program;
  const programDeck = program?.deck ? state.decks[program.deck] : null;
  const heard = program !== null && programDeck !== null && programDeck.itemId === program.item.itemId && programDeck.status === "ended";
  const items = [...(program ? [program.item] : []), ...state.queue.map((entry) => entry.item)];
  return items.filter(
    (item, index) => !(heard && item.itemId === program.item.itemId) && items.findIndex((other) => other.itemId === item.itemId) === index
  );
}
