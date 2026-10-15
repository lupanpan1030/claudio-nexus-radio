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
