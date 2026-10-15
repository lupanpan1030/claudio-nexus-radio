import assert from "node:assert/strict";
import test from "node:test";
import {
  API_V1_PATHS,
  asId,
  decode,
  isNewerPreparation,
  isNewerProjection,
  isSameSource,
  legacySegueHint,
  nowProjectionV1Decoder,
  lyricsMatchRecording,
  preferDuration,
  type DurationInfo,
  PROTOCOL_VERSION,
  preparedItemV1Decoder,
  prepareRequestV1Decoder,
  resolvedMediaFromWire,
  spokenDurationMs,
  startedRequestFromReceipt,
  startedRequestV1Decoder,
  trackRefDecoder,
  type LyricsResponseV1,
  type PlaybackReceipt,
  type PreparationId,
  type PreparedItemV1,
  type ResolvedMedia
} from "../src/index.js";

const receipt: PlaybackReceipt = {
  idempotencyKey: asId("started:exec:item:1"),
  itemId: asId("exec:item:1"),
  track: { providerId: asId("fixture"), mediaId: asId("m1") },
  recordingId: asId("rec-1"),
  sourceRevision: asId("rev-1"),
  loadId: asId("exec:load:2"),
  positionMs: 120,
  at: 1_700_000_000_000
};

test("started request round-trips and drops unknown (possibly private) keys", () => {
  const wire = startedRequestFromReceipt(receipt, asId("exec"), "2026-10-16T01:02:03.000Z");
  const result = decode(startedRequestV1Decoder, { ...wire, filePath: "/home/private/song.flac", accountToken: "secret" });
  assert.ok(result.ok);
  assert.deepEqual(result.value, wire);
  assert.doesNotMatch(JSON.stringify(result.value), /private|secret/);
});

test("started request rejects missing identity and bad timestamps with paths", () => {
  const wire = startedRequestFromReceipt(receipt, asId("exec"), "2026-10-16T01:02:03Z");
  const { loadId: _drop, ...withoutLoad } = wire;
  const missing = decode(startedRequestV1Decoder, withoutLoad);
  assert.ok(!missing.ok);
  assert.ok(missing.issues.some((issue) => issue.path === "$.loadId"));

  const badTime = decode(startedRequestV1Decoder, { ...wire, startedAt: "yesterday" });
  assert.ok(!badTime.ok);
  const wrongVersion = decode(startedRequestV1Decoder, { ...wire, protocolVersion: 2 });
  assert.ok(!wrongVersion.ok, "only the fixed protocol version is accepted");
});

test("provider ids are opaque lowercase keys, not an enum of vendors", () => {
  assert.ok(decode(trackRefDecoder, { providerId: "any-new-source.v2", mediaId: "x" }).ok);
  assert.ok(!decode(trackRefDecoder, { providerId: "Has Spaces", mediaId: "x" }).ok);
  assert.ok(!decode(trackRefDecoder, { providerId: "ok", mediaId: "" }).ok);
});

function prepared(overrides: Partial<PreparedItemV1> = {}): PreparedItemV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    preparationId: asId("prep-1"),
    version: 1,
    itemId: asId("item-1"),
    status: "active",
    expiresAt: "2026-10-16T01:15:00Z",
    stages: {
      candidate: { status: "ready", value: { track: { providerId: asId("fixture"), mediaId: asId("m1") }, display: null } },
      source: {
        status: "ready",
        value: {
          track: { providerId: asId("fixture"), mediaId: asId("m1") },
          recording: { recordingId: asId("rec-1"), confidence: "provider-asserted" },
          sourceRevision: asId("rev-1"),
          stream: { handle: asId("opaque-handle"), expiresAt: "2026-10-16T01:10:00Z" },
          duration: { kind: "unknown" },
          capabilities: { seekable: true, rangeRequests: true }
        }
      },
      lyrics: { status: "pending" },
      script: { status: "in-progress" },
      voice: { status: "failed", error: { class: "retryable", code: "tts_timeout" } }
    },
    ...overrides
  };
}

test("prepared item expresses per-stage readiness; music can be ready while voice failed", () => {
  const result = decode(preparedItemV1Decoder, prepared());
  assert.ok(result.ok);
  assert.equal(result.value.stages.source.status, "ready");
  assert.equal(result.value.stages.voice.status, "failed");
  const source = result.value.stages.source;
  assert.ok(source.status === "ready");
  assert.equal(source.value.duration.kind, "unknown", "unknown duration stays unknown");
  const media = resolvedMediaFromWire(source.value);
  assert.equal(media.stream.expiresAt, Date.parse("2026-10-16T01:10:00Z"));

  const invalidStage = decode(preparedItemV1Decoder, { ...prepared(), stages: { ...prepared().stages, lyrics: { status: "done" } } });
  assert.ok(!invalidStage.ok);
});

test("only newer versions of the same preparation replace the current one", () => {
  const current = prepared({ version: 3 });
  assert.equal(isNewerPreparation(current, prepared({ version: 2 })), false);
  assert.equal(isNewerPreparation(current, prepared({ version: 4 })), true);
  assert.equal(isNewerPreparation(current, prepared({ version: 9, preparationId: asId<PreparationId>("prep-other") })), false);
});

test("prepare request decodes both explicit tracks and radio candidates", () => {
  const base = { protocolVersion: 1, itemId: "item-1", purpose: "standby", narration: null, wantLyrics: true };
  assert.ok(decode(prepareRequestV1Decoder, { ...base, target: { kind: "track", track: { providerId: "local", mediaId: "a" } } }).ok);
  assert.ok(decode(prepareRequestV1Decoder, { ...base, target: { kind: "radio-candidate", afterItemId: null } }).ok);
  assert.ok(!decode(prepareRequestV1Decoder, { ...base, target: { kind: "surprise" } }).ok);
});

test("lyrics are only accepted for the requested recording and revision", () => {
  const request = { recordingId: asId<never>("rec-1"), sourceRevision: asId<never>("rev-1") };
  const asset = { assetId: asId<never>("l"), recordingId: asId<never>("rec-1"), sourceRevision: asId<never>("rev-1"), timing: "native-line" as const, offsetMs: 0, lines: [] };
  const response: LyricsResponseV1 = {
    protocolVersion: PROTOCOL_VERSION,
    itemId: asId("item-1"),
    sourceRevision: asId("rev-1"),
    result: { status: "available", asset }
  };
  assert.equal(lyricsMatchRecording(response, request), true);
  assert.equal(lyricsMatchRecording({ ...response, result: { status: "available", asset: { ...asset, sourceRevision: asId("rev-2") } } }, request), false, "asset revision disagrees with the request");
  assert.equal(lyricsMatchRecording({ ...response, result: { status: "available", asset: { ...asset, recordingId: asId("rec-other") } } }, request), false, "same revision, different recording");
  assert.equal(lyricsMatchRecording({ ...response, sourceRevision: asId("rev-2") }, request), false, "envelope answers another revision");
  assert.equal(lyricsMatchRecording({ ...response, result: { status: "missing", reason: "not-found" } }, request), true);
});

test("duration precedence: measured element/decoded values beat provider metadata; unknown or weaker never overwrite", () => {
  const provider: DurationInfo = { kind: "known", ms: 120_000, source: "provider-metadata" };
  const container: DurationInfo = { kind: "known", ms: 190_000, source: "container-metadata" };
  const decoded: DurationInfo = { kind: "known", ms: 199_000, source: "decoded" };
  const element: DurationInfo = { kind: "known", ms: 200_000, source: "media-element" };
  const unknown: DurationInfo = { kind: "unknown" };
  assert.equal(preferDuration(unknown, provider), provider);
  assert.equal(preferDuration(provider, unknown), provider);
  assert.equal(preferDuration(provider, container), container);
  assert.equal(preferDuration(container, decoded), decoded);
  assert.equal(preferDuration(provider, element), element);
  assert.equal(preferDuration(decoded, element), element);
  assert.equal(preferDuration(element, provider), element, "provider metadata never overrides the element");
  assert.equal(preferDuration(element, decoded), element);
  assert.equal(preferDuration(element, unknown), element);
  const changed: DurationInfo = { kind: "known", ms: 210_000, source: "media-element" };
  assert.equal(preferDuration(element, changed), changed, "a later durationchange from the element updates it");
});

test("voice length uses measured duration and rate, or stays unknown", () => {
  const voice = {
    assetId: asId<never>("v"),
    scriptAssetId: asId<never>("s"),
    stream: { handle: asId<never>("h"), expiresAt: null },
    playbackRate: 1.25
  };
  assert.equal(spokenDurationMs({ ...voice, duration: { kind: "known", ms: 5000, source: "decoded" } }), 4000);
  assert.equal(spokenDurationMs({ ...voice, duration: { kind: "unknown" } }), null);
});

test("fixed v1 paths and explicit legacy segue reading", () => {
  for (const path of Object.values(API_V1_PATHS)) assert.match(path, /^\/api\/v1\//);
  assert.equal(legacySegueHint("talk_first"), "sequential-talk");
  assert.equal(legacySegueHint("fade_in"), "talk-over-crossfade");
});

test("now projections from the same executor must be strictly newer", () => {
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    executorInstanceId: asId<never>("exec"),
    generation: 3,
    seq: 5,
    observedAt: "2026-10-16T01:00:00Z",
    transport: "playing" as const,
    item: null,
    positionMs: null,
    nextItemId: null,
    speaking: false
  };
  assert.equal(isNewerProjection(base, { ...base, seq: 4 }), false);
  assert.equal(isNewerProjection(base, { ...base, seq: 6 }), true);
});

test("the now projection carries the exhausted transport", () => {
  const projection = {
    protocolVersion: PROTOCOL_VERSION,
    executorInstanceId: "exec",
    generation: 0,
    seq: 1,
    observedAt: "2026-10-16T01:00:00Z",
    transport: "exhausted",
    item: null,
    positionMs: null,
    nextItemId: null,
    speaking: false
  };
  assert.ok(decode(nowProjectionV1Decoder, projection).ok);
  assert.equal(decode(nowProjectionV1Decoder, { ...projection, transport: "drained" }).ok, false);
});

test("same source means same recording id and revision; confidence does not decide continuity", () => {
  const base: ResolvedMedia = {
    track: { providerId: asId("fixture"), mediaId: asId("m1") },
    recording: { recordingId: asId("rec-1"), confidence: "unverified" },
    sourceRevision: asId("rev-1"),
    stream: { handle: asId("h-1"), expiresAt: 1 },
    duration: { kind: "unknown" },
    capabilities: { seekable: true, rangeRequests: true }
  };
  const refreshed: ResolvedMedia = { ...base, stream: { handle: asId("h-2"), expiresAt: 2 } };
  assert.equal(isSameSource(base, refreshed), true, "refreshed URL of an unverified recording");
  assert.equal(isSameSource(base, { ...refreshed, recording: { recordingId: asId("rec-1"), confidence: "content-hash" } }), true);
  assert.equal(isSameSource(base, { ...refreshed, sourceRevision: asId("rev-2") }), false, "same id, new revision");
  assert.equal(isSameSource(base, { ...refreshed, recording: { recordingId: asId("rec-2"), confidence: "unverified" } }), false, "new id, same revision");
});
