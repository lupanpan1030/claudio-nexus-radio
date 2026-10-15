import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { decode, lyricsResponseV1Decoder, resolveResponseV1Decoder } from "@claudio/contracts";
import { LocalFingerprints, LocalMediaSource, LocalSidecarLyrics } from "../adapters/local/local-source.ts";
import { runMigrations } from "../adapters/sqlite/migrations.ts";
import { LegacyTrackCatalog, TrackRowReader } from "../adapters/sqlite/track-catalog.ts";
import { ControlledWriter, FakeProvider, FakeRadio, FakeSpeech, fakeTrack } from "../testing/fakes.ts";
import { startHarness } from "../testing/harness.ts";
import { makeWav } from "../testing/wav.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-source-identity-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let counter = 0;
const tempDir = () => {
  const dir = path.join(root, `case-${(counter += 1)}`);
  fs.mkdirSync(dir);
  return dir;
};

/** Two catalog rows (distinct ids and paths) holding byte-identical audio, each with its own sidecar. */
function localLibrary(dir) {
  const music = path.join(dir, "music");
  fs.mkdirSync(path.join(music, "album-a"), { recursive: true });
  fs.mkdirSync(path.join(music, "album-b"), { recursive: true });
  const bytes = makeWav(1500, { seed: 41 });
  const files = { "copy-a": path.join(music, "album-a", "Song.wav"), "copy-b": path.join(music, "album-b", "Song.wav") };
  fs.writeFileSync(files["copy-a"], bytes);
  fs.writeFileSync(files["copy-b"], bytes);
  fs.writeFileSync(path.join(music, "album-a", "Song.lrc"), "[00:00.50]甲版本\n");
  fs.writeFileSync(path.join(music, "album-b", "Song.lrc"), "[00:00.50]乙版本\n");
  const db = new DatabaseSync(path.join(dir, "radio.sqlite"));
  runMigrations(db);
  const insert = db.prepare(
    "INSERT INTO tracks (id, title, artist, album, file_path, folder, extension, source, playable, size, added_at) VALUES (?, 'Same recording', 'Synthetic', '', ?, ?, 'wav', 'main', 1, ?, 'now')"
  );
  for (const [id, file] of Object.entries(files)) insert.run(id, file, path.dirname(file), bytes.length);
  const rows = new TrackRowReader(db);
  const module = {
    providerId: "local",
    catalog: new LegacyTrackCatalog(rows, "local", ["main"]),
    source: new LocalMediaSource({ rows, sources: ["main"], fingerprints: new LocalFingerprints(db), libraryDir: music }),
    lyrics: new LocalSidecarLyrics()
  };
  return { db, files, bytes, module };
}

const ref = (providerId, mediaId) => ({ providerId, mediaId });

async function resolve(harness, itemId, track, previousRevision = null) {
  const response = await harness.request("POST", "/api/v1/playback/resolve", {
    protocolVersion: 1,
    itemId,
    track,
    preparationId: null,
    reason: previousRevision ? "refresh" : "initial",
    previousRevision
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.ok(decode(resolveResponseV1Decoder, response.json).ok);
  return response.json.media;
}

async function lyrics(harness, itemId, media) {
  const response = await harness.request("POST", "/api/v1/playback/lyrics", {
    protocolVersion: 1,
    itemId,
    track: media.track,
    recordingId: media.recording.recordingId,
    sourceRevision: media.sourceRevision
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.ok(decode(lyricsResponseV1Decoder, response.json).ok, "outbound lyrics pass the contracts decoder");
  return response.json.result;
}

async function streamBytes(harness, media) {
  const response = await fetch(harness.baseUrl + media.stream.handle);
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

function started(harness, key, itemId, media) {
  return harness.request("POST", "/api/v1/playback/started", {
    protocolVersion: 1,
    idempotencyKey: key,
    executorInstanceId: "exec-1",
    itemId,
    track: media.track,
    recordingId: media.recording.recordingId,
    sourceRevision: media.sourceRevision,
    loadId: `load-${itemId}`,
    positionMs: 0,
    startedAt: "2026-10-16T12:00:00.000Z"
  });
}

function harnessWith(dir, providers, db) {
  return startHarness({ dir, db, providers, writer: new ControlledWriter(), tts: new FakeSpeech(), radio: new FakeRadio(() => []) });
}

test("the same bytes under two local tracks share the recording but each ref keeps its own revision, stream, lyrics and started fact", async () => {
  const dir = tempDir();
  const lib = localLibrary(dir);
  const harness = await harnessWith(dir, [lib.module], lib.db);
  try {
    const a = await resolve(harness, "item-a", ref("local", "copy-a"));
    const b = await resolve(harness, "item-b", ref("local", "copy-b"));
    assert.equal(a.recording.recordingId, b.recording.recordingId, "one actual recording");
    assert.equal(a.recording.confidence, "content-hash");
    assert.notEqual(a.sourceRevision, b.sourceRevision, "a revision never names two refs");

    const rows = lib.db.prepare("SELECT source_revision, media_id, binding_json FROM playback_resolved_sources ORDER BY media_id").all();
    assert.deepEqual(rows.map((row) => [row.source_revision, row.media_id]), [[a.sourceRevision, "copy-a"], [b.sourceRevision, "copy-b"]]);
    assert.equal(JSON.parse(rows[0].binding_json).filePath, lib.files["copy-a"], "the first ref's binding was not overwritten");
    assert.equal(JSON.parse(rows[1].binding_json).filePath, lib.files["copy-b"]);

    for (const media of [a, b]) {
      const served = await streamBytes(harness, media);
      assert.equal(served.status, 200);
      assert.ok(served.bytes.equals(Buffer.from(lib.bytes)));
    }
    const handles = lib.db.prepare("SELECT source_revision, binding_json FROM playback_stream_handles ORDER BY created_at, token").all();
    assert.deepEqual(
      handles.map((row) => [row.source_revision, JSON.parse(row.binding_json).filePath]).sort(),
      [[a.sourceRevision, lib.files["copy-a"]], [b.sourceRevision, lib.files["copy-b"]]].sort(),
      "each handle traces back to its own file"
    );

    const lyricsA = await lyrics(harness, "item-a", a);
    const lyricsB = await lyrics(harness, "item-b", b);
    assert.deepEqual([lyricsA.asset.sourceRevision, lyricsA.asset.recordingId, lyricsA.asset.lines[0].text], [a.sourceRevision, a.recording.recordingId, "甲版本"]);
    assert.deepEqual([lyricsB.asset.sourceRevision, lyricsB.asset.recordingId, lyricsB.asset.lines[0].text], [b.sourceRevision, b.recording.recordingId, "乙版本"]);
    const crossed = await harness.request("POST", "/api/v1/playback/lyrics", {
      protocolVersion: 1,
      itemId: "item-a",
      track: a.track,
      recordingId: a.recording.recordingId,
      sourceRevision: b.sourceRevision
    });
    assert.equal(crossed.status >= 400, true, "a revision of the other ref is refused");
    assert.equal(crossed.json.error.code, "revision_mismatch");

    assert.equal((await started(harness, "k-a", "item-a", a)).json.status, "recorded");
    assert.equal((await started(harness, "k-b", "item-b", b)).json.status, "recorded");
    const facts = harness.assembly.stores.started.recent(10);
    assert.deepEqual(
      facts.map((fact) => [fact.itemId, fact.track.mediaId, fact.legacyTrackId, fact.sourceRevision, fact.sourceVerified]).sort(),
      [
        ["item-a", "copy-a", "copy-a", a.sourceRevision, true],
        ["item-b", "copy-b", "copy-b", b.sourceRevision, true]
      ]
    );
    const mixed = await started(harness, "k-x", "item-x", { ...a, sourceRevision: b.sourceRevision });
    assert.equal(mixed.json.error.code, "started_source_mismatch");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("refreshing the same local ref keeps its revision; changed content rotates it and old handles expire", async () => {
  const dir = tempDir();
  const lib = localLibrary(dir);
  const harness = await harnessWith(dir, [lib.module], lib.db);
  try {
    const first = await resolve(harness, "item-a", ref("local", "copy-a"));
    const refreshed = await resolve(harness, "item-a", ref("local", "copy-a"), first.sourceRevision);
    assert.equal(refreshed.sourceRevision, first.sourceRevision);
    assert.notEqual(refreshed.stream.handle, first.stream.handle, "a new handle for the same revision");

    fs.writeFileSync(lib.files["copy-a"], makeWav(900, { seed: 77 }));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(lib.files["copy-a"], future, future);
    const changed = await resolve(harness, "item-a", ref("local", "copy-a"), first.sourceRevision);
    assert.notEqual(changed.sourceRevision, first.sourceRevision);
    assert.notEqual(changed.recording.recordingId, first.recording.recordingId);
    const old = await fetch(harness.baseUrl + first.stream.handle);
    assert.equal(old.status, 410, "an old handle never serves the new bytes");
    await old.arrayBuffer();
    const kept = lib.db.prepare("SELECT media_id FROM playback_resolved_sources WHERE source_revision = ?").get(first.sourceRevision);
    assert.equal(kept.media_id, "copy-a", "the old revision stays traceable for history");
    const b = await resolve(harness, "item-b", ref("local", "copy-b"));
    assert.equal(b.recording.recordingId, first.recording.recordingId, "the untouched copy still has the original recording");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("a source that cannot prove continuity rotates the revision on every refresh, and nothing bound to the old one carries over", async () => {
  const dir = tempDir();
  const provider = new FakeProvider("fixture-u");
  const track = provider.add(fakeTrack("u1", 5, { continuityUnprovable: true, lyrics: { format: "lrc", text: "[00:00.40]无法证明\n" } }));
  const twin = provider.add(fakeTrack("u2", 5, { title: "Song u1", continuityUnprovable: true }));
  const harness = await harnessWith(dir, [provider.module()]);
  try {
    const first = await resolve(harness, "item-u", track);
    assert.equal(first.recording.confidence, "unverified");
    const firstLyrics = await lyrics(harness, "item-u", first);
    assert.equal(firstLyrics.asset.sourceRevision, first.sourceRevision);

    const refreshed = await resolve(harness, "item-u", track, first.sourceRevision);
    assert.notEqual(refreshed.sourceRevision, first.sourceRevision, "unprovable continuity is a new revision");
    const refreshedLyrics = await lyrics(harness, "item-u", refreshed);
    assert.equal(refreshedLyrics.asset.sourceRevision, refreshed.sourceRevision, "lyrics are re-bound, not inherited");
    assert.notEqual(refreshedLyrics.asset.assetId, firstLyrics.asset.assetId);

    const lookalike = await resolve(harness, "item-v", twin);
    assert.notEqual(lookalike.sourceRevision, refreshed.sourceRevision, "same title and bytes under another ref is never the same source");
    assert.notEqual(lookalike.recording.recordingId, refreshed.recording.recordingId);

    const stale = await harness.request("POST", "/api/v1/playback/lyrics", {
      protocolVersion: 1,
      itemId: "item-u",
      track,
      recordingId: first.recording.recordingId,
      sourceRevision: first.sourceRevision
    });
    assert.equal(stale.status, 200, "the old revision still answers for itself");
    assert.equal(stale.json.result.asset.sourceRevision, first.sourceRevision);
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("a provider that reuses a revision for another ref is refused instead of rebinding it", async () => {
  const dir = tempDir();
  const provider = new FakeProvider("fixture-c");
  const a = provider.add(fakeTrack("c1", 9));
  const b = provider.add(fakeTrack("c2", 9));
  const original = provider.resolve.bind(provider);
  // A broken adapter that ignores the ref when naming revisions.
  provider.resolve = async (track, context) => ({ ...(await original(track, context)), sourceRevision: "fixture-c-shared" });
  const harness = await harnessWith(dir, [provider.module()]);
  try {
    await resolve(harness, "item-1", a);
    const second = await harness.request("POST", "/api/v1/playback/resolve", {
      protocolVersion: 1,
      itemId: "item-2",
      track: b,
      preparationId: null,
      reason: "initial",
      previousRevision: null
    });
    assert.equal(second.json.error.code, "revision_conflict");
    const row = harness.db.prepare("SELECT media_id FROM playback_resolved_sources WHERE source_revision = 'fixture-c-shared'").get();
    assert.equal(row.media_id, "c1");
  } finally {
    await harness.close({ closeDb: true });
  }
});
