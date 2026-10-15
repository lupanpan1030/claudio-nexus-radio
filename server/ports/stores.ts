import type {
  CueId,
  DurationInfo,
  ExecutorInstanceId,
  IdempotencyKey,
  LoadId,
  LyricsAvailability,
  NarrationScript,
  PreparationId,
  PreparationStatusV1,
  PreparedItemV1,
  PrepareRequestV1,
  ProviderId,
  QueueItemId,
  RecordingConfidence,
  RecordingId,
  SourceRevision,
  Stage,
  TrackRef,
  TransitionId,
  VoiceAssetWire
} from "@claudio/contracts";
import type { SourceBinding } from "./media-source.js";

export type PreparationStages = PreparedItemV1["stages"];

export interface PreparationRecord {
  readonly preparationId: PreparationId;
  readonly itemId: QueueItemId;
  readonly request: PrepareRequestV1;
  readonly version: number;
  readonly status: PreparationStatusV1;
  readonly stages: PreparationStages;
  readonly cueId: CueId | null;
  /** Epoch ms. */
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Server process that owned the in-memory job. */
  readonly ownerInstance: string;
}

export interface PreparationStore {
  insert(record: PreparationRecord): void;
  /** Optimistic update: succeeds only if the stored version is `expectedVersion`. */
  update(record: PreparationRecord, expectedVersion: number): boolean;
  get(preparationId: PreparationId): PreparationRecord | null;
  latestForItem(itemId: QueueItemId): PreparationRecord | null;
  listByStatus(statuses: readonly PreparationStatusV1[]): readonly PreparationRecord[];
  /** Deletes terminal records with expiresAt < before, except protected items. */
  deleteExpired(before: number, protectedItems: ReadonlySet<string>): number;
}

export interface CueRecord {
  readonly cueId: CueId;
  readonly transitionId: TransitionId;
  readonly preparationId: PreparationId | null;
  readonly fromItemId: QueueItemId;
  readonly toItemId: QueueItemId;
  readonly fromTrack: TrackRef;
  readonly toTrack: TrackRef;
  readonly fromRevision: SourceRevision | null;
  readonly toRevision: SourceRevision | null;
  readonly version: number;
  readonly script: Stage<NarrationScript>;
  readonly voice: Stage<VoiceAssetWire>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CueStore {
  insert(record: CueRecord): void;
  update(record: CueRecord, expectedVersion: number): boolean;
  get(cueId: CueId): CueRecord | null;
  listUnsettled(): readonly CueRecord[];
  deleteOlderThan(before: number, keepPreparations: ReadonlySet<string>): number;
}

export interface StoredScript {
  readonly script: NarrationScript;
  readonly cueId: CueId;
  readonly writer: string;
  readonly createdAt: number;
}

export interface ScriptStore {
  insert(entry: StoredScript): void;
}

export interface VoiceCacheEntry {
  readonly contentKey: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly duration: DurationInfo;
  readonly descriptor: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

export interface VoiceCacheStore {
  get(contentKey: string): VoiceCacheEntry | null;
  put(entry: VoiceCacheEntry): void;
  touch(contentKey: string, at: number): void;
  remove(contentKey: string): void;
  listUnusedSince(before: number): readonly VoiceCacheEntry[];
}

export type StreamHandleKind = "media" | "voice";

export interface StreamHandleRecord {
  /** Token part of the opaque handle. */
  readonly token: string;
  readonly kind: StreamHandleKind;
  readonly providerId: ProviderId | null;
  readonly sourceRevision: SourceRevision | null;
  readonly binding: SourceBinding;
  /** Advertised load deadline (epoch ms) or null. */
  readonly expiresAt: number | null;
  /** Record kept (for in-flight range requests) until this epoch ms. */
  readonly retainUntil: number;
  readonly createdAt: number;
}

export interface StreamHandleStore {
  insert(record: StreamHandleRecord): void;
  get(token: string): StreamHandleRecord | null;
  /** Marks every handle of a provider whose binding matches as no longer loadable. */
  revokeWhere(providerId: ProviderId, predicate: (binding: SourceBinding) => boolean): number;
  deleteRetainedBefore(before: number): number;
  referencedVoiceKeys(): ReadonlySet<string>;
}

export interface ResolvedSourceRecord {
  readonly sourceRevision: SourceRevision;
  readonly track: TrackRef;
  readonly legacyTrackId: string | null;
  readonly recordingId: RecordingId;
  readonly confidence: RecordingConfidence;
  readonly duration: DurationInfo;
  readonly binding: SourceBinding;
  readonly firstSeenAt: number;
  readonly lastSeenAt: number;
}

export interface ResolvedSourceStore {
  upsert(record: ResolvedSourceRecord): void;
  get(sourceRevision: SourceRevision): ResolvedSourceRecord | null;
}

export interface LyricsAssetStore {
  get(sourceRevision: SourceRevision): LyricsAvailability | null;
  put(sourceRevision: SourceRevision, result: LyricsAvailability, at: number): void;
}

export interface StartedFact {
  readonly idempotencyKey: IdempotencyKey;
  readonly itemId: QueueItemId;
  readonly executorInstanceId: ExecutorInstanceId;
  readonly track: TrackRef;
  readonly legacyTrackId: string | null;
  readonly recordingId: RecordingId;
  readonly sourceRevision: SourceRevision;
  readonly loadId: LoadId;
  readonly positionMs: number;
  /** Executor-reported wall time (ISO). */
  readonly startedAt: string;
  readonly receivedAt: number;
  /** True when the revision matched a source this server resolved. */
  readonly sourceVerified: boolean;
}

export interface StartedStore {
  /** Idempotent by idempotency key and by item: a second report for either is a duplicate. */
  record(fact: StartedFact): "recorded" | "duplicate";
  recent(limit: number): readonly StartedFact[];
}

export interface ListeningHistoryPort {
  /** Most recent first. `legacy` rows are old "selected" plays, not confirmed playback. */
  recentRefs(limit: number): { readonly started: readonly TrackRef[]; readonly legacy: readonly TrackRef[] };
}

export interface ReservationStore {
  reserve(entry: { itemId: QueueItemId; preparationId: PreparationId; track: TrackRef; until: number; at: number }): void;
  release(itemId: QueueItemId): void;
  releasePreparation(preparationId: PreparationId): void;
  /** Keeps the ref excluded until `until` (failed source), detached from any item. */
  coolDown(preparationId: PreparationId, until: number): void;
  activeRefs(now: number): readonly TrackRef[];
  deleteExpired(now: number): number;
}

export interface CandidateAudit {
  readonly preparationId: PreparationId;
  readonly itemId: QueueItemId;
  readonly selected: TrackRef;
  readonly policy: string;
  readonly reason: string;
  readonly considered: readonly { readonly ref: TrackRef; readonly score: number }[];
  readonly createdAt: number;
}

export interface CandidateAuditStore {
  insert(audit: CandidateAudit): void;
  recent(limit: number): readonly CandidateAudit[];
}
