import type { QueueItemId } from "../ids.js";
import type { QueueItemOrigin, TrackDisplay, TrackRef } from "../catalog.js";

/** A track to put into the queue; the core assigns the QueueItemId. */
export interface QueueEntryRequest {
  readonly track: TrackRef;
  readonly display: TrackDisplay | null;
  readonly origin: QueueItemOrigin;
}

/**
 * User intents. Every UI entry point (buttons, chat, shortcuts, media keys)
 * becomes one of these; nothing else drives playback.
 */
export type PlaybackCommand =
  /** Play now: a new track, or an item already in the queue. */
  | { readonly type: "select"; readonly target: { readonly kind: "track"; readonly entry: QueueEntryRequest } | { readonly kind: "item"; readonly itemId: QueueItemId } }
  | { readonly type: "enqueue"; readonly entries: readonly QueueEntryRequest[]; readonly position: "next" | "end" }
  | { readonly type: "remove"; readonly itemId: QueueItemId }
  | { readonly type: "next" }
  | { readonly type: "pause" }
  /** Resume, or start the queue head when nothing is loaded. Requires a user gesture in browsers. */
  | { readonly type: "resume" }
  | { readonly type: "seek"; readonly positionMs: number }
  | { readonly type: "stop" }
  | { readonly type: "set-volume"; readonly channel: "music" | "voice"; readonly value: number }
  | { readonly type: "set-muted"; readonly muted: boolean }
  | { readonly type: "set-dj-enabled"; readonly enabled: boolean };

export type PlaybackCommandType = PlaybackCommand["type"];
