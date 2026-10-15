import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { decode, narrationResponseV1Decoder, narrationScriptDecoder } from "@claudio/contracts";
import { MAX_NARRATION_TEXT_LENGTH } from "../application/narration/limits.ts";
import { invalidContextDjLineReason } from "../dj-validator.ts";
import { FakeProvider, FakeRadio, FakeSpeech, fakeTrack } from "../testing/fakes.ts";
import { startHarness } from "../testing/harness.ts";
import { makeWav } from "../testing/wav.ts";

const serverDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(serverDir);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-narration-length-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// Obviously fake credentials: the only model and speech endpoints are the loopback server below.
const SYNTHETIC_KEY = "sk-synthetic-claudio-length-key-not-real";
const SELECTOR_SYSTEM = "你只负责为电台串词挑选参考范式";

/** A complete synthetic line of exactly `length` UTF-16 code units, ending with a full stop. */
function makeLine(length, label = "") {
  const sentence = "这一段只是用于检查口播边界，接下来一起听歌。";
  let text = `合成歌手的《Track Two》${label}。`;
  while (text.length + sentence.length + 1 <= length) text += sentence;
  text += "好".repeat(length - text.length - 1) + "。";
  assert.equal(text.length, length);
  return text;
}

test("the shared narration bound is the DJ validator's 600, measured in UTF-16 code units, inside the stored-asset bound", () => {
  assert.equal(MAX_NARRATION_TEXT_LENGTH, 600);
  const track = { id: "t", title: "Track Two", artist: "Synth Artist", album: "", genre: "", tags: [] };
  assert.equal(invalidContextDjLineReason(makeLine(600), track), "");
  assert.equal(invalidContextDjLineReason(makeLine(601), track), "too long");
  // Emoji count as two code units each: 300 of them are exactly at the bound.
  assert.equal(invalidContextDjLineReason("😀".repeat(300), track), "");
  assert.equal(invalidContextDjLineReason("😀".repeat(300) + "。", track), "too long");
  // Already stored assets keep decoding up to the wire bound, which stays above the generation bound.
  const stored = { assetId: "scr-old", version: 1, text: "旧".repeat(4000), subtitle: { timing: "plain-text", segments: [{ text: "旧".repeat(2000) }] } };
  assert.ok(decode(narrationScriptDecoder, stored).ok);
  assert.ok(MAX_NARRATION_TEXT_LENGTH <= 4000);
});

/**
 * Loopback stand-in for both upstreams: the OpenAI-compatible model (selector
 * round + locked-song decision, whose `say` has the next queued length) and
 * the Fish TTS endpoint (a measurable 1 s WAV).
 */
async function startUpstream(lengths) {
  const requests = [];
  const queue = [...lengths];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (req.url === "/tts") {
        requests.push({ kind: "tts", authorization: req.headers.authorization, textLength: body.text.length, text: body.text });
        const wav = makeWav(1000, { seed: 5 });
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
        res.end(wav);
        return;
      }
      const system = body.messages.find((message) => message.role === "system")?.content ?? "";
      const user = body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      let content;
      if (system.startsWith(SELECTOR_SYSTEM)) {
        requests.push({ kind: "selector" });
        content = JSON.stringify({ selected: [...user.matchAll(/^\[(\d+)\]/gm)].slice(0, 2).map((match) => Number(match[1])) });
      } else {
        const length = queue.shift();
        const candidate = /Pick only from these candidate IDs: (.+)$/m.exec(user)?.[1].trim();
        requests.push({ kind: "decision", length, user });
        content = JSON.stringify({ say: makeLine(length, `第${length}号`), play: [candidate], reason: "fixture", segue: "talk_first" });
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// The REAL composition (legacy model writer + validator, SQLite, local
// adapter, v1 cue/voice services, Fish adapter over HTTP) in a child with an
// isolated cwd, temporary data dirs and a whitelisted environment.
const CHILD = `
const { createServices } = await import(process.env.COMPOSITION);
const { createApp } = await import(process.env.APP);
const legacyDb = await import(process.env.DB);
const services = await createServices();
const out = { scan: await services.scanIfEmpty(), cues: [] };
const { app, close } = createApp(services.appDeps);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const call = async (method, url, body) => {
  const response = await fetch(base + url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, json: await response.json() };
};
const db = legacyDb.db;
const count = (table) => db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
const search = await call("GET", "/api/v1/catalog/search?q=Track");
const ref = Object.fromEntries(search.json.tracks.map((entry) => [entry.display.title, entry.track]));
const resolve = async (itemId, track) =>
  (await call("POST", "/api/v1/playback/resolve", { protocolVersion: 1, itemId, track, preparationId: null, reason: "initial", previousRevision: null })).json.media;
const from = await resolve("item-a", ref["Track One"]);
const to = await resolve("item-b", ref["Track Two"]);
for (const length of JSON.parse(process.env.LENGTHS)) {
  const before = { scripts: count("narration_scripts"), voices: count("voice_cache") };
  const response = await call("POST", "/api/v1/playback/narration?waitMs=10000", {
    protocolVersion: 1, cueId: "cue-" + length, transitionId: "tr-" + length, preparationId: null,
    from: { itemId: "item-a", track: from.track, sourceRevision: from.sourceRevision },
    to: { itemId: "item-b", track: to.track, sourceRevision: to.sourceRevision }
  });
  out.cues.push({ length, ...response, added: { scripts: count("narration_scripts") - before.scripts, voices: count("voice_cache") - before.voices } });
}
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

test("through the real DJ chain and HTTP, every script the validator accepts reaches the voice stage; a longer one fails as a script with no side effects", async () => {
  // 601 sits between the others so the following cue shows the rejected line never became "recently generated".
  const lengths = [500, 501, 601, 600];
  const upstream = await startUpstream(lengths);
  const work = fs.mkdtempSync(path.join(root, "chain-"));
  try {
    const dirs = { data: path.join(work, "data"), profile: path.join(work, "profile"), music: path.join(work, "music"), tmp: path.join(work, "tmp") };
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(work, "prompts"));
    for (const name of ["dj-persona.md", "dj-fewshot.md"]) fs.copyFileSync(path.join(repoRoot, "prompts", name), path.join(work, "prompts", name));
    ["Track One", "Track Two"].forEach((title, index) => fs.writeFileSync(path.join(dirs.music, `Synth Artist - ${title}.wav`), makeWav(1500, { seed: 60 + index })));
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
        AI_PROVIDER: "fixture",
        AI_BASE_URL: `${upstream.base}/v1`,
        AI_API_KEY: SYNTHETIC_KEY,
        AI_MODEL: "fixture-dj-model",
        DJ_AI_TIMEOUT_MS: "15000",
        FISH_TTS_API_KEY: SYNTHETIC_KEY,
        FISH_TTS_ENDPOINT: `${upstream.base}/tts`,
        FISH_TTS_FORMAT: "wav",
        LENGTHS: JSON.stringify(lengths),
        COMPOSITION: path.join(serverDir, "composition.ts"),
        APP: path.join(serverDir, "http/app.ts"),
        DB: path.join(serverDir, "db.ts")
      },
      work
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(SYNTHETIC_KEY), "the key never reaches logs");
    const out = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.match(out.scan, /^Scanned 2 tracks/);
    const byLength = Object.fromEntries(out.cues.map((cue) => [cue.length, cue]));
    for (const cue of out.cues) {
      assert.equal(cue.status, 200);
      assert.ok(decode(narrationResponseV1Decoder, cue.json).ok, JSON.stringify(cue.json));
    }

    for (const length of [500, 501, 600]) {
      const { json, added } = byLength[length];
      assert.equal(json.script.status, "ready", `${length}: ${JSON.stringify(json.script)}`);
      assert.equal(json.script.value.text, makeLine(length, `第${length}号`), "the whole line is kept, never cut");
      assert.deepEqual(json.script.value.subtitle.segments, [{ text: json.script.value.text }]);
      assert.equal(json.voice.status, "ready", `${length}: ${JSON.stringify(json.voice)}`);
      assert.equal(json.voice.value.scriptAssetId, json.script.value.assetId);
      assert.deepEqual(added, { scripts: 1, voices: 1 });
    }
    const rejected = byLength[601];
    assert.equal(rejected.json.script.status, "failed");
    assert.equal(rejected.json.script.error.code, "script_rejected");
    assert.deepEqual(rejected.json.voice, { status: "skipped", reason: "script-unavailable" });
    assert.deepEqual(rejected.added, { scripts: 0, voices: 0 });

    // One synthesis per accepted script, with the exact stored text; none for the rejected one.
    const tts = upstream.requests.filter((request) => request.kind === "tts");
    assert.deepEqual(tts.map((request) => request.textLength), [500, 501, 600]);
    assert.ok(tts.every((request) => request.authorization === `Bearer ${SYNTHETIC_KEY}`));
    assert.deepEqual(tts.map((request) => request.text), [500, 501, 600].map((length) => byLength[length].json.script.value.text));

    // The cue after the rejection is offered the accepted lines as recently generated, never the rejected one.
    const decisions = upstream.requests.filter((request) => request.kind === "decision");
    assert.deepEqual(decisions.map((request) => request.length), lengths);
    const last = decisions.at(-1).user;
    // The hand-over clips each line, so the labels near the start identify them.
    assert.ok(last.includes("第500号") && last.includes("第501号"));
    assert.ok(!last.includes("第601号"));
  } finally {
    await upstream.close();
  }
});

/** A writer that skips the DJ validator entirely and returns whatever the test sets. */
class DirectWriter {
  requests = [];
  next = "";
  async write(request) {
    this.requests.push(request);
    return { text: this.next, writer: "direct" };
  }
}

test("the cue service itself enforces the bound: a writer that bypasses the validator gets no stored, recent or spoken over-long script", async () => {
  const provider = new FakeProvider("fixture-len");
  const [a, b] = ["la", "lb"].map((id, index) => provider.add(fakeTrack(id, index + 3, { title: `Title ${id}`, artist: `Artist ${id}` })));
  const writer = new DirectWriter();
  const tts = new FakeSpeech("tts-len", 1);
  const harness = await startHarness({ dir: fs.mkdtempSync(path.join(root, "direct-")), providers: [provider.module()], writer, tts, radio: new FakeRadio(() => []) });
  const count = (table) => harness.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const cue = (cueId) =>
    harness.request("POST", "/api/v1/playback/narration?waitMs=3000", {
      protocolVersion: 1,
      cueId,
      transitionId: `tr-${cueId}`,
      preparationId: null,
      from: { itemId: "item-a", track: a, sourceRevision: null },
      to: { itemId: "item-b", track: b, sourceRevision: null }
    });
  try {
    // Exactly at the bound (here with surrogate pairs): stored whole and spoken.
    writer.next = `  ${"😀".repeat(300)}  `;
    const atBound = await cue("cue-600");
    assert.equal(atBound.json.script.status, "ready");
    assert.equal(atBound.json.script.value.text, "😀".repeat(300));
    assert.equal(atBound.json.voice.status, "ready");
    assert.equal(tts.calls, 1);

    // One code unit over: rejected before anything is stored or synthesized — not cut to fit.
    const scripts = count("narration_scripts");
    const voices = count("voice_cache");
    writer.next = "😀".repeat(300) + "。";
    const over = await cue("cue-601");
    assert.equal(over.status, 200);
    assert.ok(decode(narrationResponseV1Decoder, over.json).ok);
    assert.equal(over.json.script.status, "failed");
    assert.equal(over.json.script.error.code, "script_too_long");
    assert.equal(over.json.script.error.class, "invalid");
    assert.deepEqual(over.json.voice, { status: "skipped", reason: "script-unavailable" });
    assert.equal(count("narration_scripts"), scripts);
    assert.equal(count("voice_cache"), voices);
    assert.equal(tts.calls, 1);

    // The rejected text never becomes recently generated wording for the next writer.
    writer.next = "下一段，正常长度。";
    const after = await cue("cue-next");
    assert.equal(after.json.voice.status, "ready");
    assert.deepEqual(writer.requests.at(-1).recentGenerated, ["😀".repeat(300)]);
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("a cue stored before this bound with a longer script still reads back through HTTP", async () => {
  const provider = new FakeProvider("fixture-old");
  const [a, b] = ["oa", "ob"].map((id, index) => provider.add(fakeTrack(id, index + 3)));
  const writer = new DirectWriter();
  const harness = await startHarness({ dir: fs.mkdtempSync(path.join(root, "stored-")), providers: [provider.module()], writer, tts: new FakeSpeech(), radio: new FakeRadio(() => []) });
  try {
    const text = "旧".repeat(1200);
    const now = Date.UTC(2026, 9, 1);
    harness.assembly.stores.cues.insert({
      cueId: "cue-old",
      transitionId: "tr-old",
      preparationId: null,
      fromItemId: "item-a",
      toItemId: "item-b",
      fromTrack: a,
      toTrack: b,
      fromRevision: null,
      toRevision: null,
      version: 3,
      script: { status: "ready", value: { assetId: "scr-old", version: 1, text, subtitle: { timing: "plain-text", segments: [{ text: "旧".repeat(1000) }] } } },
      voice: { status: "failed", error: { class: "invalid", code: "voice_text_too_long" } },
      createdAt: now,
      updatedAt: now
    });
    const response = await harness.request("POST", "/api/v1/playback/narration?waitMs=0", {
      protocolVersion: 1,
      cueId: "cue-old",
      transitionId: "tr-old",
      preparationId: null,
      from: { itemId: "item-a", track: a, sourceRevision: null },
      to: { itemId: "item-b", track: b, sourceRevision: null }
    });
    assert.equal(response.status, 200);
    assert.ok(decode(narrationResponseV1Decoder, response.json).ok);
    assert.equal(response.json.script.value.text, text);
    assert.equal(writer.requests.length, 0, "an existing cue is returned, not rewritten");
  } finally {
    await harness.close({ closeDb: true });
  }
});
