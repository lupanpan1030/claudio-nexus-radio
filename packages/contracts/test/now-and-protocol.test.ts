import assert from "node:assert/strict";
import test from "node:test";
import {
  API_V1_EXTRA_PATHS,
  API_V1_PATHS,
  API_V1_STREAM_HANDLE_PREFIX,
  candidateHistoryResponseV1Decoder,
  catalogSearchResponseV1Decoder,
  decode,
  isNewerProjection,
  narrationCuePath,
  NOW_CONFLICT_HTTP_STATUS,
  nowConflictFor,
  nowConflictV1Decoder,
  nowProjectionV1Decoder,
  protocolHandshakeV1Decoder,
  startedHistoryResponseV1Decoder,
  type NowProjectionV1
} from "../src/index.js";

const base = decodeOk({
  protocolVersion: 1,
  executorInstanceId: "exec-a",
  generation: 4,
  seq: 10,
  observedAt: "2026-10-16T01:00:00Z",
  transport: "playing",
  item: null,
  positionMs: null,
  nextItemId: null,
  speaking: false
});

function decodeOk(input: unknown): NowProjectionV1 {
  const result = decode(nowProjectionV1Decoder, input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function paths(result: { ok: boolean; issues?: readonly { path: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((issue) => issue.path);
}

test("generation is a required safe non-negative integer", () => {
  const { generation: _omitted, ...withoutGeneration } = base;
  assert.deepEqual(paths(decode(nowProjectionV1Decoder, withoutGeneration)), ["$.generation"]);
  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4", null, Number.NaN]) {
    assert.deepEqual(paths(decode(nowProjectionV1Decoder, { ...base, generation: bad })), ["$.generation"], `generation ${String(bad)}`);
  }
  assert.equal(decodeOk({ ...base, generation: 0 }).generation, 0);
  assert.equal(decodeOk({ ...base, generation: Number.MAX_SAFE_INTEGER }).generation, Number.MAX_SAFE_INTEGER);
});

test("ordering: larger generation takes over; same generation only the same instance with a larger seq", () => {
  const other = { ...base, executorInstanceId: "exec-b" as NowProjectionV1["executorInstanceId"] };
  assert.equal(isNewerProjection(null, base), true, "first projection after a server start");
  assert.equal(isNewerProjection(base, { ...other, generation: 5, seq: 0 }), true, "new generation wins even with seq 0");
  assert.equal(isNewerProjection(base, { ...base, generation: 5, seq: 1 }), true, "same instance re-numbered under a new generation");
  assert.equal(isNewerProjection(base, { ...base, seq: 11 }), true);
  assert.equal(isNewerProjection(base, { ...base, seq: 10 }), false, "same seq is a duplicate");
  assert.equal(isNewerProjection(base, { ...base, seq: 9 }), false);
  assert.equal(isNewerProjection(base, { ...other, seq: 99 }), false, "same generation from another instance");
  assert.equal(isNewerProjection(base, { ...other, generation: 3, seq: 99 }), false, "late write of an older generation");
  assert.equal(isNewerProjection(base, { ...base, generation: 3, seq: 99 }), false, "own older generation");
});

test("conflict body names the accepted owner and decodes strictly; it is never a projection", () => {
  const other = { ...base, executorInstanceId: "exec-b" as NowProjectionV1["executorInstanceId"] };
  assert.equal(nowConflictFor(base, { ...base, seq: 11 }), null);
  const stale = nowConflictFor(base, { ...base, seq: 10 });
  assert.equal(stale?.reason, "stale_projection");
  const superseded = nowConflictFor(base, { ...other, generation: 4, seq: 50 });
  assert.deepEqual(superseded, {
    protocolVersion: 1,
    error: { class: "invalid", code: "superseded_executor" },
    reason: "superseded_executor",
    current: { executorInstanceId: "exec-a", generation: 4, seq: 10 }
  });
  assert.equal(nowConflictFor(base, { ...base, generation: 2 })?.reason, "superseded_executor");
  assert.equal(NOW_CONFLICT_HTTP_STATUS, 409);

  const wire = JSON.parse(JSON.stringify(superseded));
  assert.ok(decode(nowConflictV1Decoder, wire).ok);
  assert.ok(paths(decode(nowConflictV1Decoder, { ...wire, error: { class: "invalid", code: "stale_projection" } })).includes("$.error.code"));
  assert.ok(paths(decode(nowConflictV1Decoder, { ...wire, current: { ...wire.current, generation: -1 } })).includes("$.current.generation"));
  assert.equal(decode(nowProjectionV1Decoder, wire).ok, false, "a conflict body does not decode as a snapshot");
  assert.equal(decode(nowConflictV1Decoder, base).ok, false, "a snapshot does not decode as a conflict");
});

test("extra v1 paths keep the routes the server serves", () => {
  assert.deepEqual(API_V1_EXTRA_PATHS, {
    protocol: "/api/v1/protocol",
    streams: "/api/v1/playback/streams/:token",
    narrationCue: "/api/v1/playback/narration/:cueId",
    nowStream: "/api/v1/now/stream",
    startedHistory: "/api/v1/history/started",
    candidateHistory: "/api/v1/history/candidates",
    catalogSearch: "/api/v1/catalog/search"
  });
  assert.equal(API_V1_STREAM_HANDLE_PREFIX, "/api/v1/playback/streams/");
  assert.equal(narrationCuePath("cue/1 x"), "/api/v1/playback/narration/cue%2F1%20x");
  const names = [...Object.keys(API_V1_PATHS), ...Object.keys(API_V1_EXTRA_PATHS)];
  assert.equal(new Set(names).size, names.length, "no name is announced twice");
});

test("handshake decoder requires every announced path and drops unknown keys", () => {
  const handshake = {
    protocolVersion: 1,
    playbackProtocol: "v1",
    serverInstanceId: "srv-1",
    paths: { ...API_V1_PATHS, ...API_V1_EXTRA_PATHS },
    providers: [{ providerId: "library", lyrics: true }],
    secret: "dropped"
  };
  const decoded = decode(protocolHandshakeV1Decoder, handshake);
  assert.ok(decoded.ok);
  assert.equal("secret" in decoded.value, false);
  const { catalogSearch: _missing, ...partial } = handshake.paths;
  assert.ok(paths(decode(protocolHandshakeV1Decoder, { ...handshake, paths: partial })).includes("$.paths.catalogSearch"));
  assert.ok(paths(decode(protocolHandshakeV1Decoder, { ...handshake, paths: { ...handshake.paths, now: "https://evil.example/now" } })).includes("$.paths.now"));
  assert.ok(decode(protocolHandshakeV1Decoder, { ...handshake, playbackProtocol: "legacy" }).ok);
  assert.equal(decode(protocolHandshakeV1Decoder, { ...handshake, playbackProtocol: "v2" }).ok, false);
});

test("history and catalog responses decode the shapes the routes send", () => {
  const track = { providerId: "library", mediaId: "m1" };
  assert.ok(
    decode(startedHistoryResponseV1Decoder, {
      protocolVersion: 1,
      semantics: "confirmed-started",
      started: [{ itemId: "i1", track, display: null, recordingId: "r1", sourceRevision: "s1", startedAt: "2026-10-16T00:00:00.000Z", positionMs: 0, sourceVerified: true }]
    }).ok
  );
  assert.equal(decode(startedHistoryResponseV1Decoder, { protocolVersion: 1, semantics: "candidate-selection", started: [] }).ok, false, "audit is not listening history");
  assert.ok(
    decode(candidateHistoryResponseV1Decoder, {
      protocolVersion: 1,
      semantics: "candidate-selection",
      candidates: [
        {
          itemId: "i2",
          preparationId: "p2",
          track,
          display: { title: "t", artist: "a" },
          policy: "radio",
          reason: "fits",
          considered: [{ ref: track, score: 0.5 }],
          createdAt: "2026-10-16T00:00:00.000Z"
        }
      ]
    }).ok
  );
  assert.ok(decode(catalogSearchResponseV1Decoder, { protocolVersion: 1, tracks: [{ track, display: { title: "t", artist: "a" }, playable: false }] }).ok);
  assert.equal(decode(catalogSearchResponseV1Decoder, { protocolVersion: 1, tracks: [{ track, display: null, playable: true }] }).ok, false);
});
