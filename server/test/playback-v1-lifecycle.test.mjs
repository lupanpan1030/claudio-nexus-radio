import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { ControlledWriter, FakeProvider, FakeRadio, FakeSpeech, fakeTrack } from "../testing/fakes.ts";
import { ManualClock, startHarness } from "../testing/harness.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-v1-lifecycle-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let counter = 0;
const tempDir = () => {
  const dir = path.join(root, `case-${(counter += 1)}`);
  fs.mkdirSync(dir);
  return dir;
};

function setup() {
  const a = new FakeProvider("fixture-a");
  const refs = ["s1", "s2", "s3"].map((id, index) => a.add(fakeTrack(id, index + 2)));
  return { a, refs, radio: new FakeRadio(() => a.search("", 50)), writer: new ControlledWriter(), tts: new FakeSpeech(), providers: [a.module()] };
}

const prepareBody = (itemId, track, narration = null, purpose = "program") => ({
  protocolVersion: 1,
  itemId,
  purpose,
  target: { kind: "track", track },
  narration,
  wantLyrics: false
});

test("restart marks unfinished preparations and cues interrupted; the old job cannot revive them", async () => {
  const fx = setup();
  const dir = tempDir();
  const db = new DatabaseSync(path.join(dir, "radio.sqlite"));
  const first = await startHarness({ dir, db, ...fx });
  const narration = { transitionId: "tr-1", cueId: "cue-1", fromItemId: "item-0", fromTrack: fx.refs[0], fromRevision: null };
  const { json } = await first.request("POST", "/api/v1/playback/prepare", prepareBody("item-1", fx.refs[1], narration));
  assert.equal(json.status, "active");
  // Simulated crash: no graceful interrupt; the in-memory job is orphaned.
  await first.close({ interrupt: false });

  const second = await startHarness({ dir, db, ...fx });
  try {
    assert.deepEqual(second.assembly.recovered, { preparations: 1, cues: 1 });
    const after = await second.request("GET", `/api/v1/playback/preparations/${json.preparationId}`);
    assert.equal(after.json.status, "interrupted");
    assert.equal(after.json.stages.script.status, "interrupted");
    assert.equal(after.json.stages.source.status, "ready", "settled stages keep their result");

    fx.writer.release("复活的稿子");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const still = await second.request("GET", `/api/v1/playback/preparations/${json.preparationId}`);
    assert.equal(still.json.status, "interrupted", "orphaned job results are rejected by version");
    assert.equal(still.json.version, after.json.version);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM narration_scripts").get().n, 0);

    // The client re-prepares the same item: a new preparation id, never the old one.
    const again = await second.request("POST", "/api/v1/playback/prepare", prepareBody("item-1", fx.refs[1]));
    assert.notEqual(again.json.preparationId, json.preparationId);
  } finally {
    await second.close({ closeDb: true });
  }
});

test("expiry stops new loads but not in-flight ranges; GC removes old records unless the executor references them", async () => {
  const fx = setup();
  const clock = new ManualClock();
  const harness = await startHarness({ dir: tempDir(), ...fx, clock });
  try {
    const { json } = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-1", fx.refs[0]));
    const other = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-2", fx.refs[1]));
    assert.equal(json.status, "ready");
    assert.equal(Date.parse(json.expiresAt), clock.now() + 15 * 60_000, "TTL bounded by the R1 default");
    const handle = json.stages.source.value.stream.handle;
    assert.equal(json.stages.source.value.stream.expiresAt, json.expiresAt);

    clock.advance(15 * 60_000 + 1);
    const report = harness.assembly.gc.run();
    assert.equal(report.expired, 2);
    const expired = await harness.request("GET", `/api/v1/playback/preparations/${json.preparationId}`);
    assert.equal(expired.json.status, "expired");
    assert.equal(expired.json.stages.source.status, "expired");
    const ranged = await fetch(`${harness.baseUrl}${handle}`, { headers: { Range: "bytes=0-9" } });
    assert.equal(ranged.status, 206, "media already loading keeps its range requests during the grace period");
    await ranged.arrayBuffer();

    // The executor still reports item-1 as current: its records survive GC.
    await harness.request("PUT", "/api/v1/now", {
      protocolVersion: 1,
      executorInstanceId: "exec",
      seq: 1,
      observedAt: "2026-10-16T12:20:00.000Z",
      transport: "playing",
      item: { itemId: "item-1", track: fx.refs[0], display: null },
      positionMs: 0,
      nextItemId: null,
      speaking: false
    });
    clock.advance(24 * 3600_000 + 1);
    const collected = harness.assembly.gc.run();
    assert.equal(collected.preparations, 1, "only the unreferenced record is collected");
    assert.equal((await harness.request("GET", `/api/v1/playback/preparations/${other.json.preparationId}`)).status, 404);
    assert.equal((await harness.request("GET", `/api/v1/playback/preparations/${json.preparationId}`)).json.status, "expired");
    assert.ok(collected.handles >= 2, "expired handles past their grace are collected");
    assert.equal((await harness.request("GET", handle)).status, 410);
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("only a bounded number of items prepare at once; standby work is cancelled first", async () => {
  const fx = setup();
  const harness = await startHarness({ dir: tempDir(), ...fx });
  const narration = (cueId) => ({ transitionId: `tr-${cueId}`, cueId, fromItemId: "item-0", fromTrack: fx.refs[0], fromRevision: null });
  try {
    const standby = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-standby", fx.refs[0], narration("c1"), "standby"));
    const current = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-current", fx.refs[1], narration("c2")));
    const next = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-next", fx.refs[2], narration("c3")));
    assert.equal(next.json.status, "active");
    const states = {};
    for (const [name, response] of Object.entries({ standby, current, next })) {
      states[name] = (await harness.request("GET", `/api/v1/playback/preparations/${response.json.preparationId}`)).json.status;
    }
    assert.deepEqual(states, { standby: "cancelled", current: "active", next: "active" });
    // An identical repeat (network retry) returns the existing preparation instead of starting another.
    const repeat = await harness.request("POST", "/api/v1/playback/prepare", prepareBody("item-next", fx.refs[2], narration("c3")));
    assert.equal(repeat.json.preparationId, next.json.preparationId);
    assert.equal(fx.writer.waiting, 3, "writers already started are abandoned, not restarted");
  } finally {
    await harness.close({ closeDb: true });
  }
});
