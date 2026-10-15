import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { LocalFingerprints, LocalMediaSource, LocalSidecarLyrics } from "../adapters/local/local-source.ts";
import { runMigrations } from "../adapters/sqlite/migrations.ts";
import { LegacyTrackCatalog, TrackRowReader } from "../adapters/sqlite/track-catalog.ts";
import { makeWav } from "../testing/wav.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-local-source-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const library = path.join(dir, "music");
fs.mkdirSync(library);
const songPath = path.join(library, "Artist - Song.wav");
fs.writeFileSync(songPath, makeWav(1500, { seed: 3 }));
fs.writeFileSync(path.join(library, "Artist - Song.lrc"), "[00:01.00]第一句\n");
const outside = path.join(dir, "outside.wav");
fs.writeFileSync(outside, makeWav(500));

const db = new DatabaseSync(":memory:");
runMigrations(db);
const insert = db.prepare(
  "INSERT INTO tracks (id, title, artist, album, file_path, folder, extension, source, playable, size, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);
insert.run("song", "Song", "Artist", "music", songPath, "music", "wav", "main", 1, 1, "2026-10-16T00:00:00Z");
insert.run("cache", "Cached", "Artist", "music", path.join(library, "x.kgma"), "music", "kgma", "kugou-cache", 0, 1, "2026-10-16T00:00:00Z");
insert.run("outside", "Out", "Artist", "x", outside, "x", "wav", "main", 1, 1, "2026-10-16T00:00:00Z");
insert.run("remote", "Remote", "Artist", "x", "kugou://abc", "x", "remote", "kugou-api", 1, 0, "2026-10-16T00:00:00Z");

const rows = new TrackRowReader(db);
const source = new LocalMediaSource({ rows, sources: ["main", "kugou-cache"], fingerprints: new LocalFingerprints(db), libraryDir: library });
const ref = (mediaId) => ({ providerId: "local", mediaId });
const ctx = () => ({ signal: new AbortController().signal, reason: "initial", previous: null });

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream.body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("local catalog only describes its own sources and hides locators", () => {
  const catalog = new LegacyTrackCatalog(rows, "local", ["main", "kugou-cache"]);
  const entry = catalog.describe(ref("song"));
  assert.deepEqual(entry, {
    ref: { providerId: "local", mediaId: "song" },
    display: { title: "Song", artist: "Artist", album: "music" },
    playable: true,
    legacyTrackId: "song"
  });
  assert.equal(catalog.describe(ref("remote")), null, "a KuGou row is not a local entry");
  assert.equal(catalog.describe({ providerId: "kugou", mediaId: "song" }), null);
});

test("local recording identity is the file content; changes produce a new revision and stop old handles", async () => {
  const first = await source.resolve(ref("song"), ctx());
  assert.equal(first.recording.confidence, "content-hash");
  assert.match(first.sourceRevision, /^lr-[0-9a-f]{40}$/);
  assert.deepEqual(first.duration, { kind: "known", ms: 1500, source: "container-metadata" });
  assert.equal(first.expiresAt, null);
  assert.equal((await source.resolve(ref("song"), ctx())).sourceRevision, first.sourceRevision);

  const ranged = await source.open(first.binding, { range: "bytes=44-53", signal: new AbortController().signal });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers["Content-Range"], `bytes 44-53/${fs.statSync(songPath).size}`);
  assert.equal((await collect(ranged)).length, 10);

  fs.writeFileSync(songPath, makeWav(1500, { seed: 4 }));
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(songPath, future, future);
  await assert.rejects(source.open(first.binding, { range: null, signal: new AbortController().signal }), (error) => error.info.code === "local_file_changed");
  const lyrics = new LocalSidecarLyrics();
  assert.deepEqual(await lyrics.fetch({ binding: first.binding }, { signal: new AbortController().signal }), { kind: "unmatched" });
  const second = await source.resolve(ref("song"), ctx());
  assert.notEqual(second.sourceRevision, first.sourceRevision);
  const sidecar = await lyrics.fetch({ binding: second.binding }, { signal: new AbortController().signal });
  assert.equal(sidecar.kind, "text");
  assert.equal(sidecar.format, "lrc");
  assert.match(sidecar.documentKey, /^local-sidecar:[0-9a-f]{64}$/);
});

test("unplayable, missing and out-of-library files are refused", async () => {
  await assert.rejects(source.resolve(ref("cache"), ctx()), (error) => error.info.code === "track_not_playable");
  await assert.rejects(source.resolve(ref("outside"), ctx()), (error) => error.info.code === "local_file_outside_library");
  await assert.rejects(source.resolve(ref("remote"), ctx()), (error) => error.info.code === "track_not_found");
});

const fixed = new Date("2023-11-14T22:13:20.000Z");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signal = () => new AbortController().signal;

/** A separate library row per case so cases never share a fingerprint row. */
function addSong(id, bytes) {
  const file = path.join(library, `${id}.wav`);
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, fixed, fixed);
  insert.run(id, id, "Artist", "music", file, "music", "wav", "main", 1, bytes.length, "2026-10-16T00:00:00Z");
  return file;
}

test("a same-size replacement that keeps mtime is a different file: old bindings refuse it and resolve never reuses the old hash", async () => {
  const file = addSong("atomic", makeWav(1500, { seed: 11 }));
  const first = await source.resolve(ref("atomic"), ctx());
  const replacement = `${file}.tmp`;
  fs.writeFileSync(replacement, makeWav(1500, { seed: 12 }));
  fs.utimesSync(replacement, fixed, fixed);
  fs.renameSync(replacement, file);
  assert.equal(fs.statSync(file).size, first.binding.size);
  assert.equal(Math.trunc(fs.statSync(file).mtimeMs), fixed.getTime(), "size and mtime look unchanged");

  await assert.rejects(source.open(first.binding, { range: null, signal: signal() }), (error) => error.info.code === "local_file_changed");
  const second = await source.resolve(ref("atomic"), ctx());
  assert.notEqual(second.binding.sha256, first.binding.sha256, "the cached hash of the old file is not reused");
  assert.notEqual(second.sourceRevision, first.sourceRevision);
  assert.notEqual(second.recording.recordingId, first.recording.recordingId);
});

test("an in-place rewrite that restores size and mtime is detected through the change time", async () => {
  const file = addSong("inplace", makeWav(1500, { seed: 21 }));
  const first = await source.resolve(ref("inplace"), ctx());
  await sleep(20);
  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, makeWav(1500, { seed: 22 }), 0, undefined, 0);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.utimesSync(file, fixed, fixed);
  const stat = fs.statSync(file, { bigint: true });
  assert.equal(String(stat.ino), first.binding.ino, "same inode");
  assert.equal(String(stat.mtimeNs), first.binding.mtimeNs, "same mtime");

  await assert.rejects(source.open(first.binding, { range: "bytes=0-9", signal: signal() }), (error) => error.info.code === "local_file_changed");
  const lyrics = new LocalSidecarLyrics();
  assert.deepEqual(await lyrics.fetch({ binding: first.binding }, { signal: signal() }), { kind: "unmatched" });
  const second = await source.resolve(ref("inplace"), ctx());
  assert.notEqual(second.sourceRevision, first.sourceRevision);
});

test("a stream reads the descriptor it verified: replacing the path afterwards does not change the bytes served", async () => {
  const original = makeWav(1500, { seed: 31 });
  const file = addSong("fd-bound", original);
  const resolved = await source.resolve(ref("fd-bound"), ctx());
  const stream = await source.open(resolved.binding, { range: null, signal: signal() });
  const replacement = `${file}.tmp`;
  fs.writeFileSync(replacement, makeWav(1500, { seed: 32 }));
  fs.renameSync(replacement, file);
  assert.deepEqual(new Uint8Array(await collect(stream)), original);
});

test("a binding written before exact file identity is refused as expired, never trusted", async () => {
  addSong("outdated", makeWav(800, { seed: 41 }));
  const resolved = await source.resolve(ref("outdated"), ctx());
  const { dev, ino, mtimeNs, ctimeNs, ...old } = resolved.binding;
  const legacy = { ...old, mtimeMs: fixed.getTime() };
  await assert.rejects(source.open(legacy, { range: null, signal: signal() }), (error) => error.info.class === "expired" && error.info.code === "local_binding_outdated");
  assert.deepEqual(await new LocalSidecarLyrics().fetch({ binding: legacy }, { signal: signal() }), { kind: "unmatched" });
});

test("a pre-v4 fingerprint row (no identity) is never a cache hit", async () => {
  const file = addSong("v3row", makeWav(800, { seed: 51 }));
  const stat = fs.statSync(file);
  db.prepare("INSERT INTO local_content_fingerprints (file_path, size, mtime_ms, sha256, duration_json, computed_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(path.resolve(file), stat.size, Math.trunc(stat.mtimeMs), "f".repeat(64), JSON.stringify({ kind: "unknown" }), 1);
  const resolved = await source.resolve(ref("v3row"), ctx());
  assert.notEqual(resolved.binding.sha256, "f".repeat(64));
  assert.equal(resolved.duration.kind, "known");
});

test("where the file system gives no inode or change time, nothing is trusted by metadata: resolve and open hash the bytes", async () => {
  const weak = (stat) => ({ dev: String(stat.dev), ino: "0", size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: "0" });
  const weakDb = new DatabaseSync(":memory:");
  runMigrations(weakDb);
  const fingerprints = new LocalFingerprints(weakDb, Date.now, weak);
  const weakSource = new LocalMediaSource({ rows, sources: ["main"], fingerprints, libraryDir: library, identityOf: weak });
  const file = addSong("weakfs", makeWav(1500, { seed: 61 }));
  const first = await weakSource.resolve(ref("weakfs"), ctx());
  assert.equal(weakDb.prepare("SELECT COUNT(*) AS n FROM local_content_fingerprints").get().n, 0, "weak identities are never cached");
  const ok = await weakSource.open(first.binding, { range: "bytes=0-3", signal: signal() });
  assert.equal(ok.status, 206);
  await collect(ok);

  const fd = fs.openSync(file, "r+");
  fs.writeSync(fd, makeWav(1500, { seed: 62 }), 0, undefined, 0);
  fs.closeSync(fd);
  fs.utimesSync(file, fixed, fixed);
  await assert.rejects(weakSource.open(first.binding, { range: "bytes=0-3", signal: signal() }), (error) => error.info.code === "local_file_changed");
  assert.notEqual((await weakSource.resolve(ref("weakfs"), ctx())).sourceRevision, first.sourceRevision);
});

test("a file that keeps changing while hashed is refused after a bounded retry and nothing is cached", async () => {
  let tick = 0;
  const unstable = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String((tick += 1)) });
  const unstableDb = new DatabaseSync(":memory:");
  runMigrations(unstableDb);
  const unstableSource = new LocalMediaSource({ rows, sources: ["main"], fingerprints: new LocalFingerprints(unstableDb, Date.now, unstable), libraryDir: library });
  addSong("unstable", makeWav(800, { seed: 71 }));
  await assert.rejects(unstableSource.resolve(ref("unstable"), ctx()), (error) => error.info.code === "local_file_unstable");
  assert.equal(tick, 4, "two passes, each checked before and after");
  assert.equal(unstableDb.prepare("SELECT COUNT(*) AS n FROM local_content_fingerprints").get().n, 0);
});

test("the cheap playability check stats the file without hashing it", async () => {
  addSong("cheap", makeWav(800, { seed: 81 }));
  const before = db.prepare("SELECT COUNT(*) AS n FROM local_content_fingerprints WHERE file_path LIKE '%cheap.wav'").get().n;
  assert.equal(await source.checkPlayable(ref("cheap")), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM local_content_fingerprints WHERE file_path LIKE '%cheap.wav'").get().n, before);
  fs.rmSync(path.join(library, "cheap.wav"));
  assert.equal(await source.checkPlayable(ref("cheap")), false);
  assert.equal(await source.checkPlayable(ref("cache")), false, "an unplayable row");
  assert.equal(await source.checkPlayable(ref("outside")), false, "outside the library");
});
