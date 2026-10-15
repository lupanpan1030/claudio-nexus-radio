import type { QueueItem } from "../catalog.js";
import type { CueId, LoadId, OperationId, QueueItemId, RecordingId, SourceRevision, TransitionId, VoiceLoadId } from "../ids.js";
import type { LyricsAsset } from "../lyrics.js";
import type { MediaReadiness } from "../media.js";
import type { SubtitleTrack } from "../narration.js";
import type { ErrorInfo } from "../operation.js";
import type { DurationInfo, MediaClockSample } from "../timing.js";
import type { TransitionPlan } from "../transition.js";
import type { OperationKind } from "./effects.js";
import type { DeckId, ReceiptOutcome } from "./facts.js";

/**
 * Runtime clock convention for every number named `at`, `observedAt`,
 * `expiresAt` inside commands/facts/effects/snapshots: milliseconds, monotonic
 * within one executor instance and epoch-aligned (e.g. timeOrigin + now()).
 * The core never reads a clock; the runtime passes `now` with each input.
 */
export type RuntimeClockMs = number;

/**
 * Program transport as the listener experiences it.
 *  requested: item chosen, source not resolved yet
 *  loading:   media loading on a deck, not yet confirmed playing
 *  blocked:   play() rejected (e.g. autoplay policy); needs a user gesture
 */
export type TransportStatus = "idle" | "requested" | "loading" | "playing" | "waiting" | "paused" | "blocked" | "failed";

export type DeckRole = "program" | "standby" | "outgoing" | "idle";

export type DeckStatus = "idle" | "loading" | "ready" | "playing" | "waiting" | "paused" | "ended" | "failed";

export interface DeckSnapshot {
  readonly deck: DeckId;
  readonly role: DeckRole;
  readonly status: DeckStatus;
  readonly loadId: LoadId | null;
  readonly itemId: QueueItemId | null;
  readonly sourceRevision: SourceRevision | null;
  readonly recordingId: RecordingId | null;
  readonly readiness: MediaReadiness;
  readonly clock: MediaClockSample | null;
  readonly duration: DurationInfo;
  /** Transition multiplier currently targeted (not the user volume). */
  readonly gain: number;
}

export type CueStatus = "requested" | "ready" | "speaking" | "paused" | "ended" | "cancelled" | "failed";

export interface VoiceSnapshot {
  readonly cueId: CueId;
  readonly transitionId: TransitionId;
  readonly status: CueStatus;
  readonly voiceLoadId: VoiceLoadId | null;
  readonly clock: MediaClockSample | null;
  readonly scriptText: string | null;
  readonly subtitle: SubtitleTrack | null;
}

export type LyricsView =
  | { readonly status: "none" }
  | { readonly status: "loading" }
  | { readonly status: "available"; readonly asset: LyricsAsset }
  | { readonly status: "missing"; readonly reason: string }
  | { readonly status: "unmatched" }
  | { readonly status: "failed" };

/**
 * What subtitles should follow right now. Music lyrics follow the program
 * deck clock and revision; DJ subtitles follow the voice clock and cue.
 */
export type DisplayItem =
  | { readonly kind: "none" }
  | { readonly kind: "music"; readonly itemId: QueueItemId; readonly deck: DeckId | null; readonly loadId: LoadId | null; readonly sourceRevision: SourceRevision | null; readonly lyrics: LyricsView }
  | { readonly kind: "voice"; readonly cueId: CueId; readonly transitionId: TransitionId; readonly subtitle: SubtitleTrack | null; readonly text: string | null };

export type Reservation = "none" | "standby" | "program";

export interface QueueEntrySnapshot {
  readonly item: QueueItem;
  readonly reservation: Reservation;
  readonly lastError: ErrorInfo | null;
}

export type HistoryOutcome = "played" | "skipped" | "failed" | "stopped";

export interface HistoryEntry {
  readonly item: QueueItem;
  readonly outcome: HistoryOutcome;
  /** True only if a started receipt was emitted for the item. */
  readonly started: boolean;
}

export type ReceiptStatus = "pending" | ReceiptOutcome;

export interface ProgramSnapshot {
  readonly item: QueueItem;
  readonly deck: DeckId | null;
  readonly loadId: LoadId | null;
  readonly sourceRevision: SourceRevision | null;
  readonly started: boolean;
  readonly error: ErrorInfo | null;
}

export interface PlaybackSnapshot {
  /** Increments on every accepted state change. */
  readonly version: number;
  readonly transport: TransportStatus;
  readonly program: ProgramSnapshot | null;
  readonly decks: { readonly A: DeckSnapshot; readonly B: DeckSnapshot };
  readonly voice: VoiceSnapshot | null;
  readonly transition: TransitionPlan | null;
  readonly display: DisplayItem;
  readonly queue: readonly QueueEntrySnapshot[];
  readonly history: readonly HistoryEntry[];
  readonly settings: { readonly djEnabled: boolean; readonly musicVolume: number; readonly voiceVolume: number; readonly muted: boolean };
  readonly receipts: readonly { readonly itemId: QueueItemId; readonly status: ReceiptStatus }[];
  /** Operations the core is still waiting on. Empty after stop/cancel. */
  readonly pending: readonly { readonly opId: OperationId; readonly kind: OperationKind }[];
}
