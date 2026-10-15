import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, runMigrations, schemaVersion } from "../adapters/sqlite/migrations.ts";
import { backupState } from "../adapters/sqlite/backup.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-migrations-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
}

test("migrating an old-shape database twice is additive and idempotent", () => {
  const db = new DatabaseSync(path.join(dir, "old.sqlite"));
  // Oldest known shape: tracks without source/playable, plays without semantics.
  db.exec(`
    CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
      file_path TEXT NOT NULL UNIQUE, folder TEXT NOT NULL, extension TEXT NOT NULL, size INTEGER NOT NULL, added_at TEXT NOT NULL);
    CREATE TABLE plays (id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL, played_at TEXT NOT NULL, reason TEXT, dj_line TEXT,
      FOREIGN KEY(track_id) REFERENCES tracks(id));
    INSERT INTO tracks VALUES ('legacy-1', 'T', 'A', 'B', '/music/a.mp3', 'x', 'mp3', 1, '2026-01-01T00:00:00.000Z');
    INSERT INTO plays (track_id, played_at, reason, dj_line) VALUES ('legacy-1', '2026-01-02T00:00:00.000Z', 'old', 'line');
  `);
  assert.deepEqual(runMigrations(db), [1, 2, 3, 4]);
  assert.deepEqual(runMigrations(db), [], "second run applies nothing");
  assert.equal(schemaVersion(db), CURRENT_SCHEMA_VERSION);
  assert.ok(columns(db, "tracks").includes("source"));
  assert.ok(columns(db, "tracks").includes("playable"));
  const play = db.prepare("SELECT * FROM plays").get();
  assert.equal(play.track_id, "legacy-1", "old rows and ids are kept");
  assert.equal(play.semantics, "legacy-selection", "old plays are labelled as selections, not listens");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playback_started").get().n, 0, "no legacy row is upgraded into a started fact");
  assert.equal(db.prepare("SELECT source FROM tracks WHERE id = 'legacy-1'").get().source, "main");
  db.close();
});

test("a failing migration rolls back completely and records no version", () => {
  const db = new DatabaseSync(path.join(dir, "fail.sqlite"));
  runMigrations(db, MIGRATIONS.filter((migration) => migration.version === 1));
  const failing = {
    version: 2,
    name: "half-done",
    up(target) {
      target.exec("CREATE TABLE half_done (id INTEGER)");
      target.exec("ALTER TABLE plays ADD COLUMN semantics TEXT");
      throw new Error("boom");
    }
  };
  assert.throws(() => runMigrations(db, [...MIGRATIONS.filter((m) => m.version === 1), failing]), /migration 2 \(half-done\) failed: boom/);
  assert.equal(schemaVersion(db), 1);
  assert.equal(tables(db).includes("half_done"), false);
  assert.equal(columns(db, "plays").includes("semantics"), false);
  // The real migration still applies afterwards.
  assert.deepEqual(runMigrations(db), [2, 3, 4]);
  db.close();
});

test("lyrics cached before the parser version existed stay but are marked as version 0", () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, MIGRATIONS.filter((migration) => migration.version <= 2));
  db.prepare("INSERT INTO lyrics_assets (source_revision, availability_json, created_at) VALUES ('rev-old', '{}', 1)").run();
  assert.deepEqual(runMigrations(db, MIGRATIONS.filter((migration) => migration.version <= 3)), [3]);
  assert.deepEqual(db.prepare("SELECT source_revision, availability_json, parser_version FROM lyrics_assets").all().map((row) => ({ ...row })), [
    { source_revision: "rev-old", availability_json: "{}", parser_version: 0 }
  ]);
  db.close();
});

test("v4 adds identity, activation and scrub columns as NULLs; old rows keep their meaning; a failing v4 rolls back", () => {
  const db = new DatabaseSync(path.join(dir, "v3.sqlite"));
  runMigrations(db, MIGRATIONS.filter((migration) => migration.version <= 3));
  db.prepare("INSERT INTO local_content_fingerprints (file_path, size, mtime_ms, sha256, duration_json, computed_at) VALUES ('/m/a.wav', 9, 5, 'abc', '{}', 1)").run();
  db.prepare("INSERT INTO playback_stream_handles (token, kind, provider_id, source_revision, binding_json, expires_at, retain_until, created_at) VALUES ('t', 'media', 'p', 'r', '{}', 10, 20, 1)").run();
  db.prepare(`INSERT INTO playback_resolved_sources (source_revision, provider_id, media_id, track_id, recording_id, confidence, duration_json, binding_json, first_seen_at, last_seen_at)
    VALUES ('r', 'p', 'm', NULL, 'rec', 'content-hash', '{}', '{"hash":"h"}', 1, 2)`).run();
  const before = (sql) => db.prepare(sql).all().map((row) => ({ ...row }));
  const snapshot = () => ({
    fingerprints: before("SELECT * FROM local_content_fingerprints"),
    handles: before("SELECT * FROM playback_stream_handles"),
    sources: before("SELECT * FROM playback_resolved_sources")
  });
  const v3 = snapshot();

  const failing = { version: 4, name: "half-v4", up(target) { MIGRATIONS.find((m) => m.version === 4).up(target); throw new Error("boom"); } };
  assert.throws(() => runMigrations(db, [...MIGRATIONS.filter((m) => m.version <= 3), failing]), /migration 4 \(half-v4\) failed: boom/);
  assert.equal(schemaVersion(db), 3);
  assert.deepEqual(snapshot(), v3, "a failed v4 leaves the v3 shape and rows untouched");
  assert.equal(columns(db, "playback_stream_handles").includes("first_opened_at"), false);

  assert.deepEqual(runMigrations(db), [4]);
  assert.deepEqual(runMigrations(db), [], "second run applies nothing");
  for (const column of ["dev", "ino", "mtime_ns", "ctime_ns"]) assert.ok(columns(db, "local_content_fingerprints").includes(column));
  const after = snapshot();
  assert.deepEqual(after.fingerprints, [{ ...v3.fingerprints[0], dev: null, ino: null, mtime_ns: null, ctime_ns: null }], "an old fingerprint has no identity and so never matches");
  assert.deepEqual(after.handles, [{ ...v3.handles[0], first_opened_at: null }]);
  assert.deepEqual(after.sources, [{ ...v3.sources[0], expires_at: null, binding_scrubbed_at: null }], "identity rows are kept as they were");
  db.close();
});

test("backup inventory is a dry run by default; execute takes a consistent copy", () => {
  const dataDir = path.join(dir, "state");
  fs.mkdirSync(path.join(dataDir, "tts"), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "radio.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  db.exec("INSERT INTO tracks (id, title, artist, album, file_path, folder, extension, size, added_at) VALUES ('t', 'T', 'A', 'B', '/x', 'x', 'mp3', 1, 'now')");
  fs.writeFileSync(path.join(dataDir, "kugou-session.json"), "{}");
  fs.writeFileSync(path.join(dataDir, "tts", "a.mp3"), "x");
  const out = path.join(dir, "backup");

  const dry = backupState({ dataDir }, out, { execute: false });
  assert.equal(dry.executed, false);
  assert.equal(fs.existsSync(out), false, "dry run writes nothing");
  assert.deepEqual(dry.entries.map((entry) => entry.role).sort(), [
    "KuGou login session",
    "legacy TTS cache",
    "main database (tracks, tastes, legacy plays/picks/audits, chat, memories, v1 playback tables)"
  ]);

  const manifest = backupState({ dataDir }, out, { execute: true });
  db.close();
  assert.equal(manifest.sqliteSchemaVersion, CURRENT_SCHEMA_VERSION);
  const copy = new DatabaseSync(path.join(out, "data", "radio.sqlite"), { readOnly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM tracks").get().n, 1, "WAL contents are in the snapshot");
  copy.close();
  assert.ok(fs.existsSync(path.join(out, "manifest.json")));
  assert.throws(() => backupState({ dataDir }, out, { execute: true }), /not empty/);
});
