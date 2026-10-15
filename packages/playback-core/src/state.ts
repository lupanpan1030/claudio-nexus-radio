import type {
  CueAsset,
  CueBinding,
  CueId,
  CueStatus,
  DeckId,
  DeckRole,
  DeckStatus,
  DurationInfo,
  ErrorInfo,
  HistoryEntry,
  LyricsView,
  MediaClockSample,
  MediaReadiness,
  OperationId,
  OperationKind,
  QueueItem,
  QueueItemId,
  ReceiptStatus,
  Reservation,
  ResolvedMedia,
  SourceRevision,
  TransitionCancelReason,
  TransitionId,
  TransitionMode,
  TransitionPhase,
  VoiceLoadId,
  LoadId
} from "@claudio/contracts";

export interface CoreConfig {
  /** Talk mode used when narration is enabled and executable. */
  readonly preferredTalkMode: "sequential-talk" | "talk-over-crossfade";
  /** Remaining A time (ms) at which a talk-over-crossfade begins. */
  readonly crossfadeLeadMs: number;
  /** A's gain while the voice speaks over the crossfade. */
  readonly duckGain: number;
  /** B's gain while the voice speaks over it. */
  readonly underVoiceGain: number;
  /** Ramp duration for duck/fade gain changes. */
  readonly fadeMs: number;
  /** Ramp used to re-anchor gains after resume (old automation was cancelled). */
  readonly resumeRampMs: number;
  /** Consecutive item failures before auto-advance stops. */
  readonly maxConsecutiveFailures: number;
  /** Source refresh attempts per item for expired/retryable media errors. */
  readonly maxRefreshAttempts: number;
  readonly historyLimit: number;
  readonly receiptLimit: number;
}

/**
 * Defaults are configuration starting points, not measured optima. The talk
 * mode default stays sequential until the listening comparison picks one.
 */
export const DEFAULT_CORE_CONFIG: CoreConfig = Object.freeze({
  preferredTalkMode: "sequential-talk",
  crossfadeLeadMs: 8000,
  duckGain: 0.3,
  underVoiceGain: 0.3,
  fadeMs: 1500,
  resumeRampMs: 250,
  maxConsecutiveFailures: 3,
  maxRefreshAttempts: 1,
  historyLimit: 100,
  receiptLimit: 500
});

export interface QueueEntry {
  item: QueueItem;
  reservation: Reservation;
  lastError: ErrorInfo | null;
}

export interface DeckState {
  readonly id: DeckId;
  role: DeckRole;
  status: DeckStatus;
  loadId: LoadId | null;
  itemId: QueueItemId | null;
  media: ResolvedMedia | null;
  readiness: MediaReadiness;
  clock: MediaClockSample | null;
  duration: DurationInfo;
  /** Transition multiplier target. */
  gain: number;
  /** Whether this deck should sound while the transport is playing. */
  wantPlaying: boolean;
}

export interface ProgramState {
  item: QueueItem;
  deck: DeckId | null;
  /** Receipt emitted (committed + confirmed playing). */
  started: boolean;
  /** Where the next load of this item starts (refresh resumes here). */
  resumeAtMs: number;
  /**
   * Position the last user seek landed on. A narration window starting at or
   * before it was jumped over, not reached by playing, and is never caught up.
   */
  seekFloorMs: number | null;
  error: ErrorInfo | null;
}

/** Resolution state of one queue item. */
export interface ItemPrep {
  opId: OperationId | null;
  media: ResolvedMedia | null;
  refreshAttempts: number;
}

export interface CueState {
  binding: CueBinding;
  opId: OperationId | null;
  status: CueStatus;
  asset: CueAsset | null;
  voiceLoadId: VoiceLoadId | null;
  readiness: MediaReadiness;
  clock: MediaClockSample | null;
  /** Voice confirmed playing at least once; never restarted from scratch. */
  everSpoke: boolean;
}

export interface TransitionState {
  transitionId: TransitionId;
  fromItemId: QueueItemId;
  toItemId: QueueItemId;
  fromRevision: SourceRevision | null;
  toRevision: SourceRevision | null;
  mode: TransitionMode;
  phase: TransitionPhase;
  cueId: CueId | null;
  anchorMs: number | null;
  cancelReason: TransitionCancelReason | null;
}

export interface LyricsState {
  sourceRevision: SourceRevision;
  opId: OperationId | null;
  view: LyricsView;
}

export interface PendingOperation {
  opId: OperationId;
  kind: OperationKind;
}

/** Unspoken narration that may be reused by a later transition for the same pair. */
export interface ReusableCue {
  fromItemId: QueueItemId;
  toItemId: QueueItemId;
  fromRevision: SourceRevision | null;
  toRevision: SourceRevision | null;
  asset: CueAsset;
}

export type TransportIntent = "play" | "pause" | "stop";

export interface CoreState {
  version: number;
  config: CoreConfig;
  intent: TransportIntent;
  /** play() was rejected; a user gesture (resume) is required. */
  blocked: boolean;
  queue: QueueEntry[];
  history: HistoryEntry[];
  program: ProgramState | null;
  decks: { A: DeckState; B: DeckState };
  prep: Record<string, ItemPrep>;
  transition: TransitionState | null;
  cue: CueState | null;
  lyrics: Record<string, LyricsState>;
  receipts: Record<string, ReceiptStatus>;
  pending: Record<string, PendingOperation>;
  settings: { djEnabled: boolean; musicVolume: number; voiceVolume: number; muted: boolean };
  /** "from>to" pairs whose narration already started; never spoken again. */
  spokenPairs: string[];
  reusableCue: ReusableCue | null;
  consecutiveFailures: number;
  lastFailure: ErrorInfo | null;
}

/** Deeply readonly view handed out by the core. */
export type DeepReadonly<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type PlaybackState = DeepReadonly<CoreState>;

function idleDeck(id: DeckId): DeckState {
  return {
    id,
    role: "idle",
    status: "idle",
    loadId: null,
    itemId: null,
    media: null,
    readiness: "none",
    clock: null,
    duration: { kind: "unknown" },
    gain: 1,
    wantPlaying: false
  };
}

export function resetDeck(deck: DeckState): void {
  Object.assign(deck, idleDeck(deck.id));
}

export function createInitialState(options: {
  config?: Partial<CoreConfig>;
  settings?: Partial<CoreState["settings"]>;
} = {}): PlaybackState {
  const state: CoreState = {
    version: 0,
    config: { ...DEFAULT_CORE_CONFIG, ...options.config },
    intent: "stop",
    blocked: false,
    queue: [],
    history: [],
    program: null,
    decks: { A: idleDeck("A"), B: idleDeck("B") },
    prep: {},
    transition: null,
    cue: null,
    lyrics: {},
    receipts: {},
    pending: {},
    settings: { djEnabled: true, musicVolume: 1, voiceVolume: 1, muted: false, ...options.settings },
    spokenPairs: [],
    reusableCue: null,
    consecutiveFailures: 0,
    lastFailure: null
  };
  return deepFreeze(state);
}

/** Plain-data deep clone (state holds only JSON-like values). */
export function cloneState(state: PlaybackState): CoreState {
  return cloneValue(state) as CoreState;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = cloneValue(entry);
    return out;
  }
  return value;
}

export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function pairKey(fromItemId: QueueItemId, toItemId: QueueItemId): string {
  return `${fromItemId}>${toItemId}`;
}
