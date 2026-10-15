import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  API_V1_EXTRA_PATHS,
  API_V1_PATHS,
  API_V1_STREAM_HANDLE_PREFIX,
  candidateHistoryResponseV1Decoder,
  catalogSearchResponseV1Decoder,
  decode,
  protocolHandshakeV1Decoder,
  resolveResponseV1Decoder,
  startedHistoryResponseV1Decoder
} from "@claudio/contracts";
import { STREAM_HANDLE_PREFIX, V1_EXTRA_PATHS } from "../http/v1-routes.ts";
import { ControlledWriter, FakeProvider, FakeRadio, FakeSpeech, fakeTrack } from "../testing/fakes.ts";
import { startHarness } from "../testing/harness.ts";

// The web app parses these routes with the shared decoders; these cases feed
// them what the real router answers, not hand-written bodies.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-v1-shared-"));
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

function decoded(decoder, json, label) {
  const result = decode(decoder, json);
  assert.ok(result.ok, `${label} decodes with the shared decoder: ${JSON.stringify(result.ok ? null : result.issues)}`);
  return result.value;
}

test("server path constants are the shared contract values, not copies", () => {
  assert.equal(V1_EXTRA_PATHS, API_V1_EXTRA_PATHS);
  assert.equal(STREAM_HANDLE_PREFIX, API_V1_STREAM_HANDLE_PREFIX);
});

test("v1 handshake, resolve handle, started/candidate history and catalog search decode with the shared decoders", async () => {
  const fx = setup();
  const harness = await startHarness({ dir: tempDir(), ...fx });
  try {
    const handshake = decoded(protocolHandshakeV1Decoder, (await harness.request("GET", API_V1_EXTRA_PATHS.protocol)).json, "handshake");
    assert.equal(handshake.playbackProtocol, "v1");
    assert.deepEqual(handshake.paths, { ...API_V1_PATHS, ...API_V1_EXTRA_PATHS });
    assert.deepEqual(handshake.providers.map((entry) => entry.providerId), ["fixture-a"]);

    const resolved = await harness.request("POST", API_V1_PATHS.resolve, {
      protocolVersion: 1,
      itemId: "item-1",
      track: fx.refs[0],
      preparationId: null,
      reason: "initial",
      previousRevision: null
    });
    const media = decoded(resolveResponseV1Decoder, resolved.json, "resolve").media;
    assert.ok(media.stream.handle.startsWith(API_V1_STREAM_HANDLE_PREFIX), `handle ${media.stream.handle} uses the shared prefix`);
    const bytes = await fetch(`${harness.baseUrl}${media.stream.handle}`, { headers: { Range: "bytes=0-3" } });
    assert.equal(bytes.status, 206, "the announced stream route serves the issued handle");
    await bytes.arrayBuffer();

    const started = await harness.request("POST", API_V1_PATHS.started, {
      protocolVersion: 1,
      idempotencyKey: "k1",
      executorInstanceId: "exec-1",
      itemId: "item-1",
      track: media.track,
      recordingId: media.recording.recordingId,
      sourceRevision: media.sourceRevision,
      loadId: "load-1",
      positionMs: 0,
      startedAt: "2026-10-16T12:00:00.000Z"
    });
    assert.equal(started.status, 200);
    const history = decoded(startedHistoryResponseV1Decoder, (await harness.request("GET", `${API_V1_EXTRA_PATHS.startedHistory}?limit=5`)).json, "started history");
    assert.equal(history.started.length, 1);
    assert.equal(history.started[0].itemId, "item-1");
    assert.equal(history.started[0].sourceVerified, true);
    assert.ok(history.started[0].display, "display is filled from the provider");

    const prepared = await harness.request("POST", API_V1_PATHS.prepare, {
      protocolVersion: 1,
      itemId: "item-2",
      purpose: "program",
      target: { kind: "radio-candidate", afterItemId: "item-1" },
      narration: null,
      wantLyrics: false
    });
    assert.equal(prepared.status, 200);
    const candidates = decoded(candidateHistoryResponseV1Decoder, (await harness.request("GET", `${API_V1_EXTRA_PATHS.candidateHistory}?limit=5`)).json, "candidate history");
    assert.equal(candidates.candidates.length, 1);
    assert.equal(candidates.candidates[0].itemId, "item-2");
    assert.equal(candidates.candidates[0].preparationId, prepared.json.preparationId);

    const search = decoded(catalogSearchResponseV1Decoder, (await harness.request("GET", `${API_V1_EXTRA_PATHS.catalogSearch}?q=&limit=2`)).json, "catalog search");
    assert.equal(search.tracks.length, 2);
    assert.ok(search.tracks.every((entry) => entry.track.providerId === "fixture-a"));
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("legacy-mode handshake still decodes and announces the same shared paths", async () => {
  const fx = setup();
  const harness = await startHarness({ dir: tempDir(), ...fx, mode: "legacy" });
  try {
    const handshake = decoded(protocolHandshakeV1Decoder, (await harness.request("GET", API_V1_EXTRA_PATHS.protocol)).json, "legacy handshake");
    assert.equal(handshake.playbackProtocol, "legacy");
    assert.deepEqual(handshake.paths, { ...API_V1_PATHS, ...API_V1_EXTRA_PATHS });
  } finally {
    await harness.close({ closeDb: true });
  }
});
