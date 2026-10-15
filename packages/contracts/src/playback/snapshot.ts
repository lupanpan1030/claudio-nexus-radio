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
 *  exhausted: the queue ran out while the listener still wants playback; the
 *             next enqueued item starts on its own (a refill is the app's job)
 */
export type TransportStatus = "idle" | "requested" | "loading" | "playing" | "waiting" | "paused" | "blocked" | "failed" | "exhausted";

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

/**
 * Narration status; requests and media facts are kept apart.
 *  requested: asset being generated
 *  ready:     voice loaded, not asked to play
 *  starting:  voice.play issued, `playing` not confirmed yet (may be rejected)
 *  speaking:  the voice element confirmed `playing`
 *  waiting:   buffering after it was speaking
 *  paused:    held by a transport pause; resume asks it to play again
 */
export type CueStatus = "requested" | "ready" | "starting" | "speaking" | "waiting" | "paused" | "ended" | "cancelled" | "failed";

/**
 * Who started the voice cue: an automatic transition, or the listener's
 * explicit replay of the current program's retained narration.
 */
export type CueOrigin = "transition" | "manual";

/**
 * Why a voice is paused (status "paused"):
 *  transport: a global pause; a global resume continues it
 *  user:      voice.pause; only voice.resume continues it
 */
export type VoicePausedBy = "transport" | "user";

export interface VoiceSnapshot {
  readonly cueId: CueId;
  /** For a manual cue: the transition whose narration is being replayed. */
  readonly transitionId: TransitionId;
  readonly origin: CueOrigin;
  readonly status: CueStatus;
  readonly pausedBy: VoicePausedBy | null;
  readonly voiceLoadId: VoiceLoadId | null;
  readonly clock: MediaClockSample | null;
  readonly scriptText: string | null;
  readonly subtitle: SubtitleTrack | null;
}

/**
 * Why the current program's narration cannot be replayed right now.
 *  no-narration:          nothing was spoken into this item (e.g. the first
 *                         track, DJ off, cue failed); never fabricated
 *  not-started:           the program has not confirmed playing yet
 *  recording-changed:     the program's actual recording/revision differs
 *                         from the one the narration was bound to
 *  expired:               the voice asset's stream expired
 *  voice-active:          a voice cue is active (stop it first)
 *  transition-executing:  the hand-over to the next item is under way
 *  transport-not-playing: paused/stopped/blocked/loading transport
 */
export type NarrationReplayBlock =
  | "no-narration"
  | "not-started"
  | "recording-changed"
  | "expired"
  | "voice-active"
  | "transition-executing"
  | "transport-not-playing";

/** Narration that introduced the current program, kept for explicit replay. */
export interface RetainedNarrationView {
  readonly itemId: QueueItemId;
  /** Automatic cue that spoke it originally. */
  readonly cueId: CueId;
  readonly transitionId: TransitionId;
  readonly scriptText: string;
  readonly subtitle: SubtitleTrack;
  /** Spoken length in ms at the asset's playback rate; null when not measured. */
  readonly spokenMs: number | null;
  readonly expiresAt: RuntimeClockMs | null;
}

export interface NarrationSnapshot {
  /** Null when the current program has no retained narration. */
  readonly retained: RetainedNarrationView | null;
  readonly replay: { readonly available: true } | { readonly available: false; readonly reason: NarrationReplayBlock };
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
 * deck clock and revision; DJ subtitles follow the voice clock and cue, and
 * only once the voice element confirmed `playing` (a requested play is not speech).
 * Only automatic transition narration takes over the display; a manual
 * replay leaves the program lyrics here and is shown from `voice`.
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
  readonly narration: NarrationSnapshot;
  readonly transition: TransitionPlan | null;
  readonly display: DisplayItem;
  readonly queue: readonly QueueEntrySnapshot[];
  readonly history: readonly HistoryEntry[];
  readonly settings: { readonly djEnabled: boolean; readonly musicVolume: number; readonly voiceVolume: number; readonly muted: boolean };
  readonly receipts: readonly { readonly itemId: QueueItemId; readonly status: ReceiptStatus }[];
  /** Operations the core is still waiting on. Empty after stop/cancel. */
  readonly pending: readonly { readonly opId: OperationId; readonly kind: OperationKind }[];
}
