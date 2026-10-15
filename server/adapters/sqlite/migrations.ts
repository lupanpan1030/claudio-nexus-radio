import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: DatabaseSync): void;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  return rows.some((row) => String(row.name) === column);
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * Additive only: legacy tables, ids, foreign keys and rows are kept. New
 * playback facts live in new tables; legacy `plays` rows are labelled as old
 * selection records rather than upgraded into confirmed listens.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "legacy-baseline",
    up(db) {
      // Same shape the legacy server creates at import; recorded so older files converge.
      db.exec(`
        CREATE TABLE IF NOT EXISTS tracks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
          file_path TEXT NOT NULL UNIQUE, folder TEXT NOT NULL, extension TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'main', playable INTEGER NOT NULL DEFAULT 1,
          size INTEGER NOT NULL, added_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS plays (
          id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL, played_at TEXT NOT NULL,
          reason TEXT, dj_line TEXT, FOREIGN KEY(track_id) REFERENCES tracks(id)
        );
        CREATE TABLE IF NOT EXISTS tastes (
          id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL, action TEXT NOT NULL,
          created_at TEXT NOT NULL, FOREIGN KEY(track_id) REFERENCES tracks(id)
        );
        CREATE TABLE IF NOT EXISTS radio_picks (
          id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL, dj_line TEXT NOT NULL,
          reason TEXT NOT NULL, mood_tags TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
          FOREIGN KEY(track_id) REFERENCES tracks(id)
        );
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS app_state (
          state_key TEXT PRIMARY KEY, state_value TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS recommendation_audits (
          id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, query TEXT NOT NULL,
          selected_track_id TEXT NOT NULL, selected_title TEXT NOT NULL, selected_artist TEXT NOT NULL,
          family TEXT NOT NULL, source TEXT NOT NULL, dj_line TEXT NOT NULL, reason TEXT NOT NULL,
          score_breakdown TEXT NOT NULL, candidates TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kugou_playlists (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, track_count INTEGER NOT NULL, synced_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kugou_playlist_tracks (
          playlist_id TEXT NOT NULL, track_id TEXT NOT NULL, position INTEGER NOT NULL,
          PRIMARY KEY (playlist_id, track_id),
          FOREIGN KEY(playlist_id) REFERENCES kugou_playlists(id), FOREIGN KEY(track_id) REFERENCES tracks(id)
        );
        CREATE TABLE IF NOT EXISTS generated_playlist_tracks (
          id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT NOT NULL, track_id TEXT NOT NULL,
          generated_at TEXT NOT NULL, FOREIGN KEY(track_id) REFERENCES tracks(id)
        );
      `);
      addColumnIfMissing(db, "tracks", "source", "TEXT NOT NULL DEFAULT 'main'");
      addColumnIfMissing(db, "tracks", "playable", "INTEGER NOT NULL DEFAULT 1");
    }
  },
  {
    version: 2,
    name: "playback-v1",
    up(db) {
      // Old rows were written when a track was *selected*; keep them, labelled.
      addColumnIfMissing(db, "plays", "semantics", "TEXT NOT NULL DEFAULT 'legacy-selection'");
      db.exec(`
        CREATE TABLE IF NOT EXISTS playback_started (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          idempotency_key TEXT NOT NULL UNIQUE,
          item_id TEXT NOT NULL UNIQUE,
          executor_instance_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          media_id TEXT NOT NULL,
          track_id TEXT REFERENCES tracks(id),
          recording_id TEXT NOT NULL,
          source_revision TEXT NOT NULL,
          load_id TEXT NOT NULL,
          position_ms REAL NOT NULL,
          started_at TEXT NOT NULL,
          received_at INTEGER NOT NULL,
          source_verified INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS playback_started_received ON playback_started(received_at);

        CREATE TABLE IF NOT EXISTS playback_preparations (
          preparation_id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          request_json TEXT NOT NULL,
          version INTEGER NOT NULL,
          status TEXT NOT NULL,
          stages_json TEXT NOT NULL,
          cue_id TEXT,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          owner_instance TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS playback_preparations_item ON playback_preparations(item_id, created_at);
        CREATE INDEX IF NOT EXISTS playback_preparations_status ON playback_preparations(status);

        CREATE TABLE IF NOT EXISTS playback_cues (
          cue_id TEXT PRIMARY KEY,
          transition_id TEXT NOT NULL,
          preparation_id TEXT,
          from_item_id TEXT NOT NULL,
          to_item_id TEXT NOT NULL,
          from_track_json TEXT NOT NULL,
          to_track_json TEXT NOT NULL,
          from_revision TEXT,
          to_revision TEXT,
          version INTEGER NOT NULL,
          script_json TEXT NOT NULL,
          voice_json TEXT NOT NULL,
          settled INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS narration_scripts (
          asset_id TEXT PRIMARY KEY,
          cue_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          text TEXT NOT NULL,
          writer TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS voice_cache (
          content_key TEXT PRIMARY KEY,
          file_name TEXT NOT NULL,
          bytes INTEGER NOT NULL,
          duration_json TEXT NOT NULL,
          descriptor TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS playback_stream_handles (
          token TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          provider_id TEXT,
          source_revision TEXT,
          binding_json TEXT NOT NULL,
          expires_at INTEGER,
          retain_until INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS playback_stream_handles_retain ON playback_stream_handles(retain_until);

        CREATE TABLE IF NOT EXISTS playback_resolved_sources (
          source_revision TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          media_id TEXT NOT NULL,
          track_id TEXT REFERENCES tracks(id),
          recording_id TEXT NOT NULL,
          confidence TEXT NOT NULL,
          duration_json TEXT NOT NULL,
          binding_json TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS playback_resolved_sources_media ON playback_resolved_sources(provider_id, media_id);

        CREATE TABLE IF NOT EXISTS lyrics_assets (
          source_revision TEXT PRIMARY KEY,
          availability_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS playback_candidate_reservations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_id TEXT,
          preparation_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          media_id TEXT NOT NULL,
          status TEXT NOT NULL,
          reserved_at INTEGER NOT NULL,
          until INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS playback_candidate_reservations_item ON playback_candidate_reservations(item_id);

        CREATE TABLE IF NOT EXISTS playback_candidate_audits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          preparation_id TEXT NOT NULL,
          item_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          media_id TEXT NOT NULL,
          policy TEXT NOT NULL,
          reason TEXT NOT NULL,
          considered_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS local_content_fingerprints (
          file_path TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          mtime_ms INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          duration_json TEXT NOT NULL,
          computed_at INTEGER NOT NULL
        );
      `);
    }
  }
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);

export function schemaVersion(db: DatabaseSync): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null } | undefined;
  return Number(row?.version ?? 0);
}

/**
 * Applies pending migrations, each in its own IMMEDIATE transaction together
 * with its version row; a failing migration rolls back completely and stops.
 */
export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS, now: () => Date = () => new Date()): number[] {
  const applied: number[] = [];
  let current = schemaVersion(db);
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        now().toISOString()
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : error}`, { cause: error });
    }
    current = migration.version;
    applied.push(migration.version);
  }
  return applied;
}
