import assert from "node:assert/strict";
import test from "node:test";
import {
  decode,
  isoTimestamp,
  isNewerProjection,
  lyricsAssetDecoder,
  narrationResponseV1Decoder,
  narrationScriptDecoder,
  nowProjectionV1Decoder,
  parseIsoTimestamp,
  preparedItemV1Decoder,
  resolvedMediaFromWire,
  resolvedMediaWireDecoder,
  startedRequestV1Decoder,
  subtitleTrackDecoder,
  wireTimeToClock,
  type Validated
} from "../src/index.js";

// Inputs mirror /tmp/claudio-implementation-20261016/contracts-boundary-probes.mjs.
const lyric = {
  assetId: "lyrics-1",
  recordingId: "recording-1",
  sourceRevision: "revision-1",
  timing: "native-word",
  offsetMs: 0,
  lines: [{ startMs: 100, endMs: 300, text: "hello", words: [{ startMs: 100, endMs: 300, text: "hello" }] }]
};
const script = { assetId: "script-1", version: 1, text: "hello", subtitle: { timing: "plain-text", segments: [{ text: "hello" }] } };
const voice = {
  assetId: "voice-1",
  scriptAssetId: "script-1",
  stream: { handle: "handle-1", expiresAt: null },
  duration: { kind: "known", ms: 1000, source: "decoded" },
  playbackRate: 1
};
const media = {
  track: { providerId: "library", mediaId: "media-a" },
  recording: { recordingId: "recording-1", confidence: "content-hash" },
  sourceRevision: "revision-1",
  stream: { handle: "handle-1", expiresAt: null },
  duration: { kind: "known", ms: 10000, source: "decoded" },
  capabilities: { seekable: true, rangeRequests: true }
};
const now = {
  protocolVersion: 1,
  executorInstanceId: "executor-1",
  seq: 1,
  observedAt: "2026-10-16T00:00:00Z",
  transport: "idle",
  item: null,
  positionMs: null,
  nextItemId: null,
  speaking: false
};
const narration = {
  protocolVersion: 1,
  cueId: "cue-1",
  transitionId: "transition-1",
  version: 1,
  script: { status: "ready", value: script },
  voice: { status: "ready", value: voice }
};
const prepared = {
  protocolVersion: 1,
  preparationId: "preparation-1",
  version: 1,
  itemId: "item-1",
  status: "ready",
  expiresAt: "2026-10-16T00:01:00Z",
  stages: {
    candidate: { status: "ready", value: { track: { providerId: "library", mediaId: "media-a" }, display: null } },
    source: { status: "ready", value: media },
    lyrics: { status: "ready", value: { status: "available", asset: lyric } },
    script: { status: "ready", value: script },
    voice: { status: "ready", value: voice }
  }
};

function issuePaths(result: Validated<unknown>): string[] {
  assert.ok(!result.ok, "expected rejection");
  return result.issues.map((issue) => issue.path);
}

// ------------------------------------------------------------------ ISO timestamps

test("ISO timestamps must name a real instant, not just match the shape", () => {
  for (const bad of [
    "2026-99-99T99:99:99Z",
    "2026-02-30T12:00:00Z",
    "2026-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-10-00T00:00:00Z",
    "2026-10-16T24:00:00Z",
    "2026-10-16T23:60:00Z",
    "2026-10-16T23:59:60Z",
    "2026-10-16T12:00:00+24:00",
    "2026-10-16T12:00:00+05:60",
    "2026-10-16T12:00:00",
    "2026-10-16 12:00:00Z"
  ]) {
    assert.equal(decode(isoTimestamp, bad).ok, false, bad);
    assert.equal(parseIsoTimestamp(bad), null, bad);
  }
  for (const good of ["2024-02-29T23:59:59Z", "2000-02-29T00:00:00Z", "2026-10-16T01:02:03.000Z", "2026-10-16T01:02:03.5+13:00"]) {
    assert.equal(decode(isoTimestamp, good).ok, true, good);
  }
});

test("pure ISO parsing agrees with the platform for valid instants, offsets and fractions", () => {
  for (const iso of [
    "2026-10-16T01:02:03Z",
    "2026-10-16T01:02:03.456Z",
    "2026-10-16T01:02:03.4Z",
    "2026-10-16T13:00:00+13:00",
    "2026-10-15T20:30:00-04:30",
    "2024-02-29T12:00:00Z",
    "1969-12-31T23:59:59.999Z",
    "1970-01-01T00:00:00Z",
    "2100-03-01T00:00:00Z",
    "0001-01-01T00:00:00Z"
  ]) {
    assert.equal(parseIsoTimestamp(iso), Date.parse(iso), iso);
  }
  assert.equal(parseIsoTimestamp("2026-10-16T01:02:03.456789Z"), Date.parse("2026-10-16T01:02:03.456Z"), "sub-ms truncated");
});

test("an impossible expiry fails the whole media decode instead of becoming 'no expiry'", () => {
  const input = { ...media, stream: { ...media.stream, expiresAt: "2026-99-99T99:99:99Z" } };
  assert.deepEqual(issuePaths(decode(resolvedMediaWireDecoder, input)), ["$.stream.expiresAt"]);
  assert.deepEqual(issuePaths(decode(resolvedMediaWireDecoder, { ...input, stream: { ...input.stream, expiresAt: "2026-02-30T12:00:00Z" } })), [
    "$.stream.expiresAt"
  ]);

  const valid = decode(resolvedMediaWireDecoder, { ...media, stream: { ...media.stream, expiresAt: "2026-10-16T02:00:00+01:00" } });
  assert.ok(valid.ok);
  assert.equal(resolvedMediaFromWire(valid.value).stream.expiresAt, Date.parse("2026-10-16T01:00:00Z"));
  const unbounded = decode(resolvedMediaWireDecoder, media);
  assert.ok(unbounded.ok);
  assert.equal(resolvedMediaFromWire(unbounded.value).stream.expiresAt, null, "only an explicit null means no expiry");
});

test("converting an undecoded bad timestamp throws rather than returning null", () => {
  assert.equal(wireTimeToClock(null), null);
  assert.throws(() => wireTimeToClock("2026-02-30T12:00:00Z"), RangeError);
  assert.throws(() => resolvedMediaFromWire({ ...media, stream: { handle: "h", expiresAt: "2026-99-99T99:99:99Z" } } as never), RangeError);
});

test("prepared expiry, started time and projection time all reject impossible dates", () => {
  assert.ok(issuePaths(decode(preparedItemV1Decoder, { ...prepared, expiresAt: "2026-02-30T00:01:00Z" })).includes("$.expiresAt"));
  assert.ok(issuePaths(decode(nowProjectionV1Decoder, { ...now, observedAt: "2026-10-16T25:00:00Z" })).includes("$.observedAt"));
  const started = {
    protocolVersion: 1,
    idempotencyKey: "k",
    executorInstanceId: "e",
    itemId: "i",
    track: { providerId: "library", mediaId: "m" },
    recordingId: "r",
    sourceRevision: "s",
    loadId: "l",
    positionMs: 120.5,
    startedAt: "2026-04-31T00:00:00Z"
  };
  assert.ok(issuePaths(decode(startedRequestV1Decoder, started)).includes("$.startedAt"));
  assert.ok(decode(startedRequestV1Decoder, { ...started, startedAt: "2026-04-30T00:00:00Z" }).ok, "fractional media position still allowed");
});

// ------------------------------------------------------------------ counters

test("version/seq counters must be safe integers so the next value is still larger", () => {
  assert.deepEqual(issuePaths(decode(nowProjectionV1Decoder, { ...now, seq: 1e100 })), ["$.seq"]);
  assert.deepEqual(issuePaths(decode(nowProjectionV1Decoder, { ...now, seq: Number.MAX_SAFE_INTEGER + 1 })), ["$.seq"]);
  assert.deepEqual(issuePaths(decode(nowProjectionV1Decoder, { ...now, seq: 1.5 })), ["$.seq"]);
  const top = decode(nowProjectionV1Decoder, { ...now, seq: Number.MAX_SAFE_INTEGER });
  assert.ok(top.ok);
  assert.equal(isNewerProjection({ ...top.value, seq: Number.MAX_SAFE_INTEGER - 1 }, top.value), true);

  assert.deepEqual(issuePaths(decode(preparedItemV1Decoder, { ...prepared, version: 2 ** 53 })), ["$.version"]);
  assert.deepEqual(issuePaths(decode(narrationResponseV1Decoder, { ...narration, version: 1e100 })), ["$.version"]);
  assert.deepEqual(issuePaths(decode(narrationScriptDecoder, { ...script, version: 1e300 })), ["$.version"]);
});

// ------------------------------------------------------------------ lyric / subtitle timing

test("lyrics: reversed intervals and timing/field contradictions are rejected with paths", () => {
  const reversed = { ...lyric, lines: [{ startMs: 200, endMs: 100, text: "hello", words: [{ startMs: 900, endMs: 50, text: "hello" }] }] };
  assert.deepEqual(issuePaths(decode(lyricsAssetDecoder, reversed)), ["$.lines[0].endMs", "$.lines[0].words[0].endMs"]);

  assert.deepEqual(issuePaths(decode(lyricsAssetDecoder, { ...lyric, timing: "plain-text" })), ["$.lines[0]", "$.lines[0].words"]);
  assert.deepEqual(issuePaths(decode(lyricsAssetDecoder, { ...lyric, timing: "plain-text", lines: [{ text: "a", words: [] }] })), ["$.lines[0].words"]);
  assert.deepEqual(issuePaths(decode(lyricsAssetDecoder, { ...lyric, lines: [{ text: "hello" }] })), ["$.lines[0].startMs"]);
  assert.deepEqual(issuePaths(decode(lyricsAssetDecoder, { ...lyric, timing: "native-line", lines: [{ endMs: 5, text: "x" }] })), ["$.lines[0].startMs"]);
  assert.deepEqual(issuePaths(decode(lyricsAssetDecoder, { ...lyric, timing: "native-line" })), ["$.lines[0].words"]);
  assert.deepEqual(issuePaths(decode(lyricsAssetDecoder, { ...lyric, timing: "estimated" })), ["$.lines[0].words"]);

  const unorderedLines = { ...lyric, timing: "native-line", lines: [{ startMs: 500, text: "b" }, { startMs: 100, text: "a" }] };
  assert.deepEqual(issuePaths(decode(lyricsAssetDecoder, unorderedLines)), ["$.lines[1].startMs"]);
  const unorderedWords = {
    ...lyric,
    lines: [{ startMs: 0, text: "ab", words: [{ startMs: 300, endMs: 400, text: "a" }, { startMs: 100, endMs: 200, text: "b" }] }]
  };
  assert.deepEqual(issuePaths(decode(lyricsAssetDecoder, unorderedWords)), ["$.lines[0].words[1].startMs"]);
});

test("lyrics: LRC-style start-only lines, duets, empty lines and plain text stay valid", () => {
  const lrc = { ...lyric, timing: "native-line", lines: [{ startMs: 0, text: "" }, { startMs: 1000, text: "a" }, { startMs: 1000, text: "b" }] };
  assert.ok(decode(lyricsAssetDecoder, lrc).ok, "start-only, equal starts allowed");
  const duet = { ...lyric, timing: "native-line", lines: [{ startMs: 0, endMs: 5000, text: "lead" }, { startMs: 1000, endMs: 3000, text: "harmony" }] };
  assert.ok(decode(lyricsAssetDecoder, duet).ok, "overlapping lines are not forbidden");
  const leadingWord = { ...lyric, lines: [{ startMs: 1000, text: "hi", words: [{ startMs: 900, endMs: 1100, text: "hi" }] }, { startMs: 2000, text: "" }] };
  assert.ok(decode(lyricsAssetDecoder, leadingWord).ok, "word containment in the line is not judged; wordless line allowed");
  assert.ok(decode(lyricsAssetDecoder, { ...lyric, timing: "plain-text", lines: [{ text: "a" }, { text: "b" }] }).ok);
});

test("subtitles: reversed, unordered, untimed-but-timed and timed-but-plain segments are rejected", () => {
  assert.deepEqual(issuePaths(decode(subtitleTrackDecoder, { timing: "native-line", segments: [{ startMs: 1000, endMs: 10, text: "hello" }] })), [
    "$.segments[0].endMs"
  ]);
  assert.deepEqual(issuePaths(decode(subtitleTrackDecoder, { timing: "estimated", segments: [{ text: "a" }] })), ["$.segments[0].startMs"]);
  assert.deepEqual(issuePaths(decode(subtitleTrackDecoder, { timing: "plain-text", segments: [{ startMs: 0, text: "a" }] })), ["$.segments[0]"]);
  assert.deepEqual(
    issuePaths(decode(subtitleTrackDecoder, { timing: "estimated", segments: [{ startMs: 900, text: "b" }, { startMs: 0, text: "a" }] })),
    ["$.segments[1].startMs"]
  );
  assert.ok(decode(subtitleTrackDecoder, { timing: "estimated", segments: [{ startMs: 0, endMs: 900, text: "a" }, { startMs: 900, text: "b" }] }).ok);
  assert.deepEqual(issuePaths(decode(narrationScriptDecoder, { ...script, subtitle: { timing: "native-line", segments: [{ text: "x" }] } })), [
    "$.subtitle.segments[0].startMs"
  ]);
});

// ------------------------------------------------------------------ same-response identity

test("a ready voice must belong to the ready script of the same response", () => {
  const mismatch = { ...narration, voice: { status: "ready", value: { ...voice, scriptAssetId: "script-other" } } };
  assert.deepEqual(issuePaths(decode(narrationResponseV1Decoder, mismatch)), ["$.voice.value.scriptAssetId"]);
  assert.ok(decode(narrationResponseV1Decoder, narration).ok);
  assert.ok(
    decode(narrationResponseV1Decoder, { ...narration, script: { status: "failed", error: { class: "retryable", code: "llm" } } }).ok,
    "nothing to compare without a ready script"
  );
});

test("prepared stages of one version may not contradict each other", () => {
  assert.ok(decode(preparedItemV1Decoder, prepared).ok);
  const voiceMismatch = { ...prepared, stages: { ...prepared.stages, voice: { status: "ready", value: { ...voice, scriptAssetId: "script-other" } } } };
  assert.deepEqual(issuePaths(decode(preparedItemV1Decoder, voiceMismatch)), ["$.stages.voice.value.scriptAssetId"]);

  const lyricsFor = (asset: object) => ({ ...prepared, stages: { ...prepared.stages, lyrics: { status: "ready", value: { status: "available", asset } } } });
  assert.deepEqual(issuePaths(decode(preparedItemV1Decoder, lyricsFor({ ...lyric, sourceRevision: "revision-other" }))), ["$.stages.lyrics.value.asset"]);
  assert.deepEqual(issuePaths(decode(preparedItemV1Decoder, lyricsFor({ ...lyric, recordingId: "recording-other" }))), ["$.stages.lyrics.value.asset"]);

  // Not decided by the decoder: candidate vs source track (fallback policy) and external currency.
  const otherCandidate = { ...prepared, stages: { ...prepared.stages, candidate: { status: "ready", value: { track: { providerId: "library", mediaId: "media-b" }, display: null } } } };
  assert.ok(decode(preparedItemV1Decoder, otherCandidate).ok);
  const otherRevision = lyricsFor({ ...lyric, sourceRevision: "revision-other" });
  const sourcePending = { ...otherRevision, stages: { ...otherRevision.stages, source: { status: "pending" } } };
  assert.ok(decode(preparedItemV1Decoder, sourcePending).ok, "no ready source in this payload to contradict");
});

test("refined decoders still drop unknown keys at every level", () => {
  const input = {
    ...narration,
    accountToken: "secret",
    script: { status: "ready", value: { ...script, filePath: "/home/private/a.txt", subtitle: { ...script.subtitle, internal: 1 } } },
    voice: { status: "ready", value: { ...voice, upstreamUrl: "https://private.invalid/a.mp3" } }
  };
  const result = decode(narrationResponseV1Decoder, input);
  assert.ok(result.ok);
  assert.deepEqual(result.value, narration);
  assert.doesNotMatch(JSON.stringify(result.value), /secret|private|internal/);

  const lyricResult = decode(lyricsAssetDecoder, { ...lyric, debug: true, lines: [{ ...lyric.lines[0], raw: "[00:00.10]hello" }] });
  assert.ok(lyricResult.ok);
  assert.deepEqual(lyricResult.value, lyric);
});
