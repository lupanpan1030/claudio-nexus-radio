import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeWav } from "../testing/wav.ts";

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(serverDir);

// Runs the REAL composition (legacy modules, SQLite, local + KuGou adapters,
// Fish adapter, model writer) in a child process with an isolated cwd and
// data dirs, no provider keys and KuGou pointed at a closed port. It proves the
// local path end to end; it says nothing about a real KuGou account or Fish.
const CHILD = `
const fs = await import("node:fs");
const { createServices } = await import(process.env.COMPOSITION);
const { createApp } = await import(process.env.APP);
const out = {};
const services = await createServices();
out.recovered = services.playback.recovered;
out.scan = await services.scanIfEmpty();
const { app, close } = createApp(services.appDeps);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const call = async (method, url, body, headers = {}) => {
  const response = await fetch(base + url, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json };
};
out.protocol = (await call("GET", "/api/v1/protocol")).json.playbackProtocol;
const search = await call("GET", "/api/v1/catalog/search?q=Song");
const track = search.json.tracks[0].track;
out.track = track;
const library = await call("GET", "/api/library");
out.libraryKeys = Object.keys(library.json.tracks[0]).sort();
const prepared = await call("POST", "/api/v1/playback/prepare", { protocolVersion: 1, itemId: "e2e-1", purpose: "program", target: { kind: "track", track }, narration: null, wantLyrics: true });
let item = prepared.json;
for (let i = 0; i < 20 && item.status === "active"; i += 1) item = (await call("GET", "/api/v1/playback/preparations/" + item.preparationId + "?afterVersion=" + item.version + "&waitMs=500")).json;
out.prepared = { status: item.status, source: item.stages.source.status, lyrics: item.stages.lyrics.value, recording: item.stages.source.value.recording, duration: item.stages.source.value.duration };
const media = item.stages.source.value;
const ranged = await fetch(base + media.stream.handle, { headers: { Range: "bytes=0-15" } });
out.range = { status: ranged.status, bytes: (await ranged.arrayBuffer()).byteLength };
const started = { protocolVersion: 1, idempotencyKey: "e2e-key", executorInstanceId: "exec", itemId: "e2e-1", track, recordingId: media.recording.recordingId, sourceRevision: media.sourceRevision, loadId: "load-1", positionMs: 0, startedAt: new Date().toISOString() };
out.started = [(await call("POST", "/api/v1/playback/started", started)).json.status, (await call("POST", "/api/v1/playback/started", started)).json.status];
out.radioNext = (await call("POST", "/api/radio/next", {})).status;
const cue = await call("POST", "/api/v1/playback/narration?waitMs=3000", { protocolVersion: 1, cueId: "e2e-cue", transitionId: "e2e-tr", preparationId: null, from: { itemId: "e2e-0", track, sourceRevision: null }, to: { itemId: "e2e-1", track, sourceRevision: media.sourceRevision } });
out.cue = { script: cue.json.script, voice: cue.json.voice.status };
const { DatabaseSync } = await import("node:sqlite");
const writer = new DatabaseSync(process.env.DATA_DIR + "/radio.sqlite");
writer.prepare("INSERT OR IGNORE INTO tracks (id, title, artist, album, file_path, folder, extension, source, playable, size, added_at) VALUES ('kg-e2e', 'Remote', 'Artist', 'KuGou', 'kugou://0123456789ABCDEF0123456789ABCDEF', 'KuGou API', 'remote', 'kugou-api', 1, 0, 'now')").run();
writer.close();
const kugouResolve = await call("POST", "/api/v1/playback/resolve", { protocolVersion: 1, itemId: "e2e-kg", track: { providerId: "kugou", mediaId: "kg-e2e" }, preparationId: null, reason: "initial", previousRevision: null });
const { bundledKuGouApi } = await import(process.env.KUGOU);
out.kugou = { code: kugouResolve.json.error?.code, enabled: bundledKuGouApi.enabled, attempts: bundledKuGouApi.attempts, launches: bundledKuGouApi.launches, runtimeDir: fs.existsSync(process.env.DATA_DIR + "/external") };
const db = new DatabaseSync(process.env.DATA_DIR + "/radio.sqlite", { readOnly: true });
out.counts = {
  plays: db.prepare("SELECT COUNT(*) AS n FROM plays").get().n,
  started: db.prepare("SELECT COUNT(*) AS n FROM playback_started").get().n,
  radioPicks: db.prepare("SELECT COUNT(*) AS n FROM radio_picks").get().n,
  schema: db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v
};
db.close();
await close();
server.closeAllConnections();
server.close();
services.close();
console.log(JSON.stringify(out));
`;

test("real composition serves the local path end to end without writing legacy history", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-e2e-"));
  try {
    const dirs = { data: path.join(work, "data"), profile: path.join(work, "profile"), music: path.join(work, "music") };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dirs.music, "Artist - Song.wav"), makeWav(1500, { seed: 21 }));
    fs.writeFileSync(path.join(dirs.music, "Artist - Song.lrc"), "[00:00.80]作词 : 某人\n[00:01.00]第一句\n");
    const script = path.join(work, "child.mjs");
    fs.writeFileSync(script, CHILD);
    const run = (extraEnv = {}) =>
      spawnSync(
        process.execPath,
        ["--import", path.join(repoRoot, "node_modules/tsx/dist/esm/index.mjs"), "--import", path.join(serverDir, "testing/register-workspace.mjs"), script],
        {
          cwd: work,
          encoding: "utf8",
          timeout: 120_000,
          env: {
            PATH: process.env.PATH,
            HOME: work,
            TZ: "UTC",
            DATA_DIR: dirs.data,
            USER_PROFILE_DIR: dirs.profile,
            MUSIC_LIBRARY_DIR: dirs.music,
            KUGOU_API_AUTOSTART: "false",
            KUGOU_API_BASE_URL: "http://127.0.0.1:9",
            AI_BASE_URL: "http://127.0.0.1:9",
            FISH_TTS_ENDPOINT: "http://127.0.0.1:9/v1/tts",
            COMPOSITION: path.join(serverDir, "composition.ts"),
            APP: path.join(serverDir, "http/app.ts"),
            KUGOU: path.join(serverDir, "kugou.ts"),
            ...extraEnv
          }
        }
      );
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.equal(out.protocol, "v1");
    assert.match(out.scan, /^Scanned 1 tracks/);
    assert.equal(out.track.providerId, "local");
    assert.deepEqual(out.libraryKeys, ["album", "artist", "extension", "id", "playable", "source", "title"], "library DTO still hides locators");
    assert.equal(out.prepared.status, "ready");
    assert.equal(out.prepared.recording.confidence, "content-hash");
    assert.deepEqual(out.prepared.duration, { kind: "known", ms: 1500, source: "container-metadata" });
    assert.equal(out.prepared.lyrics.status, "available");
    assert.equal(out.prepared.lyrics.asset.timing, "native-line");
    assert.deepEqual(out.range, { status: 206, bytes: 16 });
    assert.deepEqual(out.started, ["recorded", "duplicate"]);
    assert.equal(out.radioNext, 410);
    assert.equal(out.cue.script.status, "failed", "no model configured: the DJ script fails explicitly");
    assert.equal(out.cue.script.error.code, "script_writer_not_configured");
    assert.equal(out.cue.voice, "skipped");
    assert.deepEqual(out.counts, { plays: 0, started: 1, radioPicks: 0, schema: 4 });
    assert.deepEqual(
      out.kugou,
      { code: "kugou_unreachable", enabled: false, attempts: 0, launches: 0, runtimeDir: false },
      "KUGOU_API_AUTOSTART=false: the v1 client fails as unreachable and nothing is started"
    );

    // Second boot on the same data: migrations are a no-op, nothing was left unfinished.
    const again = run();
    assert.equal(again.status, 0, again.stderr);
    const second = JSON.parse(again.stdout.trim().split("\n").at(-1));
    assert.deepEqual(second.recovered, { preparations: 0, cues: 0 });
    assert.equal(second.scan, null, "non-empty catalog is not rescanned");
    assert.deepEqual(second.started, ["duplicate", "duplicate"], "the started key survives restarts");

    // Autostart on, but no bundled API installed under DATA_DIR: the composed v1 client asks the shared
    // starter once (probing the closed local port), finds nothing to launch and spawns nothing.
    const enabled = run({ KUGOU_API_AUTOSTART: "true" });
    assert.equal(enabled.status, 0, enabled.stderr);
    const third = JSON.parse(enabled.stdout.trim().split("\n").at(-1));
    assert.deepEqual(third.kugou, { code: "kugou_unreachable", enabled: true, attempts: 1, launches: 0, runtimeDir: false });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
