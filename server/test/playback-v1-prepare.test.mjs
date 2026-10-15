import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { decode, preparedItemV1Decoder, narrationResponseV1Decoder, resolveResponseV1Decoder } from "@claudio/contracts";
import { ControlledWriter, FakeProvider, FakeRadio, FakeSpeech, fakeTrack } from "../testing/fakes.ts";
import { startHarness } from "../testing/harness.ts";
import { makeWav } from "../testing/wav.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-v1-prepare-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let counter = 0;
const tempDir = () => {
  const dir = path.join(root, `case-${(counter += 1)}`);
  fs.mkdirSync(dir);
  return dir;
};

const LRC = "[ti:Song]\n[00:00.50]作词 : 某人\n[00:01.20]第一句\n[00:02.00]第二句\n";

function setup(options = {}) {
  const a = new FakeProvider("fixture-a");
  const from = a.add(fakeTrack("a0", 3));
  const target = a.add(fakeTrack("a1", 5, { lyrics: { format: "lrc", text: LRC } }));
  const writer = options.writer ?? new ControlledWriter();
  const tts = options.tts ?? new FakeSpeech("tts-one");
  const providers = options.providers ?? [a.module()];
  return { a, from, target, writer, tts, providers, radio: new FakeRadio(() => a.search("", 50)) };
}

const prepareBody = (itemId, track, narration = null, wantLyrics = true) => ({
  protocolVersion: 1,
  itemId,
  purpose: "program",
  target: { kind: "track", track },
  narration,
  wantLyrics
});

const narrationFor = (cueId, fromTrack) => ({
  transitionId: `tr-${cueId}`,
  cueId,
  fromItemId: "item-from",
  fromTrack,
  fromRevision: null
});

async function waitFor(harness, preparationId, predicate, afterVersion = -1) {
  let current = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await harness.request("GET", `/api/v1/playback/preparations/${preparationId}?afterVersion=${afterVersion}&waitMs=500`);
    current = response.json;
    if (predicate(current)) return current;
    afterVersion = current.version;
  }
  assert.fail(`preparation never satisfied predicate: ${JSON.stringify(current?.stages)}`);
}

test("music source is published before script/voice; later versions add script, measured voice and lyrics", async () => {
  const fx = setup();
  const harness = await startHarness({ dir: tempDir(), ...fx });
  try {
    const { status, json } = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-1", fx.target, narrationFor("cue-1", fx.from)));
    assert.equal(status, 200);
    assert.ok(decode(preparedItemV1Decoder, json).ok, "response matches the shared contract");
    assert.equal(json.status, "active");
    assert.equal(json.stages.candidate.status, "ready");
    assert.equal(json.stages.source.status, "ready", "music can load while the script is still being written");
    assert.equal(json.stages.script.status, "in-progress");
    assert.equal(json.stages.voice.status, "pending");
    const media = json.stages.source.value;
    assert.match(media.stream.handle, /^\/api\/v1\/playback\/streams\//);
    assert.equal(media.recording.confidence, "content-hash");
    assert.deepEqual(media.duration, { kind: "known", ms: 1500, source: "container-metadata" });
    assert.equal(JSON.stringify(json).includes("binding"), false, "no private binding leaks");

    assert.equal(fx.writer.release("雨停了，下一首慢慢进来。"), 1);
    const done = await waitFor(harness, json.preparationId, (item) => item.status === "ready", json.version);
    assert.ok(done.version > json.version);
    assert.equal(done.stages.script.value.text, "雨停了，下一首慢慢进来。");
    assert.deepEqual(done.stages.script.value.subtitle, { timing: "plain-text", segments: [{ text: "雨停了，下一首慢慢进来。" }] });
    const voice = done.stages.voice.value;
    assert.equal(voice.scriptAssetId, done.stages.script.value.assetId);
    assert.equal(voice.duration.kind, "known", "voice length is measured from the produced audio");
    assert.equal(voice.duration.ms, "雨停了，下一首慢慢进来。".length * 40);
    assert.equal(voice.playbackRate, 0.86);
    assert.equal(done.stages.lyrics.value.status, "available");
    assert.equal(done.stages.lyrics.value.asset.sourceRevision, media.sourceRevision);
    assert.equal(done.stages.lyrics.value.asset.timing, "native-line");

    // Media handle serves exactly the bound bytes, with ranges.
    const ranged = await fetch(`${harness.baseUrl}${media.stream.handle}`, { headers: { Range: "bytes=0-99" } });
    assert.equal(ranged.status, 206);
    assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), fx.a.tracks.get("a1").bytes.subarray(0, 100));
    const unsatisfiable = await fetch(`${harness.baseUrl}${media.stream.handle}`, { headers: { Range: "bytes=999999-" } });
    assert.equal(unsatisfiable.status, 416);
    await unsatisfiable.arrayBuffer();
    const voiceAudio = await fetch(`${harness.baseUrl}${voice.stream.handle}`);
    assert.equal(voiceAudio.status, 200);
    assert.equal(voiceAudio.headers.get("content-type"), "audio/wav");
    await voiceAudio.arrayBuffer();

    // Preparing is not listening: nothing in legacy plays or v1 started.
    assert.equal(harness.db.prepare("SELECT COUNT(*) AS n FROM plays").get().n, 0);
    assert.equal(harness.db.prepare("SELECT COUNT(*) AS n FROM playback_started").get().n, 0);
    const scriptRow = harness.db.prepare("SELECT cue_id FROM narration_scripts").get();
    assert.equal(scriptRow.cue_id, "cue-1", "script stored by cue identity");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("cancelling while the writer is pending settles every stage and drops the late script", async () => {
  const fx = setup();
  const harness = await startHarness({ dir: tempDir(), ...fx });
  try {
    const { json } = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-c", fx.target, narrationFor("cue-c", fx.from)));
    const cancelled = await harness.request("DELETE", `/api/v1/playback/preparations/${json.preparationId}`);
    assert.equal(cancelled.json.status, "cancelled");
    assert.equal(cancelled.json.stages.script.status, "cancelled");
    assert.equal(cancelled.json.stages.voice.status, "cancelled");
    assert.equal(fx.writer.release("迟到的稿子"), 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await harness.request("GET", `/api/v1/playback/preparations/${json.preparationId}`);
    assert.equal(after.json.version, cancelled.json.version, "late result publishes nothing");
    assert.equal(harness.db.prepare("SELECT COUNT(*) AS n FROM narration_scripts").get().n, 0);
    assert.equal(fx.tts.calls, 0);
    const cue = await harness.request("POST", "/api/v1/playback/narration", {
      protocolVersion: 1,
      cueId: "cue-c",
      transitionId: "tr-cue-c",
      preparationId: json.preparationId,
      from: { itemId: "item-from", track: fx.from, sourceRevision: null },
      to: { itemId: "item-c", track: fx.target, sourceRevision: null }
    });
    assert.equal(cue.json.script.status, "cancelled", "the cue stays cancelled; a retry needs a new cueId");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("a source that misses its deadline is timed-out and the preparation fails", async () => {
  const fx = setup();
  fx.a.add(fakeTrack("slow", 9, { resolveDelayMs: 5_000 }));
  const harness = await startHarness({ dir: tempDir(), ...fx, policy: { sourceDeadlineMs: 60 } });
  try {
    const { json } = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-slow", { providerId: "fixture-a", mediaId: "slow" }));
    assert.equal(json.status, "failed");
    assert.equal(json.stages.source.status, "timed-out");
    assert.equal(json.stages.lyrics.status, "skipped");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("lyrics answer only for the exact resolved revision", async () => {
  const fx = setup();
  const harness = await startHarness({ dir: tempDir(), ...fx });
  try {
    const resolved = await harness.request("POST", "/api/v1/playback/resolve", {
      protocolVersion: 1,
      itemId: "item-l",
      track: fx.target,
      preparationId: null,
      reason: "initial",
      previousRevision: null
    });
    assert.ok(decode(resolveResponseV1Decoder, resolved.json).ok);
    const { sourceRevision, recording } = resolved.json.media;
    const ask = (overrides) =>
      harness.request("POST", "/api/v1/playback/lyrics", {
        protocolVersion: 1,
        itemId: "item-l",
        track: fx.target,
        recordingId: recording.recordingId,
        sourceRevision,
        ...overrides
      });
    const ok = await ask({});
    assert.equal(ok.status, 200);
    assert.equal(ok.json.result.status, "available");
    assert.deepEqual(ok.json.result.asset.lines.map((line) => line.text), ["作词 : 某人", "第一句", "第二句"]);
    assert.equal((await ask({ recordingId: "someone-else" })).json.error.code, "revision_mismatch");
    const unknown = await ask({ sourceRevision: "never-resolved" });
    assert.equal(unknown.status, 410);
    assert.equal(unknown.json.error.code, "unknown_source_revision");
    const wrongTrack = await ask({ track: fx.from });
    assert.equal(wrongTrack.status, 400);
    const badVersion = await ask({ protocolVersion: 2 });
    assert.equal(badVersion.status, 400);
    assert.equal(badVersion.json.error.code, "invalid_request");
    const missing = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-nolyrics", fx.from));
    const settled = await waitFor(harness, missing.json.preparationId, (item) => item.status === "ready");
    assert.deepEqual(settled.stages.lyrics.value, { status: "missing", reason: "not-found" });
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("a second provider and a second TTS run through the same use cases", async () => {
  const fx = setup();
  const b = new FakeProvider("fixture-b");
  const bTrack = b.add(fakeTrack("b1", 11, { lyrics: { format: "krc", text: "[1000,800]<0,400,0>新<400,400,0>歌\n" } }));
  const writer = new ControlledWriter();
  writer.immediate = "换个声音";
  const one = await startHarness({ dir: tempDir(), ...fx, writer, providers: [fx.a.module(), b.module()], tts: new FakeSpeech("tts-one") });
  const two = await startHarness({ dir: tempDir(), ...fx, writer, providers: [fx.a.module(), b.module()], tts: new FakeSpeech("tts-two") });
  try {
    for (const harness of [one, two]) {
      const { json } = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-b", bTrack, narrationFor("cue-b", fx.from)));
      const done = await waitFor(harness, json.preparationId, (item) => item.status === "ready");
      assert.equal(done.stages.source.value.track.providerId, "fixture-b");
      assert.equal(done.stages.lyrics.value.asset.timing, "native-word", "provider word times kept");
      assert.equal(done.stages.voice.status, "ready");
      const narration = await harness.request("POST", "/api/v1/playback/narration", {
        protocolVersion: 1,
        cueId: "cue-b",
        transitionId: "tr-cue-b",
        preparationId: json.preparationId,
        from: { itemId: "item-from", track: fx.from, sourceRevision: null },
        to: { itemId: "item-b", track: bTrack, sourceRevision: null }
      });
      assert.ok(decode(narrationResponseV1Decoder, narration.json).ok);
      assert.equal(narration.json.voice.status, "ready");
    }
    const keyOne = one.db.prepare("SELECT content_key, descriptor FROM voice_cache").get();
    const keyTwo = two.db.prepare("SELECT content_key, descriptor FROM voice_cache").get();
    assert.notEqual(keyOne.content_key, keyTwo.content_key, "voice cache key includes the TTS provider");
    assert.match(keyOne.descriptor, /tts-one/);
    assert.match(keyTwo.descriptor, /tts-two/);
  } finally {
    await one.close({ closeDb: true });
    await two.close({ closeDb: true });
  }
});

test("cues with identical text share one synthesis; cancelling one leaves the other", async () => {
  const fx = setup();
  fx.writer.immediate = "同一句";
  let open;
  fx.tts.gate = new Promise((resolve) => {
    open = resolve;
  });
  const harness = await startHarness({ dir: tempDir(), ...fx });
  const cue = (cueId, itemId) =>
    harness.request("POST", `/api/v1/playback/narration?waitMs=0`, {
      protocolVersion: 1,
      cueId,
      transitionId: `tr-${cueId}`,
      preparationId: null,
      from: { itemId: "item-from", track: fx.from, sourceRevision: null },
      to: { itemId, track: fx.target, sourceRevision: null }
    });
  try {
    await cue("cue-x", "item-x");
    await cue("cue-y", "item-y");
    for (let attempt = 0; attempt < 50 && fx.tts.calls < 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fx.tts.calls, 1, "one synthesis for both cues");
    const cancelled = await harness.request("DELETE", "/api/v1/playback/narration/cue-x");
    assert.equal(cancelled.json.voice.status, "cancelled");
    open();
    const latest = await harness.request("POST", `/api/v1/playback/narration?afterVersion=${cancelled.json.version}&waitMs=2000`, {
      protocolVersion: 1,
      cueId: "cue-y",
      transitionId: "tr-cue-y",
      preparationId: null,
      from: { itemId: "item-from", track: fx.from, sourceRevision: null },
      to: { itemId: "item-y", track: fx.target, sourceRevision: null }
    });
    let voice = latest.json.voice;
    for (let attempt = 0; attempt < 20 && voice.status !== "ready"; attempt += 1) {
      const again = await harness.request("POST", `/api/v1/playback/narration?waitMs=500&afterVersion=-1`, {
        protocolVersion: 1,
        cueId: "cue-y",
        transitionId: "tr-cue-y",
        preparationId: null,
        from: { itemId: "item-from", track: fx.from, sourceRevision: null },
        to: { itemId: "item-y", track: fx.target, sourceRevision: null }
      });
      voice = again.json.voice;
    }
    assert.equal(voice.status, "ready");
    assert.equal(fx.tts.aborted, 0, "the shared synthesis was not aborted by one subscriber");
    const conflict = await cue("cue-y", "another-item");
    assert.equal(conflict.status, 409);
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("refresh keeps the revision for the same recording; changed content is a new revision and the old handle stops", async () => {
  const fx = setup();
  const harness = await startHarness({ dir: tempDir(), ...fx });
  const resolve = (reason, previousRevision) =>
    harness.request("POST", "/api/v1/playback/resolve", {
      protocolVersion: 1,
      itemId: "item-r",
      track: fx.target,
      preparationId: null,
      reason,
      previousRevision
    });
  try {
    const first = (await resolve("initial", null)).json.media;
    const refreshed = (await resolve("refresh", first.sourceRevision)).json.media;
    assert.equal(refreshed.sourceRevision, first.sourceRevision);
    assert.notEqual(refreshed.stream.handle, first.stream.handle, "a fresh handle per resolution");
    fx.a.tracks.get("a1").bytes = makeWav(1500, { seed: 99 });
    const changed = (await resolve("retry", first.sourceRevision)).json.media;
    assert.notEqual(changed.sourceRevision, first.sourceRevision);
    assert.notEqual(changed.recording.recordingId, first.recording.recordingId);
    const stale = await harness.request("GET", first.stream.handle);
    assert.equal(stale.status, 410, "an old handle never serves another recording");
    assert.equal(stale.json.error.code, "fake_source_changed");
  } finally {
    await harness.close({ closeDb: true });
  }
});
