import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { decode, nowConflictV1Decoder, startedResponseV1Decoder } from "@claudio/contracts";
import { ControlledWriter, FakeProvider, FakeRadio, FakeSpeech, fakeTrack } from "../testing/fakes.ts";
import { startHarness } from "../testing/harness.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-v1-history-"));
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
  const radio = new FakeRadio(() => a.search("", 50));
  return { a, refs, radio, writer: new ControlledWriter(), tts: new FakeSpeech(), providers: [a.module()] };
}

async function resolveMedia(harness, itemId, track) {
  const { json } = await harness.request("POST", "/api/v1/playback/resolve", {
    protocolVersion: 1,
    itemId,
    track,
    preparationId: null,
    reason: "initial",
    previousRevision: null
  });
  return json.media;
}

function startedBody(key, itemId, media, overrides = {}) {
  return {
    protocolVersion: 1,
    idempotencyKey: key,
    executorInstanceId: "exec-1",
    itemId,
    track: media.track,
    recordingId: media.recording.recordingId,
    sourceRevision: media.sourceRevision,
    loadId: `load-${itemId}`,
    positionMs: 0,
    startedAt: "2026-10-16T12:00:00.000Z",
    ...overrides
  };
}

test("started is idempotent per key and per item; the same track in another item is another listen", async () => {
  const fx = setup();
  const harness = await startHarness({ dir: tempDir(), ...fx });
  try {
    const media = await resolveMedia(harness, "item-1", fx.refs[0]);
    const first = await harness.request("POST", "/api/v1/playback/started", startedBody("k1", "item-1", media));
    assert.ok(decode(startedResponseV1Decoder, first.json).ok);
    assert.equal(first.json.status, "recorded");
    assert.equal((await harness.request("POST", "/api/v1/playback/started", startedBody("k1", "item-1", media))).json.status, "duplicate");
    // Resume/retry of the same item with a new load must not add a listen.
    const resumed = await harness.request("POST", "/api/v1/playback/started", startedBody("k1-retry", "item-1", media, { loadId: "load-2", positionMs: 30_000 }));
    assert.equal(resumed.json.status, "duplicate");
    const replay = await harness.request("POST", "/api/v1/playback/started", startedBody("k2", "item-2", media));
    assert.equal(replay.json.status, "recorded", "same track, new queue item");
    const mismatch = await harness.request("POST", "/api/v1/playback/started", startedBody("k3", "item-3", media, { track: fx.refs[1] }));
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.json.error.code, "started_source_mismatch");
    const unverified = await harness.request("POST", "/api/v1/playback/started", startedBody("k4", "item-4", media, { sourceRevision: "rev-from-before-gc", recordingId: "rec-x" }));
    assert.equal(unverified.json.status, "recorded");

    const history = await harness.request("GET", "/api/v1/history/started");
    assert.equal(history.json.semantics, "confirmed-started");
    assert.deepEqual(history.json.started.map((row) => [row.itemId, row.sourceVerified]).sort(), [["item-1", true], ["item-2", true], ["item-4", false]]);
    const row = harness.db.prepare("SELECT * FROM playback_started WHERE item_id = 'item-1'").get();
    assert.equal(row.load_id, "load-item-1");
    assert.equal(row.executor_instance_id, "exec-1");
    assert.equal(row.source_revision, media.sourceRevision);
    assert.equal(harness.db.prepare("SELECT COUNT(*) AS n FROM plays").get().n, 0, "legacy plays are untouched");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("radio candidates: reservations dedupe preparations, cancel releases, failures cool down, recency comes from started then legacy", async () => {
  const fx = setup();
  const broken = fx.a.add(fakeTrack("broken", 40, { playable: false }));
  const harness = await startHarness({ dir: tempDir(), ...fx });
  const radio = (itemId) =>
    harness.request("POST", "/api/v1/playback/prepare", {
      protocolVersion: 1,
      itemId,
      purpose: "standby",
      target: { kind: "radio-candidate", afterItemId: null },
      narration: null,
      wantLyrics: false
    });
  try {
    // Legacy selection rows are recency evidence of a different kind, listed after started facts.
    harness.db.exec(`INSERT INTO tracks (id, title, artist, album, file_path, folder, extension, size, added_at)
      VALUES ('legacy-t', 'Old', 'Old', 'Old', '/old.mp3', 'x', 'mp3', 1, '2026-01-01T00:00:00Z');
      INSERT INTO plays (track_id, played_at, reason, dj_line) VALUES ('legacy-t', '2026-01-02T00:00:00Z', '', '');`);
    const media = await resolveMedia(harness, "listened", fx.refs[2]);
    await harness.request("POST", "/api/v1/playback/started", startedBody("listen-1", "listened", media));

    const one = await radio("r-1");
    const two = await radio("r-2");
    const pickOne = one.json.stages.candidate.value.track.mediaId;
    const pickTwo = two.json.stages.candidate.value.track.mediaId;
    assert.notEqual(pickOne, pickTwo, "a reserved candidate is not handed to another item");
    const seen = fx.radio.requests[0];
    assert.deepEqual(seen.recent.map((ref) => ref.mediaId), ["s3", "legacy-t"]);
    assert.equal(harness.db.prepare("SELECT COUNT(*) AS n FROM playback_candidate_audits").get().n, 2);
    assert.equal(harness.db.prepare("SELECT COUNT(*) AS n FROM plays").get().n, 1, "candidates never write plays");

    await harness.request("DELETE", `/api/v1/playback/preparations/${one.json.preparationId}`);
    const three = await radio("r-3");
    assert.equal(three.json.stages.candidate.value.track.mediaId, pickOne, "cancel released the reservation");

    // Make the radio pick the unplayable track: its source fails and it cools down.
    fx.a.tracks.delete("s1");
    fx.a.tracks.delete("s2");
    fx.a.tracks.delete("s3");
    await harness.request("DELETE", `/api/v1/playback/preparations/${two.json.preparationId}`);
    await harness.request("DELETE", `/api/v1/playback/preparations/${three.json.preparationId}`);
    const failing = await radio("r-4");
    assert.equal(failing.json.stages.candidate.value.track.mediaId, broken.mediaId);
    assert.equal(failing.json.status, "failed");
    const after = await radio("r-5");
    assert.equal(after.json.stages.candidate.status, "failed", "the failed candidate stays excluded");
    assert.equal(after.json.stages.candidate.error.code, "no_candidate");

    const candidates = await harness.request("GET", "/api/v1/history/candidates");
    assert.equal(candidates.json.semantics, "candidate-selection");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("now projection: a larger generation takes over, same generation needs the same instance and a larger seq, refusals name the owner", async () => {
  const fx = setup();
  const harness = await startHarness({ dir: tempDir(), ...fx });
  const projection = (instance, generation, seq, observedAt = "2026-10-16T12:00:00.000Z") => ({
    protocolVersion: 1,
    executorInstanceId: instance,
    generation,
    seq,
    observedAt,
    transport: "playing",
    item: { itemId: "item-1", track: fx.refs[0], display: { title: "Song s1", artist: "Fixture Artist" } },
    positionMs: 1000,
    nextItemId: null,
    speaking: false
  });
  const conflict = (response) => {
    assert.equal(response.status, 409);
    const decoded = decode(nowConflictV1Decoder, response.json);
    assert.ok(decoded.ok, "the 409 body is the shared NowConflictV1");
    return decoded.value;
  };
  try {
    assert.equal((await harness.request("GET", "/api/v1/now")).status, 404);
    assert.equal((await harness.request("PUT", "/api/v1/now", { ...projection("A", 1, 1), generation: undefined })).status, 400, "generation is required");
    assert.equal((await harness.request("PUT", "/api/v1/now", projection("A", 1, 1))).status, 200);
    const stale = conflict(await harness.request("PUT", "/api/v1/now", projection("A", 1, 1)));
    assert.equal(stale.reason, "stale_projection");
    assert.deepEqual(stale.current, { executorInstanceId: "A", generation: 1, seq: 1 });
    assert.equal((await harness.request("PUT", "/api/v1/now", projection("A", 1, 2))).status, 200);

    // Another instance of the same generation is not a takeover, whatever it reports.
    const sibling = conflict(await harness.request("PUT", "/api/v1/now", projection("C", 1, 99)));
    assert.equal(sibling.reason, "superseded_executor");
    assert.deepEqual(sibling.current, { executorInstanceId: "A", generation: 1, seq: 2 });

    // A larger generation takes over even with seq 0; the old instance is then refused.
    assert.equal((await harness.request("PUT", "/api/v1/now", projection("B", 2, 0))).status, 200);
    const late = conflict(await harness.request("PUT", "/api/v1/now", projection("A", 1, 3)));
    assert.equal(late.reason, "superseded_executor");
    assert.deepEqual(late.current, { executorInstanceId: "B", generation: 2, seq: 0 });
    assert.equal((await harness.request("GET", "/api/v1/now")).json.executorInstanceId, "B");

    // A page whose counter was lost may step past the named owner once.
    assert.equal((await harness.request("PUT", "/api/v1/now", projection("D", late.current.generation + 1, 0))).status, 200);
    assert.equal((await harness.request("GET", "/api/v1/now")).json.executorInstanceId, "D");
    const legacyView = await harness.request("GET", "/api/now");
    assert.equal(legacyView.json.protocol, "v1-projection");
    assert.equal(legacyView.json.currentTrack.title, "Song s1");
    assert.equal((await harness.request("PUT", "/api/now", { playback: { isPlaying: true } })).status, 410);
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("v1 closes side-effecting legacy playback endpoints and keeps chat/DJ from writing history", async () => {
  const fx = setup();
  const djInputs = [];
  const harness = await startHarness({
    dir: tempDir(),
    ...fx,
    legacy: {
      chatWithRadio: async () => ({ reply: "好", pick: { songId: "t1", djLine: "", reason: "", moodTags: [], source: "rules" } }),
      getTrack: () => undefined,
      generateDjLine: async (input) => {
        djInputs.push(input);
        return { songId: input.songId, djLine: "x", source: "ai", usedLlm: true };
      },
      recordPlay: () => assert.fail("recordPlay must not run in v1")
    }
  });
  try {
    for (const [method, url] of [["POST", "/api/radio/next"], ["GET", "/api/track/t1/stream"], ["GET", "/api/track/t1/playback-source"]]) {
      const response = await harness.request(method, url, method === "POST" ? {} : undefined);
      assert.equal(response.status, 410, `${url} is retired`);
      assert.equal(response.json.code, "legacy_endpoint_removed");
    }
    const chat = await harness.request("POST", "/api/chat", { message: "播放 t1" });
    assert.equal(chat.status, 200);
    assert.equal(chat.json.pick.songId, "t1", "chat still offers the candidate");
    await harness.request("POST", "/api/dj/line", { songId: "t1" });
    assert.equal(djInputs[0].dryRun, true, "legacy DJ line never rewrites history in v1");
    assert.equal(harness.legacyCalls.includes("recordPlay"), false);
    const protocol = await harness.request("GET", "/api/v1/protocol");
    assert.equal(protocol.json.playbackProtocol, "v1");
    assert.equal(protocol.json.paths.prepare, "/api/v1/playback/prepare");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("legacy protocol mode keeps old behaviour and closes v1 playback (one switch, no half-migration)", async () => {
  const fx = setup();
  const recorded = [];
  const harness = await startHarness({
    dir: tempDir(),
    ...fx,
    mode: "legacy",
    legacy: {
      nextRadioPick: async () => ({ songId: "t9", djLine: "", reason: "r", moodTags: [], source: "rules" }),
      recordPlay: (id) => recorded.push(id)
    }
  });
  try {
    const prepare = await harness.request("POST", "/api/v1/playback/prepare", {});
    assert.equal(prepare.status, 503);
    assert.equal(prepare.json.error.code, "protocol_disabled");
    assert.equal((await harness.request("GET", "/api/v1/protocol")).json.playbackProtocol, "legacy");
    const next = await harness.request("POST", "/api/radio/next", {});
    assert.equal(next.json.songId, "t9");
    assert.deepEqual(recorded, ["t9"], "legacy writes stay in the legacy selection table");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("a late first message from an older executor cannot displace the newer one, and the newer one keeps writing", async () => {
  const fx = setup();
  const harness = await startHarness({ dir: tempDir(), ...fx });
  const projection = (instance, generation, seq, observedAt) => ({
    protocolVersion: 1,
    executorInstanceId: instance,
    generation,
    seq,
    observedAt,
    transport: "playing",
    item: null,
    positionMs: null,
    nextItemId: null,
    speaking: false
  });
  try {
    // The reloaded page (generation 8) reports first; the old page's first PUT (generation 7) was still in flight.
    assert.equal((await harness.request("PUT", "/api/v1/now", projection("new-executor", 8, 1, "2026-10-16T12:00:10.000Z"))).status, 200);
    const old = await harness.request("PUT", "/api/v1/now", projection("old-executor", 7, 1, "2026-10-16T12:00:00.000Z"));
    assert.equal(old.status, 409);
    assert.equal(old.json.reason, "superseded_executor");
    assert.equal((await harness.request("PUT", "/api/v1/now", projection("new-executor", 8, 2, "2026-10-16T12:00:20.000Z"))).status, 200);
    // Clocks play no part: an older generation with a later observedAt is still refused.
    assert.equal((await harness.request("PUT", "/api/v1/now", projection("old-executor", 7, 2, "2026-10-16T13:00:00.000Z"))).status, 409);
    assert.equal((await harness.request("GET", "/api/v1/now")).json.seq, 2);
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("after a server restart the first valid projection sets the owner again", async () => {
  const fx = setup();
  const dir = tempDir();
  const projection = (instance, generation, seq) => ({
    protocolVersion: 1, executorInstanceId: instance, generation, seq, observedAt: "2026-10-16T12:00:00.000Z",
    transport: "idle", item: null, positionMs: null, nextItemId: null, speaking: false
  });
  const first = await startHarness({ dir, ...fx });
  assert.equal((await first.request("PUT", "/api/v1/now", projection("A", 5, 9))).status, 200);
  await first.close();
  const second = await startHarness({ dir, ...fx });
  try {
    assert.equal((await second.request("GET", "/api/v1/now")).status, 404, "projections are memory-only");
    assert.equal((await second.request("PUT", "/api/v1/now", projection("A", 5, 1))).status, 200, "the surviving page continues");
    assert.equal((await second.request("PUT", "/api/v1/now", projection("Z", 4, 50))).status, 409, "an older generation still loses once one is known");
  } finally {
    await second.close({ closeDb: true });
  }
});

/** Radio policy that snapshots its exclusions at call time, then waits for the test to open the gate. */
class GatedRadio {
  constructor(entries) {
    this.entries = entries;
    this.calls = [];
    this.gates = [];
  }
  pick(request) {
    const excluded = new Set(request.exclude.map((ref) => `${ref.providerId}/${ref.mediaId}`));
    this.calls.push([...excluded]);
    const pool = this.entries().filter((entry) => !excluded.has(`${entry.ref.providerId}/${entry.ref.mediaId}`));
    return new Promise((resolve) => this.gates.push(() => resolve(pool[0] ? { entry: pool[0], reason: "gated", policy: "gated", considered: [] } : null)));
  }
  async waitForCalls(count) {
    const deadline = Date.now() + 3000;
    while (this.calls.length < count) {
      if (Date.now() > deadline) throw new Error(`expected ${count} picks, saw ${this.calls.length}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  openAll() {
    const gates = this.gates;
    this.gates = [];
    for (const open of gates) open();
  }
}

const radioPrepare = (itemId) => ({
  protocolVersion: 1,
  itemId,
  purpose: "program",
  target: { kind: "radio-candidate", afterItemId: null },
  narration: null,
  wantLyrics: false
});

function reservedRefs(db) {
  return db.prepare("SELECT item_id, media_id FROM playback_candidate_reservations WHERE status = 'reserved' ORDER BY item_id").all().map((row) => ({ ...row }));
}

test("two concurrent radio preparations whose picks overlap never reserve the same ref: the loser re-picks with the winner excluded", async () => {
  const fx = setup();
  const radio = new GatedRadio(() => fx.a.search("", 50));
  const harness = await startHarness({ dir: tempDir(), ...fx, radio });
  try {
    const first = harness.request("POST", "/api/v1/playback/prepare", radioPrepare("item-1"));
    const second = harness.request("POST", "/api/v1/playback/prepare", radioPrepare("item-2"));
    await radio.waitForCalls(2);
    assert.deepEqual(radio.calls, [[], []], "both picks started from the same empty exclusions");
    radio.openAll();
    await radio.waitForCalls(3);
    assert.ok(radio.calls[2].includes("fixture-a/s1"), "the re-pick excludes the ref the other item reserved");
    radio.openAll();
    const [a, b] = (await Promise.all([first, second])).map((response) => response.json);
    const chosen = [a, b].map((prepared) => prepared.stages.candidate.value.track.mediaId).sort();
    assert.deepEqual(chosen, ["s1", "s2"]);
    assert.deepEqual(reservedRefs(harness.db).map((row) => row.media_id).sort(), ["s1", "s2"]);
    assert.equal(harness.db.prepare("SELECT COUNT(*) AS n FROM playback_candidate_audits").get().n, 2, "only reserved picks are audited");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("when re-picks keep colliding the loser ends with no_candidate after the bounded retries, and cancelling releases the winner's ref", async () => {
  const fx = setup();
  // A policy that ignores exclusions and always offers the same entry.
  const stubborn = new GatedRadio(() => fx.a.search("", 50).slice(0, 1));
  stubborn.pick = function (request) {
    this.calls.push(request.exclude.map((ref) => `${ref.providerId}/${ref.mediaId}`));
    return new Promise((resolve) => this.gates.push(() => resolve({ entry: this.entries()[0], reason: "same", policy: "same", considered: [] })));
  };
  const harness = await startHarness({ dir: tempDir(), ...fx, radio: stubborn });
  try {
    const first = harness.request("POST", "/api/v1/playback/prepare", radioPrepare("item-1"));
    const second = harness.request("POST", "/api/v1/playback/prepare", radioPrepare("item-2"));
    await stubborn.waitForCalls(2);
    stubborn.openAll();
    for (let calls = 3; calls <= 4; calls += 1) {
      await stubborn.waitForCalls(calls);
      stubborn.openAll();
    }
    const results = (await Promise.all([first, second])).map((response) => response.json);
    const loser = results.find((prepared) => prepared.status === "failed");
    const winner = results.find((prepared) => prepared.status !== "failed");
    assert.equal(loser.stages.candidate.error.code, "no_candidate");
    assert.equal(stubborn.calls.length, 4, "one pick each, then two bounded re-picks for the loser");
    assert.deepEqual(reservedRefs(harness.db), [{ item_id: winner.itemId, media_id: "s1" }]);

    await harness.request("DELETE", `/api/v1/playback/preparations/${winner.preparationId}`);
    assert.deepEqual(reservedRefs(harness.db), [], "cancel releases the reservation");
  } finally {
    await harness.close({ closeDb: true });
  }
});
