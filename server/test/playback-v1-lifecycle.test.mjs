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

test("a handle opened before its deadline keeps serving ranges after it; GC removes old records unless the executor references them", async () => {
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
    const loaded = await fetch(`${harness.baseUrl}${handle}`);
    assert.equal(loaded.status, 200, "the executor loads before the deadline");
    await loaded.arrayBuffer();

    clock.advance(15 * 60_000 + 1);
    const report = harness.assembly.gc.run();
    assert.equal(report.expired, 2);
    const expired = await harness.request("GET", `/api/v1/playback/preparations/${json.preparationId}`);
    assert.equal(expired.json.status, "expired");
    assert.equal(expired.json.stages.source.status, "expired");
    const ranged = await fetch(`${harness.baseUrl}${handle}`, { headers: { Range: "bytes=0-9" } });
    assert.equal(ranged.status, 206, "an activated handle keeps its range requests during the grace period");
    await ranged.arrayBuffer();

    // The executor still reports item-1 as current: its records survive GC.
    await harness.request("PUT", "/api/v1/now", {
      protocolVersion: 1,
      executorInstanceId: "exec",
      generation: 1,
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

/** A ready preparation whose handle the test drives, on a manual clock. */
async function preparedHandle(fx, clock, harness, itemId = "item-1") {
  const { json } = await harness.request("POST", "/api/v1/playback/prepare", prepareBody(itemId, fx.refs[0]));
  assert.equal(json.status, "ready");
  return { preparation: json, handle: json.stages.source.value.stream.handle, token: json.stages.source.value.stream.handle.split("/").pop(), expiresAt: Date.parse(json.expiresAt) };
}

test("never opened: past its deadline neither a plain GET nor a first Range request may start a load", async () => {
  const fx = setup();
  const clock = new ManualClock();
  const harness = await startHarness({ dir: tempDir(), ...fx, clock });
  try {
    const { handle, preparation, expiresAt } = await preparedHandle(fx, clock, harness);
    clock.current = expiresAt + 1;
    // No GC has run: reading the preparation settles it as expired on the spot.
    const read = await harness.request("GET", `/api/v1/playback/preparations/${preparation.preparationId}`);
    assert.equal(read.json.status, "expired");
    assert.equal(read.json.stages.source.status, "expired");
    const plain = await harness.request("GET", handle);
    assert.equal(plain.status, 410);
    assert.equal(plain.json.error.code, "stream_never_opened");
    const ranged = await fetch(`${harness.baseUrl}${handle}`, { headers: { Range: "bytes=0-9" } });
    assert.equal(ranged.status, 410, "a Range header does not prove an earlier load");
    assert.equal(fx.a.openCalls, 0, "the provider is never asked");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("a failed open does not activate the handle", async () => {
  const fx = setup();
  const clock = new ManualClock();
  const harness = await startHarness({ dir: tempDir(), ...fx, clock });
  try {
    const { handle, token, expiresAt } = await preparedHandle(fx, clock, harness);
    const track = fx.a.tracks.get("s1");
    const original = track.bytes;
    track.bytes = fakeTrack("s1", 99).bytes;
    assert.equal((await harness.request("GET", handle)).status, 410, "the source refuses changed bytes");
    assert.equal(harness.assembly.stores.handles.get(token).firstOpenedAt, null);
    track.bytes = original;
    const unsatisfied = await fetch(`${harness.baseUrl}${handle}`, { headers: { Range: "bytes=999999-" } });
    assert.equal(unsatisfied.status, 416);
    assert.equal(harness.assembly.stores.handles.get(token).firstOpenedAt, null, "a 416 serves no media and does not activate");
    clock.current = expiresAt + 1;
    assert.equal((await harness.request("GET", handle)).status, 410);
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("active range: a first request that already carries Range activates; plain and Range requests continue until retainUntil", async () => {
  const fx = setup();
  const clock = new ManualClock();
  const harness = await startHarness({ dir: tempDir(), ...fx, clock });
  try {
    const { handle, token, expiresAt } = await preparedHandle(fx, clock, harness);
    const admittedAt = clock.now();
    const first = await fetch(`${harness.baseUrl}${handle}`, { headers: { Range: "bytes=0-" } });
    assert.equal(first.status, 206);
    await first.arrayBuffer();
    assert.equal(harness.assembly.stores.handles.get(token).firstOpenedAt, admittedAt);

    clock.current = expiresAt + 60 * 60_000;
    const resumed = await fetch(`${harness.baseUrl}${handle}`, { headers: { Range: "bytes=100-199" } });
    assert.equal(resumed.status, 206, "a long pause resumes on the same handle");
    assert.equal((await resumed.arrayBuffer()).byteLength, 100);
    const plain = await fetch(`${harness.baseUrl}${handle}`);
    assert.equal(plain.status, 200);
    await plain.arrayBuffer();
    assert.equal(harness.assembly.stores.handles.get(token).firstOpenedAt, admittedAt, "the first admission time is kept");

    clock.current = harness.assembly.stores.handles.get(token).retainUntil + 1;
    assert.equal((await harness.request("GET", handle)).status, 410);
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("a slow upstream admitted before the deadline activates at its admission time; a request arriving after it meanwhile is refused", async () => {
  const fx = setup();
  const clock = new ManualClock();
  const harness = await startHarness({ dir: tempDir(), ...fx, clock });
  try {
    const { handle, token, expiresAt } = await preparedHandle(fx, clock, harness);
    let release;
    fx.a.openGate = new Promise((resolve) => (release = resolve));
    const admittedAt = clock.now();
    const slow = fetch(`${harness.baseUrl}${handle}`, { headers: { Range: "bytes=0-9" } });
    for (const deadline = Date.now() + 3000; fx.a.openCalls === 0; ) {
      assert.ok(Date.now() < deadline, "the first request reached the provider");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    clock.current = expiresAt + 5;
    // Bounded: if the deadline were not enforced this request would wait on the gate.
    const late = await fetch(`${harness.baseUrl}${handle}`, { signal: AbortSignal.timeout(3000) });
    assert.equal(late.status, 410, "not yet activated: a request arriving after the deadline is a new load");
    await late.arrayBuffer();
    release();
    fx.a.openGate = null;
    const answered = await slow;
    assert.equal(answered.status, 206, "admitted in time, served even though the upstream answered late");
    await answered.arrayBuffer();
    assert.equal(harness.assembly.stores.handles.get(token).firstOpenedAt, admittedAt, "activation records the admission, not the late answer");
    assert.equal((await fetch(`${harness.baseUrl}${handle}`, { headers: { Range: "bytes=10-19" } })).status, 206);
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
