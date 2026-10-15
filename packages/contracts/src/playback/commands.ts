import type { QueueItemId } from "../ids.js";
import type { QueueItemOrigin, TrackDisplay, TrackRef } from "../catalog.js";

/**
 * A track to put into the queue. The core assigns the QueueItemId unless
 * `itemId` is supplied: then it must be an unclaimed reservation from the
 * same owner's id factory (e.g. a radio candidate whose server preparation
 * was requested under that id). An id that is not reserved, already claimed,
 * or still in use makes the whole command a no-op.
 */
export interface QueueEntryRequest {
  readonly track: TrackRef;
  readonly display: TrackDisplay | null;
  readonly origin: QueueItemOrigin;
  readonly itemId?: QueueItemId;
}

/**
 * User intents. Every UI entry point (buttons, chat, shortcuts, media keys)
 * becomes one of these; nothing else drives playback. One user action is one
 * command: the runtime may process facts between two dispatches.
 */
export type PlaybackCommand =
  /** Play now: a new track, or an item already in the queue. */
  | { readonly type: "select"; readonly target: { readonly kind: "track"; readonly entry: QueueEntryRequest } | { readonly kind: "item"; readonly itemId: QueueItemId } }
  | { readonly type: "enqueue"; readonly entries: readonly QueueEntryRequest[]; readonly position: "next" | "end" }
  /**
   * Atomically replace everything still waiting in the queue.
   *  autoplay=false (load only): the program and the target of an executing
   *    transition stay; every other waiting item is dropped (with its
   *    preparation, lyrics, standby deck and cue) and `entries` take their
   *    place. Never starts playback that was not already running: after
   *    stop/idle the list waits for resume, and an exhausted transport
   *    becomes idle (the list waits for resume instead of starting itself).
   *    An empty list just clears the waiting items.
   *  autoplay=true: any transition is cancelled once, entries[0] becomes the
   *    program (as `select`) and the rest form the queue after it. An empty
   *    list is ignored (nothing to play; current playback is untouched).
   */
  | { readonly type: "replace-queue"; readonly entries: readonly QueueEntryRequest[]; readonly autoplay: boolean }
  | { readonly type: "remove"; readonly itemId: QueueItemId }
  | { readonly type: "next" }
  | { readonly type: "pause" }
  /** Resume, or start the queue head when nothing is loaded. Requires a user gesture in browsers. */
  | { readonly type: "resume" }
  | { readonly type: "seek"; readonly positionMs: number }
  | { readonly type: "stop" }
  | { readonly type: "set-volume"; readonly channel: "music" | "voice"; readonly value: number }
  | { readonly type: "set-muted"; readonly muted: boolean }
  | { readonly type: "set-dj-enabled"; readonly enabled: boolean }
  /**
   * Speak the current program's retained narration again as a new manual cue
   * (new cueId/voiceLoadId). Allowed only when snapshot.narration.replay is
   * available; never adds a started receipt or touches automatic narration.
   */
  | { readonly type: "voice.replay" }
  /** Stop the active voice cue (manual or automatic). Narration stays replayable when its asset is still valid. */
  | { readonly type: "voice.stop" }
  /**
   * Pause only the voice; music keeps playing undocked. While a sequential
   * talk is the program output it pauses the whole transport instead.
   */
  | { readonly type: "voice.pause" }
  /** Resume a voice the user paused. Never resumes a transport the user paused. */
  | { readonly type: "voice.resume" };

export type PlaybackCommandType = PlaybackCommand["type"];
