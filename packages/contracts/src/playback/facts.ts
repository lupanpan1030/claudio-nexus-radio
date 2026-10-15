import type { CueId, IdempotencyKey, LoadId, OperationId, QueueItemId, SourceRevision, TransitionId, VoiceLoadId } from "../ids.js";
import type { ResolvedMedia } from "../media.js";
import type { CueAsset } from "../narration.js";
import type { LyricsAvailability } from "../lyrics.js";
import type { ErrorInfo, FailureOutcome } from "../operation.js";
import type { DurationInfo } from "../timing.js";

export type DeckId = "A" | "B";

export const DECK_IDS: readonly DeckId[] = ["A", "B"];

/**
 * Why play() was refused. "aborted" (AbortError) answers a play that a
 * pause()/load() interrupted; an executor does not report the ones its own
 * pause()/unload caused, because they answer a request already superseded.
 */
export type PlayRejection = "not-allowed" | "aborted" | "unsupported" | "unknown";

/**
 * Confirmed media-element observations. `play()` resolving or an HTTP 200 is
 * not "playing"; only a `playing` event (with position) is.
 */
export type MediaEvent =
  /**
   * Duration as the element (or a decoder) measured it; sent again on every
   * `durationchange`. The core keeps the strongest source (see preferDuration).
   */
  | { readonly kind: "metadata"; readonly duration: DurationInfo }
  | { readonly kind: "can-play"; readonly through: boolean }
  | { readonly kind: "playing"; readonly positionMs: number }
  | { readonly kind: "waiting"; readonly positionMs: number }
  /** Network stalled; the element may still have buffered data. Not a pause. */
  | { readonly kind: "stalled" }
  /**
   * `atEnd` is `element.ended` read synchronously in the `pause` handler.
   * Browsers pause at the natural end before firing `ended`, so atEnd=true is
   * the end arriving, not an interruption. Never inferred from position vs duration:
   * a real pause just before the end must still count as a pause.
   *
   * `requested` is true when this event answers the executor's own pause()
   * call for a deck.pause/voice.pause effect. pause() on an already paused
   * element fires nothing, so the executor counts only calls it made while
   * `element.paused` was false and consumes one per `pause` event. Such an
   * event may arrive after a later play request; it is never an interruption.
   * false = the platform/OS/another agent paused the element.
   */
  | { readonly kind: "paused"; readonly positionMs: number; readonly atEnd: boolean; readonly requested: boolean }
  /**
   * Answers a deck.seek. Every deck.seek on an element that has metadata is
   * followed by one `seeked` (the last one when seeks overlap); until it
   * arrives the core treats position/`ended` reports as pre-seek.
   */
  | { readonly kind: "seeked"; readonly positionMs: number }
  | { readonly kind: "time"; readonly positionMs: number; readonly rate: number }
  | { readonly kind: "ended" }
  | { readonly kind: "play-rejected"; readonly reason: PlayRejection }
  | { readonly kind: "error"; readonly error: ErrorInfo };

export type ReceiptOutcome = "recorded" | "duplicate" | "failed";

/**
 * Results flowing back into the core. Each carries the identity of the
 * request/load it answers; the core drops facts whose identity is no longer current.
 */
export type PlaybackFact =
  | { readonly type: "deck.media"; readonly deck: DeckId; readonly loadId: LoadId; readonly event: MediaEvent }
  | { readonly type: "voice.media"; readonly cueId: CueId; readonly voiceLoadId: VoiceLoadId; readonly event: MediaEvent }
  | { readonly type: "prepare.resolved"; readonly opId: OperationId; readonly itemId: QueueItemId; readonly media: ResolvedMedia }
  | { readonly type: "prepare.settled"; readonly opId: OperationId; readonly itemId: QueueItemId; readonly outcome: FailureOutcome; readonly error: ErrorInfo | null }
  | { readonly type: "cue.ready"; readonly opId: OperationId; readonly cueId: CueId; readonly transitionId: TransitionId; readonly asset: CueAsset }
  | { readonly type: "cue.settled"; readonly opId: OperationId; readonly cueId: CueId; readonly outcome: FailureOutcome; readonly error: ErrorInfo | null }
  | { readonly type: "lyrics.result"; readonly opId: OperationId; readonly itemId: QueueItemId; readonly sourceRevision: SourceRevision; readonly result: LyricsAvailability }
  | { readonly type: "lyrics.settled"; readonly opId: OperationId; readonly itemId: QueueItemId; readonly outcome: FailureOutcome; readonly error: ErrorInfo | null }
  | { readonly type: "receipt.settled"; readonly idempotencyKey: IdempotencyKey; readonly itemId: QueueItemId; readonly outcome: ReceiptOutcome };

export type PlaybackFactType = PlaybackFact["type"];
