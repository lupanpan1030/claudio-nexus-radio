import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { decode, startedResponseV1Decoder } from "@claudio/contracts";
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

test("now projection keeps the newest seq of the current executor and rejects superseded instances", async () => {
  const fx = setup();
  const harness = await startHarness({ dir: tempDir(), ...fx });
  const projection = (instance, seq) => ({
    protocolVersion: 1,
    executorInstanceId: instance,
    seq,
    observedAt: "2026-10-16T12:00:00.000Z",
    transport: "playing",
    item: { itemId: "item-1", track: fx.refs[0], display: { title: "Song s1", artist: "Fixture Artist" } },
    positionMs: 1000,
    nextItemId: null,
    speaking: false
  });
  try {
    assert.equal((await harness.request("GET", "/api/v1/now")).status, 404);
    assert.equal((await harness.request("PUT", "/api/v1/now", projection("A", 1))).status, 200);
    const stale = await harness.request("PUT", "/api/v1/now", projection("A", 1));
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, "stale_projection");
    assert.equal((await harness.request("PUT", "/api/v1/now", projection("A", 2))).status, 200);
    assert.equal((await harness.request("PUT", "/api/v1/now", projection("B", 0))).status, 200);
    const late = await harness.request("PUT", "/api/v1/now", projection("A", 3));
    assert.equal(late.json.error.code, "superseded_executor");
    assert.equal((await harness.request("GET", "/api/v1/now")).json.executorInstanceId, "B");
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
