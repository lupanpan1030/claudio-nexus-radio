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

// Real createServices + SQLite + HTTP. Rows are written straight into tracks,
// as an older build or a hand edit would leave them, including a source no
// provider serves. KuGou points at a closed port; no keys.
const CHILD = `
const path = await import("node:path");
const fs = await import("node:fs");
const { createServices } = await import(process.env.COMPOSITION);
const { createApp } = await import(process.env.APP);
const { makeWav } = await import(process.env.WAV);
const services = await createServices();
const { db, getTrack } = await import(process.env.DB);
const insert = db.prepare("INSERT INTO tracks (id, title, artist, album, file_path, folder, extension, source, playable, size, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-16T00:00:00Z')");
const local = (id, source, seed) => {
  const file = path.join(process.env.MUSIC_LIBRARY_DIR, id + ".wav");
  const bytes = makeWav(1500, { seed });
  fs.writeFileSync(file, bytes);
  insert.run(id, "Title " + id, "Artist " + id, "Album", file, "private-folder", "wav", source, 1, bytes.length);
};
local("loc-main", "main", 1);
local("loc-cache", "kugou-cache", 2);
local("odd", "unsupported-provider", 3);
// Not playable, so the radio pool is not narrowed to API rows; still a catalog entry with a ref.
insert.run("kg-api", "Title kg-api", "Artist kg-api", "KuGou", "kugou://0123456789ABCDEF0123456789ABCDEF", "KuGou API", "remote", "kugou-api", 0, 0);

const { app, close } = createApp(services.appDeps);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const call = async (method, url, body) => {
  const response = await fetch(base + url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json };
};
const resolve = async (itemId, track) => {
  const r = await call("POST", "/api/v1/playback/resolve", { protocolVersion: 1, itemId, track, preparationId: null, reason: "initial", previousRevision: null });
  return { status: r.status, code: r.json.error?.code ?? null };
};
const out = {};
const library = await call("GET", "/api/library");
out.libraryText = JSON.stringify(library.json);
out.library = Object.fromEntries(library.json.tracks.map((t) => [t.id, { source: t.source, ref: t.ref }]));
out.catalog = (await call("GET", "/api/v1/catalog/search")).json.tracks.map((e) => e.track);
out.described = Object.fromEntries(library.json.tracks.map((t) => [t.id, t.ref ? services.playback.services.providers.describe(t.ref)?.ref ?? null : null]));
out.resolved = {};
for (const t of library.json.tracks) if (t.ref) out.resolved[t.id] = await resolve("lib-" + t.id, t.ref);
// The unknown row under every provider id a client could guess: none of them knows it.
out.forged = { local: await resolve("forged-local", { providerId: "local", mediaId: "odd" }), kugou: await resolve("forged-kugou", { providerId: "kugou", mediaId: "odd" }) };
out.forgedDescribe = [services.playback.services.providers.describe({ providerId: "local", mediaId: "odd" }), services.playback.services.providers.describe({ providerId: "kugou", mediaId: "odd" })];
out.verifyPlayable = {};
for (const id of ["loc-main", "loc-cache", "odd"]) out.verifyPlayable[id] = await services.appDeps.legacyHooks.verifyPlayable(getTrack(id));

// Radio: two servable playable rows (loc-main, loc-cache) and the unknown one.
const radio = async (itemId) => {
  const r = await call("POST", "/api/v1/playback/prepare", { protocolVersion: 1, itemId, purpose: "standby", target: { kind: "radio-candidate", afterItemId: null }, narration: null, wantLyrics: false });
  const stage = r.json.stages.candidate;
  return { preparationId: r.json.preparationId, pick: stage.value?.track.mediaId ?? null, code: stage.error?.code ?? null };
};
out.radio = [];
for (let cycle = 0; cycle < 6; cycle += 1) {
  const picks = [await radio("r" + cycle + "a"), await radio("r" + cycle + "b"), await radio("r" + cycle + "c")];
  out.radio.push(picks.map((p) => p.pick ?? p.code));
  for (const p of picks) await call("DELETE", "/api/v1/playback/preparations/" + p.preparationId);
}
out.considered = db.prepare("SELECT * FROM playback_candidate_audits").all().map((row) => JSON.stringify(row));
out.rawSources = db.prepare("SELECT id, source FROM tracks ORDER BY id").all().map((row) => ({ ...row }));
await close();
server.closeAllConnections();
server.close();
services.close();
console.log(JSON.stringify(out));
`;

test("library refs exist only for rows a provider catalog serves; unknown stored sources stay verbatim and unplayable", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-libsrc-"));
  try {
    const dirs = { data: path.join(work, "data"), profile: path.join(work, "profile"), music: path.join(work, "music") };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    const script = path.join(work, "child.mjs");
    fs.writeFileSync(script, CHILD);
    const result = spawnSync(
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
          DB: path.join(serverDir, "db.ts"),
          WAV: path.join(serverDir, "testing/wav.ts")
        }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split("\n").at(-1));

    assert.deepEqual(out.library, {
      "loc-main": { source: "main", ref: { providerId: "local", mediaId: "loc-main" } },
      "loc-cache": { source: "kugou-cache", ref: { providerId: "local", mediaId: "loc-cache" } },
      "kg-api": { source: "kugou-api", ref: { providerId: "kugou", mediaId: "kg-api" } },
      odd: { source: "unsupported-provider", ref: null }
    }, "the stored source is reported as stored, never relabelled as a served one");
    assert.doesNotMatch(out.libraryText, /\.wav|private-folder|kugou:\/\/|0123456789ABCDEF|claudio-libsrc-/, "no locator in the library response");

    // Every non-null library ref is one the real catalog describes and lists; the unknown row is in neither.
    for (const [id, row] of Object.entries(out.library)) {
      assert.deepEqual(out.described[id], row.ref, `${id}: library ref ⇔ catalog describe`);
      if (row.ref) assert.ok(out.catalog.some((ref) => ref.providerId === row.ref.providerId && ref.mediaId === row.ref.mediaId), `${id}: listed by catalog search`);
    }
    assert.ok(!out.catalog.some((ref) => ref.mediaId === "odd"));
    assert.deepEqual(out.forgedDescribe, [null, null]);

    assert.deepEqual(out.resolved["loc-main"], { status: 200, code: null });
    assert.deepEqual(out.resolved["loc-cache"], { status: 200, code: null });
    assert.notEqual(out.resolved["kg-api"].code, "track_not_found", "the KuGou row is in its catalog; only the closed upstream fails");
    assert.equal(out.forged.local.code, "track_not_found");
    assert.equal(out.forged.kugou.code, "track_not_found");

    assert.deepEqual(out.verifyPlayable, { "loc-main": true, "loc-cache": true, odd: false });
    for (const cycle of out.radio) {
      assert.deepEqual([...cycle.slice(0, 2)].sort(), ["loc-cache", "loc-main"], "both servable rows are picked before anything else");
      assert.equal(cycle[2], "no_candidate", "with both reserved, the unknown row is not offered");
    }
    for (const audit of out.considered) assert.doesNotMatch(audit, /"odd"/);

    assert.deepEqual(out.rawSources, [
      { id: "kg-api", source: "kugou-api" },
      { id: "loc-cache", source: "kugou-cache" },
      { id: "loc-main", source: "main" },
      { id: "odd", source: "unsupported-provider" }
    ], "stored rows are not rewritten");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
