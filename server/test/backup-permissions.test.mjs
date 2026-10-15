import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { backupState } from "../adapters/sqlite/backup.ts";
import { runMigrations } from "../adapters/sqlite/migrations.ts";

// Temporary fixtures only: a permissive umask reproduces the 0644/0775 leak the old copy produced.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-backup-perms-"));
let previousUmask;
before(() => {
  previousUmask = process.umask(0o002);
});
after(() => {
  process.umask(previousUmask);
  fs.rmSync(root, { recursive: true, force: true });
});

const mode = (file) => fs.lstatSync(file).mode & 0o777;

function fixture(name) {
  const base = path.join(root, name);
  const dataDir = path.join(base, "data");
  const profileDir = path.join(base, "profile");
  const inboxDir = path.join(base, "inbox");
  fs.mkdirSync(path.join(dataDir, "tts"), { recursive: true, mode: 0o775 });
  fs.mkdirSync(path.join(dataDir, "tts-v2", "nested"), { recursive: true, mode: 0o775 });
  fs.mkdirSync(path.join(profileDir, "docs"), { recursive: true, mode: 0o775 });
  fs.mkdirSync(inboxDir, { mode: 0o775 });
  const dbPath = path.join(dataDir, "radio.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  db.exec("INSERT INTO tracks (id, title, artist, album, file_path, folder, extension, size, added_at) VALUES ('t', 'T', 'A', 'B', '/x', 'x', 'mp3', 1, 'now')");
  fs.chmodSync(dbPath, 0o600);
  fs.writeFileSync(path.join(dataDir, "kugou-session.json"), '{"cookie":"secret"}', { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, "playback-source-cache-v2.json"), "{}", { mode: 0o664 });
  fs.writeFileSync(path.join(dataDir, "tts", "a.mp3"), "voice", { mode: 0o664 });
  fs.writeFileSync(path.join(dataDir, "tts-v2", "nested", "b.wav"), "voice2", { mode: 0o664 });
  fs.writeFileSync(path.join(profileDir, "docs", "taste.md"), "private taste", { mode: 0o664 });
  fs.writeFileSync(path.join(base, "outside.txt"), "not part of the profile", { mode: 0o664 });
  fs.symlinkSync(path.join(base, "outside.txt"), path.join(profileDir, "docs", "link.txt"));
  fs.writeFileSync(path.join(inboxDir, "list.txt"), "x", { mode: 0o664 });
  return { base, dataDir, profileDir, inboxDir, db, locations: { dataDir, userProfileDir: profileDir, inboxDir } };
}

function walk(dir) {
  const found = [{ path: dir, dir: true }];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push({ path: full, dir: false, symlink: entry.isSymbolicLink() });
  }
  return found;
}

test("an executed backup is private from creation: every directory 0700, every file 0600 (SQLite included)", () => {
  const fx = fixture("execute");
  const out = path.join(fx.base, "backups", "new", "run-1");
  const vacuumTargets = [];
  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    const target = /^VACUUM INTO '(.+)'$/.exec(sql)?.[1];
    // At the moment SQLite writes the snapshot, its file and directory are already private.
    if (target) vacuumTargets.push({ file: mode(target), dir: mode(path.dirname(target)), root: mode(out) });
    return originalExec.call(this, sql);
  };
  let manifest;
  try {
    manifest = backupState(fx.locations, out, { execute: true });
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    fx.db.close();
  }
  assert.deepEqual(vacuumTargets, [{ file: 0o600, dir: 0o700, root: 0o700 }]);
  const entries = walk(out);
  assert.equal(entries.some((entry) => entry.symlink), false, "symlinks are not copied");
  for (const entry of entries) assert.equal(mode(entry.path), entry.dir ? 0o700 : 0o600, entry.path);
  for (const created of [path.join(fx.base, "backups"), path.join(fx.base, "backups", "new")]) {
    assert.equal(mode(created), 0o700, "missing parents are created by this task, privately");
  }
  assert.equal(fs.readFileSync(path.join(out, "data", "kugou-session.json"), "utf8"), '{"cookie":"secret"}');
  assert.equal(fs.readFileSync(path.join(out, "user-profile", "docs", "taste.md"), "utf8"), "private taste");
  assert.equal(fs.readFileSync(path.join(out, "data", "tts-v2", "nested", "b.wav"), "utf8"), "voice2");
  const copy = new DatabaseSync(path.join(out, "data", "radio.sqlite"), { readOnly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM tracks").get().n, 1);
  copy.close();
  const profile = manifest.entries.find((entry) => entry.target.endsWith("user-profile"));
  assert.deepEqual([profile.files, profile.skipped], [1, 1], "the symlink is neither counted nor copied");
  // Modes are only ever set when a path is created; nothing is widened and later narrowed.
  const source = fs.readFileSync(new URL("../adapters/sqlite/backup.ts", import.meta.url), "utf8");
  assert.equal(/fs\.(f?chmod|l?chmodSync|fchmodSync|cpSync|copyFileSync)\b/.test(source), false);
  assert.equal(mode(path.join(fx.dataDir, "radio.sqlite")), 0o600, "the source is untouched");
  assert.equal(mode(path.join(fx.dataDir, "tts")), 0o775);
});

test("an existing empty target must already be private; a wider one is refused and left as it was", () => {
  const fx = fixture("existing");
  fx.db.close();
  const parent = path.join(fx.base, "shared");
  fs.mkdirSync(parent, { mode: 0o775 });
  const open = path.join(parent, "open");
  fs.mkdirSync(open, { mode: 0o775 });
  assert.throws(() => backupState(fx.locations, open, { execute: true }), /accessible to other users \(mode 775\)/);
  assert.deepEqual([mode(open), mode(parent), fs.readdirSync(open)], [0o775, 0o775, []], "no chmod of the target or its parent, nothing copied");

  const closed = path.join(parent, "closed");
  fs.mkdirSync(closed, { mode: 0o700 });
  backupState(fx.locations, closed, { execute: true });
  assert.equal(mode(parent), 0o775, "the user's parent directory is not touched");
  for (const entry of walk(closed)) assert.equal(mode(entry.path), entry.dir ? 0o700 : 0o600, entry.path);

  const file = path.join(parent, "a-file");
  fs.writeFileSync(file, "");
  assert.throws(() => backupState(fx.locations, file, { execute: true }), /not a directory/);
  fs.symlinkSync(closed, path.join(parent, "link"));
  assert.throws(() => backupState(fx.locations, path.join(parent, "link"), { execute: true }), /not a directory|not empty/);
});

test("a dry run creates nothing and changes no permission", () => {
  const fx = fixture("dry");
  fx.db.close();
  const before = new Map(walk(fx.base).map((entry) => [entry.path, fs.lstatSync(entry.path).mode]));
  const out = path.join(fx.base, "dry-out");
  const manifest = backupState(fx.locations, out, { execute: false });
  assert.equal(manifest.executed, false);
  assert.equal(fs.existsSync(out), false);
  const afterwards = new Map(walk(fx.base).map((entry) => [entry.path, fs.lstatSync(entry.path).mode]));
  for (const [file, original] of before) assert.equal(afterwards.get(file), original, `${file} keeps its mode`);
  // Reading the schema version through SQLite may leave its own -wal/-shm sidecars (same mode as the database).
  const added = [...afterwards.keys()].filter((file) => !before.has(file));
  for (const file of added) {
    assert.match(path.basename(file), /^radio\.sqlite-(wal|shm)$/);
    assert.equal(afterwards.get(file) & 0o777, 0o600);
  }
});
