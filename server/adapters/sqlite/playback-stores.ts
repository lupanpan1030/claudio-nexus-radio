import type { DatabaseSync } from "node:sqlite";
import {
  asId,
  type CueId,
  type DurationInfo,
  type ExecutorInstanceId,
  type IdempotencyKey,
  type LoadId,
  type LyricsAvailability,
  type MediaId,
  type PreparationId,
  type PreparationStatusV1,
  type ProviderId,
  type QueueItemId,
  type RecordingConfidence,
  type RecordingId,
  type SourceRevision,
  type TrackRef,
  type TransitionId
} from "@claudio/contracts";
import type { SourceBinding } from "../../ports/media-source.js";
import type {
  CandidateAudit,
  CandidateAuditStore,
  CueRecord,
  CueStore,
  ListeningHistoryPort,
  LyricsAssetStore,
  PreparationRecord,
  PreparationStore,
  ReservationStore,
  ResolvedSourceRecord,
  ResolvedSourceStore,
  ScriptStore,
  StartedFact,
  StartedStore,
  StoredScript,
  StreamHandleRecord,
  StreamHandleStore,
  VoiceCacheEntry,
  VoiceCacheStore
} from "../../ports/stores.js";

type Row = Record<string, unknown>;

const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const ref = (providerId: unknown, mediaId: unknown): TrackRef => ({
  providerId: asId<ProviderId>(String(providerId)),
  mediaId: asId<MediaId>(String(mediaId))
});
const TERMINAL_STATUSES = ["failed", "cancelled", "interrupted", "expired", "ready"];

export class SqlitePreparationStore implements PreparationStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(record: PreparationRecord): void {
    this.db
      .prepare(
        `INSERT INTO playback_preparations (preparation_id, item_id, request_json, version, status, stages_json, cue_id,
           expires_at, created_at, updated_at, owner_instance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.preparationId,
        record.itemId,
        json(record.request),
        record.version,
        record.status,
        json(record.stages),
        record.cueId,
        record.expiresAt,
        record.createdAt,
        record.updatedAt,
        record.ownerInstance
      );
  }

  update(record: PreparationRecord, expectedVersion: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE playback_preparations SET version = ?, status = ?, stages_json = ?, expires_at = ?, updated_at = ?
         WHERE preparation_id = ? AND version = ?`
      )
      .run(record.version, record.status, json(record.stages), record.expiresAt, record.updatedAt, record.preparationId, expectedVersion);
    return Number(result.changes) === 1;
  }

  get(preparationId: PreparationId): PreparationRecord | null {
    const row = this.db.prepare("SELECT * FROM playback_preparations WHERE preparation_id = ?").get(preparationId) as Row | undefined;
    return row ? toPreparation(row) : null;
  }

  latestForItem(itemId: QueueItemId): PreparationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM playback_preparations WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(itemId) as Row | undefined;
    return row ? toPreparation(row) : null;
  }

  listByStatus(statuses: readonly PreparationStatusV1[]): readonly PreparationRecord[] {
    if (statuses.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM playback_preparations WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY created_at`)
      .all(...statuses) as Row[];
    return rows.map(toPreparation);
  }

  deleteExpired(before: number, protectedItems: ReadonlySet<string>): number {
    const rows = this.db
      .prepare(
        `SELECT preparation_id, item_id FROM playback_preparations
         WHERE expires_at < ? AND status IN (${TERMINAL_STATUSES.map(() => "?").join(", ")})`
      )
      .all(before, ...TERMINAL_STATUSES) as Row[];
    const remove = this.db.prepare("DELETE FROM playback_preparations WHERE preparation_id = ?");
    let count = 0;
    for (const row of rows) {
      if (protectedItems.has(String(row.item_id))) continue;
      count += Number(remove.run(String(row.preparation_id)).changes);
    }
    return count;
  }
}

function toPreparation(row: Row): PreparationRecord {
  return {
    preparationId: asId<PreparationId>(String(row.preparation_id)),
    itemId: asId<QueueItemId>(String(row.item_id)),
    request: parse(row.request_json),
    version: Number(row.version),
    status: String(row.status) as PreparationStatusV1,
    stages: parse(row.stages_json),
    cueId: row.cue_id ? asId<CueId>(String(row.cue_id)) : null,
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ownerInstance: String(row.owner_instance)
  };
}

export class SqliteCueStore implements CueStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(record: CueRecord): void {
    this.db
      .prepare(
        `INSERT INTO playback_cues (cue_id, transition_id, preparation_id, from_item_id, to_item_id, from_track_json, to_track_json,
           from_revision, to_revision, version, script_json, voice_json, settled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.cueId,
        record.transitionId,
        record.preparationId,
        record.fromItemId,
        record.toItemId,
        json(record.fromTrack),
        json(record.toTrack),
        record.fromRevision,
        record.toRevision,
        record.version,
        json(record.script),
        json(record.voice),
        settled(record) ? 1 : 0,
        record.createdAt,
        record.updatedAt
      );
  }

  update(record: CueRecord, expectedVersion: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE playback_cues SET version = ?, script_json = ?, voice_json = ?, settled = ?, to_revision = ?, updated_at = ?
         WHERE cue_id = ? AND version = ?`
      )
      .run(record.version, json(record.script), json(record.voice), settled(record) ? 1 : 0, record.toRevision, record.updatedAt, record.cueId, expectedVersion);
    return Number(result.changes) === 1;
  }

  get(cueId: CueId): CueRecord | null {
    const row = this.db.prepare("SELECT * FROM playback_cues WHERE cue_id = ?").get(cueId) as Row | undefined;
    return row ? toCue(row) : null;
  }

  listUnsettled(): readonly CueRecord[] {
    return (this.db.prepare("SELECT * FROM playback_cues WHERE settled = 0").all() as Row[]).map(toCue);
  }

  deleteOlderThan(before: number, keepPreparations: ReadonlySet<string>): number {
    const rows = this.db.prepare("SELECT cue_id, preparation_id FROM playback_cues WHERE updated_at < ? AND settled = 1").all(before) as Row[];
    const remove = this.db.prepare("DELETE FROM playback_cues WHERE cue_id = ?");
    let count = 0;
    for (const row of rows) {
      if (row.preparation_id && keepPreparations.has(String(row.preparation_id))) continue;
      count += Number(remove.run(String(row.cue_id)).changes);
    }
    return count;
  }
}

function settled(record: CueRecord): boolean {
  const open = (status: string) => status === "pending" || status === "in-progress";
  return !open(record.script.status) && !open(record.voice.status);
}

function toCue(row: Row): CueRecord {
  return {
    cueId: asId<CueId>(String(row.cue_id)),
    transitionId: asId<TransitionId>(String(row.transition_id)),
    preparationId: row.preparation_id ? asId<PreparationId>(String(row.preparation_id)) : null,
    fromItemId: asId<QueueItemId>(String(row.from_item_id)),
    toItemId: asId<QueueItemId>(String(row.to_item_id)),
    fromTrack: parse(row.from_track_json),
    toTrack: parse(row.to_track_json),
    fromRevision: row.from_revision ? asId<SourceRevision>(String(row.from_revision)) : null,
    toRevision: row.to_revision ? asId<SourceRevision>(String(row.to_revision)) : null,
    version: Number(row.version),
    script: parse(row.script_json),
    voice: parse(row.voice_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

export class SqliteScriptStore implements ScriptStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(entry: StoredScript): void {
    this.db
      .prepare("INSERT INTO narration_scripts (asset_id, cue_id, version, text, writer, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(entry.script.assetId, entry.cueId, entry.script.version, entry.script.text, entry.writer, entry.createdAt);
  }
}

export class SqliteVoiceCacheStore implements VoiceCacheStore {
  constructor(private readonly db: DatabaseSync) {}

  get(contentKey: string): VoiceCacheEntry | null {
    const row = this.db.prepare("SELECT * FROM voice_cache WHERE content_key = ?").get(contentKey) as Row | undefined;
    return row ? toVoice(row) : null;
  }

  put(entry: VoiceCacheEntry): void {
    this.db
      .prepare(
        `INSERT INTO voice_cache (content_key, file_name, bytes, duration_json, descriptor, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(content_key) DO UPDATE SET file_name = excluded.file_name, bytes = excluded.bytes,
           duration_json = excluded.duration_json, descriptor = excluded.descriptor, last_used_at = excluded.last_used_at`
      )
      .run(entry.contentKey, entry.fileName, entry.bytes, json(entry.duration), entry.descriptor, entry.createdAt, entry.lastUsedAt);
  }

  touch(contentKey: string, at: number): void {
    this.db.prepare("UPDATE voice_cache SET last_used_at = ? WHERE content_key = ?").run(at, contentKey);
  }

  remove(contentKey: string): void {
    this.db.prepare("DELETE FROM voice_cache WHERE content_key = ?").run(contentKey);
  }

  listUnusedSince(before: number): readonly VoiceCacheEntry[] {
    return (this.db.prepare("SELECT * FROM voice_cache WHERE last_used_at < ?").all(before) as Row[]).map(toVoice);
  }
}

function toVoice(row: Row): VoiceCacheEntry {
  return {
    contentKey: String(row.content_key),
    fileName: String(row.file_name),
    bytes: Number(row.bytes),
    duration: parse<DurationInfo>(row.duration_json),
    descriptor: String(row.descriptor),
    createdAt: Number(row.created_at),
    lastUsedAt: Number(row.last_used_at)
  };
}

export class SqliteStreamHandleStore implements StreamHandleStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(record: StreamHandleRecord): void {
    this.db
      .prepare(
        `INSERT INTO playback_stream_handles (token, kind, provider_id, source_revision, binding_json, expires_at, retain_until, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(record.token, record.kind, record.providerId, record.sourceRevision, json(record.binding), record.expiresAt, record.retainUntil, record.createdAt);
  }

  get(token: string): StreamHandleRecord | null {
    const row = this.db.prepare("SELECT * FROM playback_stream_handles WHERE token = ?").get(token) as Row | undefined;
    if (!row) return null;
    return {
      token: String(row.token),
      kind: row.kind === "voice" ? "voice" : "media",
      providerId: row.provider_id ? asId<ProviderId>(String(row.provider_id)) : null,
      sourceRevision: row.source_revision ? asId<SourceRevision>(String(row.source_revision)) : null,
      binding: parse<SourceBinding>(row.binding_json),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      retainUntil: Number(row.retain_until),
      createdAt: Number(row.created_at)
    };
  }

  revokeWhere(providerId: ProviderId, predicate: (binding: SourceBinding) => boolean): number {
    const rows = this.db.prepare("SELECT token, binding_json FROM playback_stream_handles WHERE provider_id = ?").all(providerId) as Row[];
    const update = this.db.prepare("UPDATE playback_stream_handles SET binding_json = ? WHERE token = ?");
    let count = 0;
    for (const row of rows) {
      const binding = parse<SourceBinding>(row.binding_json);
      if (binding.revoked === true || !predicate(binding)) continue;
      update.run(json({ ...binding, revoked: true }), String(row.token));
      count += 1;
    }
    return count;
  }

  deleteRetainedBefore(before: number): number {
    return Number(this.db.prepare("DELETE FROM playback_stream_handles WHERE retain_until < ?").run(before).changes);
  }

  referencedVoiceKeys(): ReadonlySet<string> {
    const rows = this.db.prepare("SELECT binding_json FROM playback_stream_handles WHERE kind = 'voice'").all() as Row[];
    return new Set(rows.map((row) => String(parse<SourceBinding>(row.binding_json).contentKey ?? "")));
  }
}

export class SqliteResolvedSourceStore implements ResolvedSourceStore {
  constructor(private readonly db: DatabaseSync) {}

  upsert(record: ResolvedSourceRecord): void {
    this.db
      .prepare(
        `INSERT INTO playback_resolved_sources (source_revision, provider_id, media_id, track_id, recording_id, confidence,
           duration_json, binding_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_revision) DO UPDATE SET binding_json = excluded.binding_json,
           duration_json = excluded.duration_json, last_seen_at = excluded.last_seen_at`
      )
      .run(
        record.sourceRevision,
        record.track.providerId,
        record.track.mediaId,
        record.legacyTrackId,
        record.recordingId,
        record.confidence,
        json(record.duration),
        json(record.binding),
        record.firstSeenAt,
        record.lastSeenAt
      );
  }

  get(sourceRevision: SourceRevision): ResolvedSourceRecord | null {
    const row = this.db.prepare("SELECT * FROM playback_resolved_sources WHERE source_revision = ?").get(sourceRevision) as Row | undefined;
    if (!row) return null;
    return {
      sourceRevision: asId<SourceRevision>(String(row.source_revision)),
      track: ref(row.provider_id, row.media_id),
      legacyTrackId: row.track_id ? String(row.track_id) : null,
      recordingId: asId<RecordingId>(String(row.recording_id)),
      confidence: String(row.confidence) as RecordingConfidence,
      duration: parse<DurationInfo>(row.duration_json),
      binding: parse<SourceBinding>(row.binding_json),
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at)
    };
  }
}

export class SqliteLyricsAssetStore implements LyricsAssetStore {
  constructor(private readonly db: DatabaseSync) {}

  get(sourceRevision: SourceRevision): LyricsAvailability | null {
    const row = this.db.prepare("SELECT availability_json FROM lyrics_assets WHERE source_revision = ?").get(sourceRevision) as Row | undefined;
    return row ? parse<LyricsAvailability>(row.availability_json) : null;
  }

  put(sourceRevision: SourceRevision, result: LyricsAvailability, at: number): void {
    this.db
      .prepare(
        `INSERT INTO lyrics_assets (source_revision, availability_json, created_at) VALUES (?, ?, ?)
         ON CONFLICT(source_revision) DO UPDATE SET availability_json = excluded.availability_json, created_at = excluded.created_at`
      )
      .run(sourceRevision, json(result), at);
  }
}

export class SqliteStartedStore implements StartedStore, ListeningHistoryPort {
  constructor(
    private readonly db: DatabaseSync,
    /** Maps a legacy tracks row to the provider ref it belongs to (composition-owned rule). */
    private readonly legacyRef: (row: { id: string; source: string }) => TrackRef | null
  ) {}

  record(fact: StartedFact): "recorded" | "duplicate" {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO playback_started (idempotency_key, item_id, executor_instance_id, provider_id, media_id, track_id,
           recording_id, source_revision, load_id, position_ms, started_at, received_at, source_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        fact.idempotencyKey,
        fact.itemId,
        fact.executorInstanceId,
        fact.track.providerId,
        fact.track.mediaId,
        fact.legacyTrackId,
        fact.recordingId,
        fact.sourceRevision,
        fact.loadId,
        fact.positionMs,
        fact.startedAt,
        fact.receivedAt,
        fact.sourceVerified ? 1 : 0
      );
    return Number(result.changes) === 1 ? "recorded" : "duplicate";
  }

  recent(limit: number): readonly StartedFact[] {
    const rows = this.db.prepare("SELECT * FROM playback_started ORDER BY received_at DESC, id DESC LIMIT ?").all(limit) as Row[];
    return rows.map((row) => ({
      idempotencyKey: asId<IdempotencyKey>(String(row.idempotency_key)),
      itemId: asId<QueueItemId>(String(row.item_id)),
      executorInstanceId: asId<ExecutorInstanceId>(String(row.executor_instance_id)),
      track: ref(row.provider_id, row.media_id),
      legacyTrackId: row.track_id ? String(row.track_id) : null,
      recordingId: asId<RecordingId>(String(row.recording_id)),
      sourceRevision: asId<SourceRevision>(String(row.source_revision)),
      loadId: asId<LoadId>(String(row.load_id)),
      positionMs: Number(row.position_ms),
      startedAt: String(row.started_at),
      receivedAt: Number(row.received_at),
      sourceVerified: Number(row.source_verified) === 1
    }));
  }

  recentRefs(limit: number): { started: readonly TrackRef[]; legacy: readonly TrackRef[] } {
    const started = this.recent(limit).map((fact) => fact.track);
    const legacyRows = this.db
      .prepare(
        `SELECT tracks.id AS id, tracks.source AS source FROM plays
         JOIN tracks ON tracks.id = plays.track_id ORDER BY plays.played_at DESC LIMIT ?`
      )
      .all(limit) as Row[];
    const legacy = legacyRows
      .map((row) => this.legacyRef({ id: String(row.id), source: String(row.source) }))
      .filter((value): value is TrackRef => value !== null);
    return { started, legacy };
  }
}

export class SqliteReservationStore implements ReservationStore {
  constructor(private readonly db: DatabaseSync) {}

  reserve(entry: { itemId: QueueItemId; preparationId: PreparationId; track: TrackRef; until: number; at: number }): void {
    this.release(entry.itemId);
    this.db
      .prepare(
        `INSERT INTO playback_candidate_reservations (item_id, preparation_id, provider_id, media_id, status, reserved_at, until)
         VALUES (?, ?, ?, ?, 'reserved', ?, ?)`
      )
      .run(entry.itemId, entry.preparationId, entry.track.providerId, entry.track.mediaId, entry.at, entry.until);
  }

  release(itemId: QueueItemId): void {
    this.db.prepare("DELETE FROM playback_candidate_reservations WHERE item_id = ? AND status = 'reserved'").run(itemId);
  }

  releasePreparation(preparationId: PreparationId): void {
    this.db.prepare("DELETE FROM playback_candidate_reservations WHERE preparation_id = ? AND status = 'reserved'").run(preparationId);
  }

  coolDown(preparationId: PreparationId, until: number): void {
    this.db
      .prepare("UPDATE playback_candidate_reservations SET status = 'cooldown', item_id = NULL, until = ? WHERE preparation_id = ?")
      .run(until, preparationId);
  }

  activeRefs(now: number): readonly TrackRef[] {
    const rows = this.db.prepare("SELECT provider_id, media_id FROM playback_candidate_reservations WHERE until > ?").all(now) as Row[];
    return rows.map((row) => ref(row.provider_id, row.media_id));
  }

  deleteExpired(now: number): number {
    return Number(this.db.prepare("DELETE FROM playback_candidate_reservations WHERE until <= ?").run(now).changes);
  }
}

export class SqliteCandidateAuditStore implements CandidateAuditStore {
  constructor(private readonly db: DatabaseSync) {}

  insert(audit: CandidateAudit): void {
    this.db
      .prepare(
        `INSERT INTO playback_candidate_audits (preparation_id, item_id, provider_id, media_id, policy, reason, considered_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(audit.preparationId, audit.itemId, audit.selected.providerId, audit.selected.mediaId, audit.policy, audit.reason, json(audit.considered), audit.createdAt);
  }

  recent(limit: number): readonly CandidateAudit[] {
    const rows = this.db.prepare("SELECT * FROM playback_candidate_audits ORDER BY created_at DESC, id DESC LIMIT ?").all(limit) as Row[];
    return rows.map((row) => ({
      preparationId: asId<PreparationId>(String(row.preparation_id)),
      itemId: asId<QueueItemId>(String(row.item_id)),
      selected: ref(row.provider_id, row.media_id),
      policy: String(row.policy),
      reason: String(row.reason),
      considered: parse(row.considered_json),
      createdAt: Number(row.created_at)
    }));
  }
}

/** All playback stores over one connection (the composition root owns the connection). */
export function createSqlitePlaybackStores(db: DatabaseSync, legacyRef: (row: { id: string; source: string }) => TrackRef | null) {
  const started = new SqliteStartedStore(db, legacyRef);
  return {
    preparations: new SqlitePreparationStore(db),
    cues: new SqliteCueStore(db),
    scripts: new SqliteScriptStore(db),
    voiceCache: new SqliteVoiceCacheStore(db),
    handles: new SqliteStreamHandleStore(db),
    resolvedSources: new SqliteResolvedSourceStore(db),
    lyrics: new SqliteLyricsAssetStore(db),
    started,
    history: started as ListeningHistoryPort,
    reservations: new SqliteReservationStore(db),
    audits: new SqliteCandidateAuditStore(db)
  };
}
