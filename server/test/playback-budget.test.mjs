import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { PLAYBACK_BUDGETS, PLAYBACK_HTTP_TIMEOUTS } from "@claudio/contracts";
import { BUDGET_BOUNDS, DEFAULT_PLAYBACK_POLICY, resolvePolicy } from "../application/policy.ts";
import { readPlaybackSettings } from "../composition.ts";
import { ControlledWriter, FakeProvider, FakeRadio, FakeSpeech, fakeTrack } from "../testing/fakes.ts";
import { startHarness } from "../testing/harness.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-v1-budget-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let counter = 0;
const tempDir = () => {
  const dir = path.join(root, `case-${(counter += 1)}`);
  fs.mkdirSync(dir);
  return dir;
};

/** Settles only when the test says so; never looks at the signal it was given. */
const never = () => new Promise(() => undefined);

class DeafLyricsProvider extends FakeProvider {
  lyricsCalls = 0;
  async fetch() {
    this.lyricsCalls += 1;
    return never();
  }
}

class DeafSourceProvider extends FakeProvider {
  async resolve(ref, context) {
    if (ref.mediaId === "deaf") {
      this.resolveCalls += 1;
      return never();
    }
    return super.resolve(ref, context);
  }
}

class DeafSpeech extends FakeSpeech {
  async synthesize() {
    this.calls += 1;
    return never();
  }
}

function setup(provider = new FakeProvider("fixture-a"), tts = new FakeSpeech("tts-one")) {
  const from = provider.add(fakeTrack("a0", 3));
  const target = provider.add(fakeTrack("a1", 5, { lyrics: { format: "lrc", text: "[00:01.00]第一句\n" } }));
  return { provider, from, target, writer: new ControlledWriter(), tts, providers: [provider.module()], radio: new FakeRadio(() => provider.search("", 50)) };
}

const prepareBody = (itemId, track, { narration = null, wantLyrics = false } = {}) => ({
  protocolVersion: 1,
  itemId,
  purpose: "program",
  target: { kind: "track", track },
  narration,
  wantLyrics
});

async function pollUntil(harness, item, predicate) {
  let current = item;
  for (let attempt = 0; attempt < 40 && !predicate(current); attempt += 1) {
    current = (await harness.request("GET", `/api/v1/playback/preparations/${current.preparationId}?afterVersion=${current.version}&waitMs=2000`)).json;
  }
  assert.ok(predicate(current), `never satisfied: ${JSON.stringify(current.stages)}`);
  return current;
}

test("server stage deadlines and long-poll holds come from the shared budget and every HTTP hold ends before the client's timeout", () => {
  assert.equal(DEFAULT_PLAYBACK_POLICY.candidateDeadlineMs, PLAYBACK_BUDGETS.candidateMs);
  assert.equal(DEFAULT_PLAYBACK_POLICY.sourceDeadlineMs, PLAYBACK_BUDGETS.sourceMs);
  assert.equal(DEFAULT_PLAYBACK_POLICY.lyricsDeadlineMs, PLAYBACK_BUDGETS.lyricsMs);
  assert.equal(DEFAULT_PLAYBACK_POLICY.scriptDeadlineMs, PLAYBACK_BUDGETS.scriptMs);
  assert.equal(DEFAULT_PLAYBACK_POLICY.voiceDeadlineMs, PLAYBACK_BUDGETS.voiceMs);
  assert.equal(DEFAULT_PLAYBACK_POLICY.prepareResponseWaitMs, PLAYBACK_BUDGETS.longPollMs);
  assert.equal(DEFAULT_PLAYBACK_POLICY.maxLongPollMs, PLAYBACK_BUDGETS.longPollMs);

  // Whatever a deployment configures, the exchanges a browser times out stay inside its timeout.
  const widest = resolvePolicy(Object.fromEntries(Object.keys(BUDGET_BOUNDS).map((key) => [key, Number.MAX_SAFE_INTEGER])));
  assert.ok(widest.prepareResponseWaitMs < PLAYBACK_HTTP_TIMEOUTS.longPollRequestMs, "POST prepare");
  assert.ok(widest.maxLongPollMs < PLAYBACK_HTTP_TIMEOUTS.longPollRequestMs, "GET preparation / POST narration");
  assert.ok(widest.sourceDeadlineMs < PLAYBACK_HTTP_TIMEOUTS.resolveRequestMs, "POST resolve");
  assert.ok(widest.lyricsDeadlineMs < PLAYBACK_HTTP_TIMEOUTS.lyricsRequestMs, "POST lyrics");
  for (const [key, bound] of Object.entries(BUDGET_BOUNDS)) assert.equal(widest[key], bound, key);

  const lowered = resolvePolicy({ sourceDeadlineMs: 60, maxLongPollMs: 500, voicePlaybackRate: 1.7, maxTtlMs: 60_000 });
  assert.equal(lowered.sourceDeadlineMs, 60, "lowering is kept");
  assert.equal(lowered.maxLongPollMs, 500);
  assert.equal(lowered.voicePlaybackRate, 1.7, "not a deadline: never capped");
  assert.equal(lowered.maxTtlMs, 60_000, "not a deadline: never capped");
});

test("deadline env overrides only lower: above the budget is capped with a notice, invalid is ignored with a notice, the voice rate is not a deadline", () => {
  const settings = readPlaybackSettings({
    CLAUDIO_SOURCE_DEADLINE_MS: "5000",
    CLAUDIO_SCRIPT_DEADLINE_MS: "600000",
    CLAUDIO_VOICE_DEADLINE_MS: "abc",
    CLAUDIO_LYRICS_DEADLINE_MS: "-1",
    CLAUDIO_VOICE_PLAYBACK_RATE: "1.5"
  });
  assert.deepEqual(settings.policy, { sourceDeadlineMs: 5000, scriptDeadlineMs: PLAYBACK_BUDGETS.scriptMs, voicePlaybackRate: 1.5 });
  assert.equal(settings.notices.length, 3);
  assert.match(settings.notices.find((line) => line.startsWith("CLAUDIO_SCRIPT_DEADLINE_MS")), /exceeds the shared playback budget; using 90000 ms/);
  assert.match(settings.notices.find((line) => line.startsWith("CLAUDIO_VOICE_DEADLINE_MS")), /not a positive finite number; ignored/);
  assert.match(settings.notices.find((line) => line.startsWith("CLAUDIO_LYRICS_DEADLINE_MS")), /not a positive finite number; ignored/);

  const bigRate = readPlaybackSettings({ CLAUDIO_VOICE_PLAYBACK_RATE: "250000" });
  assert.equal(bigRate.policy.voicePlaybackRate, 250000, "the rate is never clamped to a deadline");
  assert.deepEqual(bigRate.notices, []);
  assert.deepEqual(readPlaybackSettings({}).notices, []);
  assert.deepEqual(readPlaybackSettings({ CLAUDIO_SOURCE_DEADLINE_MS: "" }).policy, {}, "empty means unset");
});

test("an assembled server caps raised deadlines and long-poll holds at the shared budget", async () => {
  const fx = setup();
  const harness = await startHarness({
    dir: tempDir(),
    ...fx,
    policy: { scriptDeadlineMs: 10 * 60_000, prepareResponseWaitMs: 20_000, maxLongPollMs: 25_000, sourceDeadlineMs: 1234 }
  });
  try {
    const policy = harness.assembly.services.policy;
    assert.equal(policy.scriptDeadlineMs, PLAYBACK_BUDGETS.scriptMs);
    assert.equal(policy.prepareResponseWaitMs, PLAYBACK_BUDGETS.longPollMs);
    assert.equal(policy.maxLongPollMs, PLAYBACK_BUDGETS.longPollMs);
    assert.equal(policy.sourceDeadlineMs, 1234);
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("POST prepare answers 'active' when the hold elapses; the source keeps resolving and a long-poll then observes it ready", async () => {
  const fx = setup();
  const slow = fx.provider.add(fakeTrack("slow", 11, { resolveDelayMs: 600 }));
  const harness = await startHarness({ dir: tempDir(), ...fx, policy: { prepareResponseWaitMs: 100 } });
  try {
    const began = Date.now();
    const { status, json } = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-slow", slow));
    const held = Date.now() - began;
    assert.equal(status, 200);
    assert.equal(json.status, "active");
    assert.equal(json.stages.source.status, "in-progress", "answered before the source settled");
    assert.ok(held < 550, `POST held ${held} ms; it must answer at the hold, not wait for the source`);

    const settled = await pollUntil(harness, json, (item) => item.stages.source.status !== "in-progress");
    assert.equal(settled.stages.source.status, "ready", "the early answer did not cancel the work");
    assert.equal(settled.preparationId, json.preparationId);
    assert.equal(fx.provider.resolveCalls, 1, "no second resolution");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("with the default policy a POST prepare whose source never settles answers within longPollMs, before the client's HTTP timeout", async () => {
  const fx = setup(new DeafSourceProvider("fixture-a"));
  const deaf = fx.provider.add(fakeTrack("deaf", 13));
  const harness = await startHarness({ dir: tempDir(), ...fx });
  try {
    const began = Date.now();
    const { json } = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-deaf", deaf));
    const held = Date.now() - began;
    assert.equal(json.status, "active");
    assert.equal(json.stages.source.status, "in-progress");
    assert.ok(held >= PLAYBACK_BUDGETS.longPollMs - 50, `held ${held} ms`);
    assert.ok(held < PLAYBACK_HTTP_TIMEOUTS.longPollRequestMs - 1000, `held ${held} ms, client gives up at ${PLAYBACK_HTTP_TIMEOUTS.longPollRequestMs}`);
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("a source provider that ignores abort still ends at the source deadline: the stage is timed-out, the preparation fails", async () => {
  const fx = setup(new DeafSourceProvider("fixture-a"));
  const deaf = fx.provider.add(fakeTrack("deaf", 13));
  const harness = await startHarness({ dir: tempDir(), ...fx, policy: { sourceDeadlineMs: 80 } });
  try {
    const { json } = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-deaf", deaf));
    const settled = await pollUntil(harness, json, (item) => item.status !== "active");
    assert.equal(settled.status, "failed");
    assert.equal(settled.stages.source.status, "timed-out");

    const resolve = await harness.request("POST", "/api/v1/playback/resolve", {
      protocolVersion: 1,
      itemId: "item-deaf-2",
      track: deaf,
      preparationId: null,
      reason: "initial",
      previousRevision: null
    });
    assert.equal(resolve.json.error.code, "deadline_exceeded", "the synchronous resolve answers too");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("a lyrics port that ignores abort is bounded by the lyrics deadline: HTTP answers, the shared flight ends, a later ask starts afresh", async () => {
  const fx = setup(new DeafLyricsProvider("fixture-a"));
  const harness = await startHarness({ dir: tempDir(), ...fx, policy: { lyricsDeadlineMs: 80 } });
  try {
    const resolved = await harness.request("POST", "/api/v1/playback/resolve", {
      protocolVersion: 1,
      itemId: "item-l",
      track: fx.target,
      preparationId: null,
      reason: "initial",
      previousRevision: null
    });
    const { sourceRevision, recording } = resolved.json.media;
    const ask = () =>
      harness.request("POST", "/api/v1/playback/lyrics", {
        protocolVersion: 1,
        itemId: "item-l",
        track: fx.target,
        recordingId: recording.recordingId,
        sourceRevision
      });
    const began = Date.now();
    const [first, joined] = await Promise.all([ask(), ask()]);
    assert.ok(Date.now() - began < 2000, "both askers answered at the deadline");
    for (const answer of [first, joined]) {
      assert.equal(answer.json.error.class, "retryable");
      assert.equal(answer.json.error.code, "deadline_exceeded");
    }
    assert.equal(fx.provider.lyricsCalls, 1, "the second asker joined the same flight");
    const again = await ask();
    assert.equal(again.json.error.code, "deadline_exceeded");
    assert.equal(fx.provider.lyricsCalls, 2, "a settled flight is not reused forever");

    // The same port inside a preparation: lyrics end timed-out, the preparation still completes.
    const prepared = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-p", fx.target, { wantLyrics: true }));
    const settled = await pollUntil(harness, prepared.json, (item) => item.status !== "active");
    assert.equal(settled.status, "ready");
    assert.equal(settled.stages.source.status, "ready");
    assert.equal(settled.stages.lyrics.status, "timed-out");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("a speech provider that ignores abort is bounded by the voice deadline: the cue settles with a timed-out voice", async () => {
  const fx = setup(new FakeProvider("fixture-a"), new DeafSpeech("deaf-tts"));
  fx.writer.immediate = "下一首";
  const harness = await startHarness({ dir: tempDir(), ...fx, policy: { voiceDeadlineMs: 80 } });
  try {
    const narration = { transitionId: "tr-1", cueId: "cue-1", fromItemId: "item-from", fromTrack: fx.from, fromRevision: null };
    const { json } = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-v", fx.target, { narration }));
    const settled = await pollUntil(harness, json, (item) => item.status !== "active");
    assert.equal(settled.status, "ready", "music does not depend on the voice");
    assert.equal(settled.stages.script.status, "ready");
    assert.equal(settled.stages.voice.status, "timed-out");
    assert.equal(fx.tts.calls, 1);
  } finally {
    await harness.close({ closeDb: true });
  }
});
