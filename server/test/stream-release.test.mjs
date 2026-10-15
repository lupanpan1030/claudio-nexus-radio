import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { KuGouClient } from "../adapters/kugou/client.ts";
import { KuGouMediaSource } from "../adapters/kugou/kugou-source.ts";
import { LocalFingerprints, LocalMediaSource } from "../adapters/local/local-source.ts";
import { runMigrations } from "../adapters/sqlite/migrations.ts";
import { LegacyTrackCatalog, TrackRowReader } from "../adapters/sqlite/track-catalog.ts";
import { ControlledWriter, FakeRadio, FakeSpeech } from "../testing/fakes.ts";
import { startHarness } from "../testing/harness.ts";
import { makeWav } from "../testing/wav.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-stream-release-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);
after(() => process.off("unhandledRejection", onUnhandled));
// A FileHandle nobody closed is closed by garbage collection with this warning: that is a leak too.
const gcClosed = [];
const onWarning = (warning) => /garbage collection/i.test(warning.message) && gcClosed.push(warning.message);
process.on("warning", onWarning);
after(() => process.off("warning", onWarning));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline && !check(); ) await sleep(10);
  return check();
}

const AUDIO = makeWav(1500, { seed: 3 });
// One catalog entry per upstream behaviour; the hash selects what the audio URL does.
const MODES = {
  endless: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  finite: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  unsatisfiable: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  failing: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"
};

/**
 * Loopback stand-in for the KuGou API and its CDN. Audio responses that the
 * proxy should not keep are left open (never ended) so only a cancel or abort
 * on our side can close them; every connection is counted per mode.
 */
async function startUpstream() {
  const counts = Object.fromEntries(Object.keys(MODES).map((mode) => [mode, { opened: 0, closed: 0 }]));
  const timers = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/song/url") {
      const hash = url.searchParams.get("hash");
      const mode = Object.keys(MODES).find((key) => MODES[key] === hash);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ hash, url: `http://127.0.0.1:${server.address().port}/audio/${mode}` }));
      return;
    }
    const mode = url.pathname.slice("/audio/".length);
    const count = counts[mode];
    count.opened += 1;
    res.on("close", () => (count.closed += 1));
    if (mode === "finite") {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": String(AUDIO.length) });
      res.end(AUDIO);
      return;
    }
    if (mode === "unsatisfiable") res.writeHead(416, { "Content-Range": `bytes */${AUDIO.length}` });
    else if (mode === "failing") res.writeHead(500, { "Content-Type": "text/plain" });
    else res.writeHead(200, { "Content-Type": "audio/wav" });
    res.write(mode === "endless" ? AUDIO : "partial body");
    const timer = setInterval(() => res.write(Buffer.alloc(1024)), 50);
    timers.add(timer);
    res.on("close", () => {
      clearInterval(timer);
      timers.delete(timer);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    counts,
    active: (mode) => counts[mode].opened - counts[mode].closed,
    async close() {
      for (const timer of timers) clearInterval(timer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

test("fetch bodies from a remote source are released on every path: HEAD, full GET, client abort, 416, upstream failure", async () => {
  const upstream = await startUpstream();
  const rows = { get: (id) => (MODES[id] ? { filePath: `kugou://${MODES[id]}`, playable: true } : null) };
  const source = new KuGouMediaSource({
    rows,
    client: new KuGouClient({ baseUrl: upstream.base, credentials: () => null }),
    search: async () => [],
    score: () => 0,
    urlTtlMs: 60_000,
    clock: { now: Date.now }
  });
  const entry = (mediaId) => ({ ref: { providerId: "kugou", mediaId }, display: { title: mediaId, artist: "fixture" }, legacyTrackId: null, playable: true });
  const harness = await startHarness({
    dir: fs.mkdtempSync(path.join(root, "kugou-")),
    providers: [{ providerId: "kugou", source, catalog: { describe: (ref) => entry(ref.mediaId), search: () => [] } }],
    writer: new ControlledWriter(),
    tts: new FakeSpeech(),
    radio: new FakeRadio(() => [])
  });
  const handleFor = async (mode) => {
    const response = await harness.request("POST", "/api/v1/playback/resolve", {
      protocolVersion: 1,
      itemId: `item-${mode}`,
      track: { providerId: "kugou", mediaId: mode },
      preparationId: null,
      reason: "initial",
      previousRevision: null
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    return `${harness.baseUrl}${response.json.media.stream.handle}`;
  };
  try {
    const endless = await handleFor("endless");

    const head = await fetch(endless, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(upstream.counts.endless.opened, 1);
    assert.ok(await until(() => upstream.active("endless") === 0), "HEAD done: the unread upstream body is cancelled and its connection closed");

    const abort = new AbortController();
    const get = await fetch(endless, { signal: abort.signal });
    assert.equal(get.status, 200);
    const reader = get.body.getReader();
    assert.ok((await reader.read()).value.byteLength > 0);
    abort.abort();
    await reader.closed.catch(() => undefined);
    assert.equal(upstream.counts.endless.opened, 2);
    assert.ok(await until(() => upstream.active("endless") === 0), "client abort mid-body closes the upstream connection");

    const full = await fetch(await handleFor("finite"));
    assert.equal(full.status, 200);
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), AUDIO);
    assert.ok(await until(() => upstream.active("finite") === 0));

    const unsatisfiable = await fetch(await handleFor("unsatisfiable"), { headers: { Range: "bytes=999999-" } });
    assert.equal(unsatisfiable.status, 416);
    await unsatisfiable.arrayBuffer();
    assert.ok(await until(() => upstream.active("unsatisfiable") === 0), "a 416 answer's upstream body is cancelled");

    const failed = await fetch(await handleFor("failing"));
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error.code, "kugou_stream_failed");
    assert.ok(await until(() => upstream.active("failing") === 0), "a failed upstream answer's body is cancelled");

    // A second HEAD after everything else: still exactly one connection per request, none left behind.
    assert.equal((await fetch(endless, { method: "HEAD" })).status, 200);
    assert.ok(await until(() => upstream.active("endless") === 0));
    assert.deepEqual(upstream.counts.endless, { opened: 3, closed: 3 });
    await sleep(50);
    assert.deepEqual(unhandled, [], "releasing bodies raises no unhandled rejection");
  } finally {
    await harness.close({ closeDb: true });
    await upstream.close();
  }
});

const openDescriptors = (file) => {
  let count = 0;
  for (const fd of fs.readdirSync("/proc/self/fd")) {
    try {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) === file) count += 1;
    } catch {
      // closed while listing
    }
  }
  return count;
};

test("local file descriptors are closed on HEAD, full GET, client abort and 416", { skip: !fs.existsSync("/proc/self/fd") && "needs /proc/self/fd" }, async () => {
  const dir = fs.mkdtempSync(path.join(root, "local-"));
  const db = new DatabaseSync(path.join(dir, "radio.sqlite"));
  runMigrations(db);
  const file = path.join(dir, "long.wav");
  const bytes = makeWav(60_000, { seed: 5 });
  fs.writeFileSync(file, bytes);
  db.prepare("INSERT INTO tracks(id,title,artist,album,file_path,folder,extension,source,playable,size,added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
    "long",
    "long",
    "fixture",
    "",
    file,
    dir,
    "wav",
    "main",
    1,
    bytes.length,
    "2026-10-16T00:00:00Z"
  );
  const rows = new TrackRowReader(db);
  const source = new LocalMediaSource({ rows, sources: ["main"], fingerprints: new LocalFingerprints(db), libraryDir: dir });
  const harness = await startHarness({
    dir,
    db,
    providers: [{ providerId: "local", catalog: new LegacyTrackCatalog(rows, "local", ["main"]), source }],
    writer: new ControlledWriter(),
    tts: new FakeSpeech(),
    radio: new FakeRadio(() => [])
  });
  try {
    const resolved = await harness.request("POST", "/api/v1/playback/resolve", {
      protocolVersion: 1,
      itemId: "local-item",
      track: { providerId: "local", mediaId: "long" },
      preparationId: null,
      reason: "initial",
      previousRevision: null
    });
    assert.equal(resolved.status, 200);
    const handle = `${harness.baseUrl}${resolved.json.media.stream.handle}`;
    const released = () => until(() => openDescriptors(file) === 0, 1000);

    assert.equal((await fetch(handle, { method: "HEAD" })).status, 200);
    assert.ok(await released(), "HEAD closes the descriptor it opened");

    const full = await fetch(handle);
    assert.equal((await full.arrayBuffer()).byteLength, bytes.length);
    assert.ok(await released());

    const abort = new AbortController();
    const partial = await fetch(handle, { signal: abort.signal });
    const reader = partial.body.getReader();
    await reader.read();
    abort.abort();
    await reader.closed.catch(() => undefined);
    assert.ok(await released(), "client abort closes the descriptor");

    const unsatisfiable = await fetch(handle, { headers: { Range: `bytes=${bytes.length + 10}-` } });
    assert.equal(unsatisfiable.status, 416);
    await unsatisfiable.arrayBuffer();
    assert.ok(await released());
    await sleep(50);
    assert.deepEqual(gcClosed, [], "no descriptor was left for garbage collection to close");
    assert.deepEqual(unhandled, []);
  } finally {
    await harness.close({ closeDb: true });
  }
});
