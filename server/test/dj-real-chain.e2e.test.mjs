import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeWav } from "../testing/wav.ts";

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(serverDir);

// An obviously fake key: the only model this test talks to is the loopback server below.
const SYNTHETIC_KEY = "sk-synthetic-claudio-test-key-not-real";
const MODEL = "fixture-dj-model";
const SELECTOR_SYSTEM = "你只负责为电台串词挑选参考范式";

/**
 * Loopback stand-in for the OpenAI-compatible endpoint. It answers both
 * rounds of the real chain in their real schemas: the few-shot selector
 * ({"selected":[ids]} from the offered "[id]" labels) and the locked-song
 * decision ({"say","play","reason","segue"} with the one offered candidate id).
 */
async function startFakeLlm() {
  const requests = [];
  let lines = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const system = body.messages.find((message) => message.role === "system")?.content ?? "";
      const user = body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      const kind = system.startsWith(SELECTOR_SYSTEM) ? "selector" : "decision";
      requests.push({ path: req.url, authorization: req.headers.authorization, kind, body });
      let content;
      if (kind === "selector") {
        const ids = [...user.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
        content = JSON.stringify({ selected: ids.slice(0, 2) });
      } else {
        const candidate = /Pick only from these candidate IDs: (.+)$/m.exec(user)?.[1].trim();
        lines += 1;
        content = JSON.stringify({
          say: `合成串词第${lines}段：这一段文字只由本地假模型生成，用来确认交接上下文真的进了请求。`,
          play: [candidate],
          reason: "fixture",
          segue: "talk_first"
        });
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// Runs the REAL composition (legacy DJ modules, SQLite, local adapter, v1 cue
// service, LegacyModelScriptWriter → generateDjLineForTrack →
// generateModelFirstDjLine → selectDjFewShots/buildContext →
// resolveClaudeDecision → callLlmText) in a child with an isolated cwd that
// holds a copy of the public prompts/, temporary data dirs and a whitelisted
// environment whose model endpoint is the parent's loopback server.
const CHILD = `
const { createServices, legacyDjLineGenerator } = await import(process.env.COMPOSITION);
const { createApp } = await import(process.env.APP);
const { LegacyModelScriptWriter } = await import(process.env.LEGACY_PLANNING);
const legacyDb = await import(process.env.DB);
const dj = await import(process.env.DJ);
const llm = await import(process.env.LLM);
const out = {};
const services = await createServices();
out.scan = await services.scanIfEmpty();
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
const db = legacyDb.db;
const byTitle = Object.fromEntries(db.prepare("SELECT id, title FROM tracks").all().map((row) => [row.title, row.id]));
// Legacy history from before v1: a play of a song the v1 executor never started, plus
// plays / radio picks / audits of the upcoming songs that a non-dry-run write-back would overwrite.
const at = "2026-01-01T00:00:00.000Z";
const seedPlay = db.prepare("INSERT INTO plays (track_id, played_at, reason, dj_line) VALUES (?, ?, 'seed', ?)");
const seedPick = db.prepare("INSERT INTO radio_picks (track_id, dj_line, reason, mood_tags, source, created_at) VALUES (?, ?, 'seed', '[]', 'rules', ?)");
const seedAudit = db.prepare("INSERT INTO recommendation_audits (mode, query, selected_track_id, selected_title, selected_artist, family, source, dj_line, reason, score_breakdown, candidates, created_at) VALUES ('radio', '', ?, ?, 'Synth Artist', 'x', 'rules', ?, 'seed', '{}', '[]', ?)");
seedPlay.run(byTitle["Legacy Heard Song"], at, "seeded legacy line");
for (const title of ["Track Two", "Track Three"]) {
  seedPlay.run(byTitle[title], at, "seeded play line");
  seedPick.run(byTitle[title], "seeded pick line", at);
  seedAudit.run(byTitle[title], title, "seeded audit line", at);
}
const legacyRows = () => ({
  plays: db.prepare("SELECT * FROM plays ORDER BY id").all(),
  radioPicks: db.prepare("SELECT * FROM radio_picks ORDER BY id").all(),
  audits: db.prepare("SELECT * FROM recommendation_audits ORDER BY id").all()
});
out.legacyBefore = legacyRows();

const search = await call("GET", "/api/v1/catalog/search?q=Track");
const ref = Object.fromEntries(search.json.tracks.map((entry) => [entry.display.title, entry.track]));
const settle = async (prepared) => {
  let item = prepared.json;
  for (let i = 0; i < 60 && item.status === "active"; i += 1) {
    item = (await call("GET", "/api/v1/playback/preparations/" + item.preparationId + "?afterVersion=" + item.version + "&waitMs=500")).json;
  }
  return item;
};
const prepare = async (itemId, track, from) =>
  settle(await call("POST", "/api/v1/playback/prepare", {
    protocolVersion: 1, itemId, purpose: "program", target: { kind: "track", track },
    narration: from ? { transitionId: "tr-" + itemId, cueId: "cue-" + itemId, fromItemId: from.itemId, fromTrack: from.track, fromRevision: null } : null,
    wantLyrics: false
  }));
const started = (itemId, media) => call("POST", "/api/v1/playback/started", {
  protocolVersion: 1, idempotencyKey: "k-" + itemId, executorInstanceId: "exec", itemId, track: media.track,
  recordingId: media.recording.recordingId, sourceRevision: media.sourceRevision, loadId: "load-" + itemId, positionMs: 0, startedAt: new Date().toISOString()
});

const one = await prepare("item-1", ref["Track One"], null);
out.startedOne = (await started("item-1", one.stages.source.value)).json.status;
const two = await prepare("item-2", ref["Track Two"], { itemId: "item-1", track: ref["Track One"] });
out.scripts = [two.stages.script];
out.startedTwo = (await started("item-2", two.stages.source.value)).json.status;
const three = await prepare("item-3", ref["Track Three"], { itemId: "item-2", track: ref["Track Two"] });
out.scripts.push(three.stages.script);

// A catalog entry without a legacy row, through the same generator the composition gives its writer.
const writer = new LegacyModelScriptWriter(legacyDjLineGenerator({ getTrack: legacyDb.getTrack, generate: dj.generateDjLineForTrack }), llm.hasLlm);
const entry = (title, artist, album, legacyTrackId) => ({ ref: { providerId: "catalog-only", mediaId: title }, display: { title, artist, album }, playable: true, legacyTrackId });
out.metadataOnly = await writer.write({
  to: entry("Unlisted Song", "Catalog Only", "Meta Album", null),
  from: entry("Track Three", "Synth Artist", "", byTitle["Track Three"]),
  recentStarted: [],
  recentGenerated: [],
  signal: new AbortController().signal
});

out.legacyAfter = legacyRows();
out.counts = {
  started: db.prepare("SELECT COUNT(*) AS n FROM playback_started").get().n,
  scripts: db.prepare("SELECT COUNT(*) AS n FROM narration_scripts").get().n,
  candidateAudits: db.prepare("SELECT COUNT(*) AS n FROM playback_candidate_audits").get().n
};
await close();
server.closeAllConnections();
server.close();
services.close();
console.log(JSON.stringify(out));
`;

function runChild(script, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--conditions=source", "--import", path.join(repoRoot, "node_modules/tsx/dist/esm/index.mjs"), "--import", path.join(serverDir, "testing/register-workspace.mjs"), script],
      { cwd, env }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const decisionUser = (request) => request.body.messages.filter((message) => message.role === "user").at(-1).content;
const handoverBlock = (text) => /## Hand-over\n([\s\S]*?)\n\n## Task/.exec(text)?.[1] ?? "";

test("the real DJ chain sends the hand-over (from/to, started history, generated-not-aired lines) in the final model request, dry-run only", async () => {
  const llm = await startFakeLlm();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-dj-chain-"));
  try {
    const dirs = { data: path.join(work, "data"), profile: path.join(work, "profile"), music: path.join(work, "music"), tmp: path.join(work, "tmp") };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(work, "prompts"));
    for (const name of ["dj-persona.md", "dj-fewshot.md"]) fs.copyFileSync(path.join(repoRoot, "prompts", name), path.join(work, "prompts", name));
    ["Track One", "Track Two", "Track Three"].forEach((title, index) => fs.writeFileSync(path.join(dirs.music, `Synth Artist - ${title}.wav`), makeWav(1500, { seed: 30 + index })));
    fs.writeFileSync(path.join(dirs.music, "Old Artist - Legacy Heard Song.wav"), makeWav(1500, { seed: 40 }));
    const script = path.join(work, "child.mjs");
    fs.writeFileSync(script, CHILD);
    const closed = "http://127.0.0.1:9";
    const result = await runChild(
      script,
      {
        PATH: process.env.PATH ?? "",
        TZ: "UTC",
        NODE_ENV: "test",
        DATA_DIR: dirs.data,
        USER_PROFILE_DIR: dirs.profile,
        MUSIC_LIBRARY_DIR: dirs.music,
        TMPDIR: dirs.tmp,
        KUGOU_API_AUTOSTART: "false",
        KUGOU_API_BASE_URL: closed,
        CHAT_AI_BASE_URL: closed,
        FISH_TTS_ENDPOINT: `${closed}/v1/tts`,
        AI_PROVIDER: "fixture",
        AI_BASE_URL: llm.baseUrl,
        AI_API_KEY: SYNTHETIC_KEY,
        AI_MODEL: MODEL,
        DJ_AI_TIMEOUT_MS: "15000",
        COMPOSITION: path.join(serverDir, "composition.ts"),
        APP: path.join(serverDir, "http/app.ts"),
        LEGACY_PLANNING: path.join(serverDir, "adapters/legacy/legacy-planning.ts"),
        DB: path.join(serverDir, "db.ts"),
        DJ: path.join(serverDir, "dj.ts"),
        LLM: path.join(serverDir, "llm.ts")
      },
      work
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SYNTHETIC_KEY), "the key never reaches logs");
    const out = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.match(out.scan, /^Scanned 4 tracks/);
    assert.deepEqual([out.startedOne, out.startedTwo], ["recorded", "recorded"]);
    assert.deepEqual(out.scripts.map((stage) => stage.status), ["ready", "ready"], JSON.stringify(out.scripts));

    // Every outbound request is the real OpenAI-compatible call, with the synthetic key, on loopback.
    assert.ok(llm.requests.every((request) => request.path === "/v1/chat/completions" && request.authorization === `Bearer ${SYNTHETIC_KEY}`));
    assert.ok(llm.requests.every((request) => request.body.model === MODEL && request.body.response_format?.type === "json_object"));
    const decisions = llm.requests.filter((request) => request.kind === "decision");
    assert.equal(decisions.length, 3);
    assert.equal(llm.requests.filter((request) => request.kind === "selector").length, 3, "each line first asks the model to pick few-shots");
    const [first, second, metadataOnly] = decisions.map(decisionUser);
    for (const text of [first, second, metadataOnly]) {
      assert.doesNotMatch(text, /Legacy Heard Song|seeded/, "frozen legacy plays/picks never enter the prompt");
      assert.match(text, /## Task\nReturn strict JSON only\./);
    }

    // First hand-over: One → Two, One is the only started track, nothing generated yet.
    assert.match(first, /当前点播歌曲：Synth Artist《Track Two》/);
    // The scanner takes the album from the folder name ("music"); it is part of the real catalog metadata.
    assert.equal(handoverBlock(first), "上一首（正在结束）：Synth Artist《Track One》（专辑：music）\n最近实际播放过（新→旧）：\n- Synth Artist《Track One》（专辑：music）");
    assert.match(first, new RegExp(`Pick only from these candidate IDs: ${out.legacyBefore.radioPicks[0].track_id}$`, "m"));

    // Second hand-over: Two → Three; the history moved on and the first line is offered as generated, not as heard.
    const firstLine = out.scripts[0].value.text;
    assert.match(firstLine, /^合成串词第1段/);
    assert.match(second, /当前点播歌曲：Synth Artist《Track Three》/);
    assert.equal(
      handoverBlock(second),
      [
        "上一首（正在结束）：Synth Artist《Track Two》（专辑：music）",
        "最近实际播放过（新→旧）：",
        "- Synth Artist《Track Two》（专辑：music）",
        "- Synth Artist《Track One》（专辑：music）",
        "最近生成过的串词（只用于避免重复措辞；不代表已经播出，不要当作已经说过的话来引用）：",
        `- ${firstLine}`
      ].join("\n")
    );
    assert.match(out.scripts[1].value.text, /^合成串词第2段/);

    // A track known only by catalog metadata (no legacy row) still gets a line through the same chain.
    assert.match(metadataOnly, /当前点播歌曲：Catalog Only《Unlisted Song》\n专辑：Meta Album/);
    assert.equal(handoverBlock(metadataOnly), "上一首（正在结束）：Synth Artist《Track Three》");
    assert.match(metadataOnly, /Pick only from these candidate IDs: catalog:Unlisted Song:Catalog Only$/m);
    assert.deepEqual(out.metadataOnly, { text: "合成串词第3段：这一段文字只由本地假模型生成，用来确认交接上下文真的进了请求。", writer: "model" });

    // Dry run: no legacy play / pick / audit row was added or rewritten; generated lines are stored only as scripts.
    assert.deepEqual(out.legacyAfter, out.legacyBefore);
    assert.deepEqual(out.counts, { started: 2, scripts: 2, candidateAudits: 0 });
  } finally {
    await llm.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
});
