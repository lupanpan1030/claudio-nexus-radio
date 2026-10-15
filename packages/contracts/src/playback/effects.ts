import type { TrackRef } from "../catalog.js";
import type {
  CueId,
  IdempotencyKey,
  LoadId,
  OperationId,
  QueueItemId,
  RecordingId,
  SourceRevision,
  VoiceLoadId
} from "../ids.js";
import type { ResolvedMedia } from "../media.js";
import type { CueAsset, CueBinding } from "../narration.js";
import type { DeckId } from "./facts.js";

export type PreparePurpose = "program" | "standby" | "refresh";

export type OperationKind = "prepare" | "cue" | "lyrics";

/**
 * The fact that a queue item became real program output. Sent once per item;
 * pause/resume and same-recording reloads never produce another receipt.
 */
export interface PlaybackReceipt {
  readonly idempotencyKey: IdempotencyKey;
  readonly itemId: QueueItemId;
  readonly track: TrackRef;
  readonly recordingId: RecordingId;
  readonly sourceRevision: SourceRevision;
  readonly loadId: LoadId;
  readonly positionMs: number;
  /** Runtime clock value; the runtime converts it to wall time on the wire. */
  readonly at: number;
}

/**
 * Instructions for the runtime/executor. Executing an effect must report
 * results back as facts carrying the same identities.
 *
 * Gain semantics: `deck.gain` is a transition multiplier in [0,1] applied on
 * top of the user's music volume, so restoring after a duck always lands on
 * the latest user volume. `deck.pause` also cancels pending gain automation
 * on that deck; the core re-issues gains after resume.
 */
export type PlaybackEffect =
  | { readonly type: "prepare.start"; readonly opId: OperationId; readonly itemId: QueueItemId; readonly track: TrackRef; readonly purpose: PreparePurpose; readonly previousRevision: SourceRevision | null }
  /** Best-effort abort. The core has already settled the operation as cancelled. */
  | { readonly type: "operation.cancel"; readonly opId: OperationId; readonly kind: OperationKind }
  | { readonly type: "deck.load"; readonly deck: DeckId; readonly loadId: LoadId; readonly itemId: QueueItemId; readonly media: ResolvedMedia; readonly startAtMs: number }
  | { readonly type: "deck.play"; readonly deck: DeckId; readonly loadId: LoadId }
  /** The resulting `paused` fact (if the element was not already paused) carries requested=true. */
  | { readonly type: "deck.pause"; readonly deck: DeckId; readonly loadId: LoadId }
  /** Answered by a `seeked` fact, also when the executor had to defer it until metadata. */
  | { readonly type: "deck.seek"; readonly deck: DeckId; readonly loadId: LoadId; readonly positionMs: number }
  | { readonly type: "deck.gain"; readonly deck: DeckId; readonly loadId: LoadId; readonly gain: number; readonly rampMs: number }
  | { readonly type: "deck.unload"; readonly deck: DeckId; readonly loadId: LoadId }
  | { readonly type: "cue.request"; readonly opId: OperationId; readonly binding: CueBinding; readonly from: TrackRef; readonly to: TrackRef }
  | { readonly type: "voice.load"; readonly cueId: CueId; readonly voiceLoadId: VoiceLoadId; readonly asset: CueAsset }
  | { readonly type: "voice.play"; readonly cueId: CueId; readonly voiceLoadId: VoiceLoadId }
  | { readonly type: "voice.pause"; readonly cueId: CueId; readonly voiceLoadId: VoiceLoadId }
  /** Stop and release the voice element; the cue will not resume. */
  | { readonly type: "voice.stop"; readonly cueId: CueId; readonly voiceLoadId: VoiceLoadId }
  | { readonly type: "lyrics.request"; readonly opId: OperationId; readonly itemId: QueueItemId; readonly track: TrackRef; readonly recordingId: RecordingId; readonly sourceRevision: SourceRevision }
  | { readonly type: "output.volume"; readonly music: number; readonly voice: number; readonly muted: boolean }
  /** Fire-and-forget history report; failure never blocks audio. */
  | { readonly type: "receipt.report"; readonly receipt: PlaybackReceipt };

export type PlaybackEffectType = PlaybackEffect["type"];
