import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { decode, lyricsAvailabilityDecoder } from "@claudio/contracts";
import { LYRICS_PARSER_VERSION, parseKrc, parseLrc, parseLyricsDocument, parsePlain } from "../application/lyrics/parse.ts";
import { LyricsService, toAvailability } from "../application/lyrics/lyrics-service.ts";
import { DEFAULT_PLAYBACK_POLICY } from "../application/policy.ts";
import { runMigrations } from "../adapters/sqlite/migrations.ts";
import { createSqlitePlaybackStores } from "../adapters/sqlite/playback-stores.ts";
import { ProviderRegistry } from "../ports/providers.ts";

// Inputs from the R3 lyrics parser audit (all self-generated) plus the extra edges it asked for.
const clock = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000`;
const AUDIT = [
  ["lrc-basic", "lrc", "[00:01.2]甲\n[00:02.34]乙\n[00:03.456]丙"],
  ["enhanced-complete", "lrc", "[00:01.00]<00:01.00>你<00:01.50>好<00:02.00>"],
  ["enhanced-missing-closing", "lrc", "[00:01.00]<00:01.00>你<00:01.50>好"],
  ["enhanced-untimed-prefix", "lrc", "[00:01.00]前缀<00:01.00>你<00:01.50>好<00:02.00>"],
  ["enhanced-backward-tags", "lrc", "[00:01.00]<00:02.00>你<00:01.50>好<00:03.00>"],
  ["enhanced-early-word", "lrc", "[00:10.00]<00:09.50>你<00:10.50>"],
  ["enhanced-word-beyond-next-line", "lrc", "[00:01.00]<00:01.00>甲<00:10.00>\n[00:02.00]<00:02.00>乙<00:03.00>"],
  ["krc-basic", "krc", "[1000,1000]<0,500,0>你<500,500,0>好"],
  ["krc-untimed-prefix", "krc", "[1000,1000]前缀<0,500,0>你<500,500,0>好"],
  ["krc-malformed-middle-tag", "krc", "[1000,1000]<0,300,0>你<300,300>漏掉<600,400,0>好"],
  ["krc-word-past-line-end", "krc", "[1000,200]<0,500,0>你好"],
  ["krc-backward-words", "krc", "[1000,1000]<500,100,0>甲<0,100,0>乙"],
  ["krc-overflow-header", "krc", `[${"9".repeat(400)},1000]<0,500,0>你好`],
  ["krc-overflow-word", "krc", `[1000,1000]<${"9".repeat(400)},500,0>你好`],
  ["krc-overflow-sum", "krc", `[${"9".repeat(308)},${"9".repeat(308)}]<0,1,0>你好`],
  ["krc-nan-header", "krc", "[NaN,1000]<0,500,0>你好"],
  ["plain", "plain", "你好\n world 😀 "],
  ["mixed-timed-untimed", "lrc", "[00:01.00]甲\n未定时的另一行\n[00:02.00]乙"],
  ["enhanced-501-words", "lrc", "[00:00.000]" + Array.from({ length: 501 }, (_, i) => `<${clock(i)}>字`).join("") + `<${clock(501)}>`],
  ["krc-501-words", "krc", "[0,1000]" + Array.from({ length: 501 }, (_, i) => `<${i},1,0>字`).join("")],
  ["krc-duet-overlap", "krc", "[1000,3000]<0,3000,0>甲唱\n[2000,2000]<0,2000,0>乙和"]
];

function finiteEverywhere(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteEverywhere);
  if (value && typeof value === "object") return Object.values(value).every(finiteEverywhere);
  return true;
}

const asAvailability = (format, text) => toAvailability({ sourceRevision: "rev-1", recordingId: "rec-1" }, { kind: "text", format, text, documentKey: "doc" });

test("every audit input yields finite times and an outbound DTO the contracts decoder accepts", () => {
  for (const [name, format, text] of AUDIT) {
    const parsed = parseLyricsDocument(format, text);
    assert.ok(finiteEverywhere(parsed), `${name}: no Infinity/NaN`);
    const result = asAvailability(format, text);
    const decoded = decode(lyricsAvailabilityDecoder, JSON.parse(JSON.stringify(result)));
    assert.ok(decoded.ok, `${name}: ${JSON.stringify(decoded.issues)}`);
    if (result.status === "available") {
      assert.equal(result.asset.recordingId, "rec-1");
      assert.equal(result.asset.sourceRevision, "rev-1");
    }
    if (parsed?.timing === "native-word") {
      for (const line of parsed.lines) {
        if (!line.text) continue;
        assert.equal(line.words.map((word) => word.text).join("").replace(/\s+/g, ""), line.text.replace(/\s+/g, ""), `${name}: words cover the whole line`);
        if (line.endMs !== undefined) {
          for (const word of line.words) assert.ok(word.startMs >= line.startMs && word.endMs <= line.endMs, `${name}: word inside its explicit line`);
        }
      }
    }
  }
});

test("KRC numbers outside the supported range never produce a clock; text is kept untimed", () => {
  for (const text of [`[${"9".repeat(400)},1000]<0,500,0>你好`, `[${"9".repeat(308)},${"9".repeat(308)}]<0,1,0>你好`]) {
    const parsed = parseKrc(text);
    assert.equal(parsed.timing, "plain-text");
    assert.deepEqual(parsed.lines, [{ text: "你好" }]);
  }
  const header = parseKrc(`[1000,800]<0,400,0>前\n[${"9".repeat(12)},500]<0,500,0>后`);
  assert.equal(header.timing, "plain-text", "one unplaceable line makes the document untimed rather than dropping it");
  assert.deepEqual(header.lines.map((line) => line.text), ["前", "后"]);
  const word = parseKrc(`[1000,1000]<${"9".repeat(400)},500,0>你好`);
  assert.equal(word.timing, "native-line");
  assert.deepEqual(word.lines, [{ startMs: 1000, endMs: 2000, text: "你好" }]);
  assert.equal(parseKrc("[86400000,1]<0,1,0>迟").timing, "plain-text", "a line ending after 24 h is out of range");
});

test("KRC keeps untagged prefixes and text after malformed tags, and only then claims word timing", () => {
  const prefix = parseKrc("[1000,1000]前缀<0,500,0>你<500,500,0>好");
  assert.equal(prefix.timing, "native-line");
  assert.deepEqual(prefix.lines, [{ startMs: 1000, endMs: 2000, text: "前缀你好" }]);
  const malformed = parseKrc("[1000,1000]<0,300,0>你<300,300>漏掉<600,400,0>好");
  assert.equal(malformed.timing, "native-line");
  assert.equal(malformed.lines[0].text, "你漏掉好");
  assert.equal(malformed.lines[0].words, undefined);
  const backward = parseKrc("[1000,1000]<500,100,0>甲<0,100,0>乙");
  assert.equal(backward.timing, "native-line");
  assert.equal(backward.lines[0].text, "甲乙");
});

test("a KRC word past its line's explicit end demotes the document instead of contradicting the line", () => {
  const parsed = parseKrc("[1000,200]<0,500,0>你好\n[2000,1000]<0,1000,0>再见");
  assert.equal(parsed.timing, "native-line");
  assert.deepEqual(parsed.lines, [
    { startMs: 1000, endMs: 1200, text: "你好" },
    { startMs: 2000, endMs: 3000, text: "再见" }
  ]);
  const edge = parseKrc("[1000,500]<0,500,0>你好");
  assert.equal(edge.timing, "native-word", "ending exactly at the line end is inside");
});

test("overlapping lines (duets) keep native word timing; only a word outside its own line counts", () => {
  const parsed = parseKrc("[1000,3000]<0,3000,0>甲唱\n[2000,2000]<0,2000,0>乙和");
  assert.equal(parsed.timing, "native-word");
  assert.deepEqual(parsed.lines.map((line) => [line.startMs, line.endMs, line.words.length]), [[1000, 4000, 1], [2000, 4000, 1]]);
  const lrc = parseLrc("[00:01.00]<00:01.00>甲<00:10.00>\n[00:02.00]<00:02.00>乙<00:03.00>");
  assert.equal(lrc.timing, "native-word", "an LRC word may run past the next line's start");
});

test("an LRC word before its line's start keeps the text and demotes to line timing", () => {
  const parsed = parseLrc("[00:10.00]<00:09.50>你<00:10.50>\n[00:12.00]<00:12.00>好<00:12.50>");
  assert.equal(parsed.timing, "native-line");
  assert.deepEqual(parsed.lines, [
    { startMs: 10_000, text: "你" },
    { startMs: 12_000, text: "好" }
  ]);
});

test("the 500-word cap is applied before coverage: an over-long line keeps all its text and loses word timing", () => {
  const enhanced = parseLrc("[00:00.000]" + Array.from({ length: 501 }, (_, i) => `<${clock(i)}>字`).join("") + `<${clock(501)}>`);
  const krc = parseKrc("[0,1000]" + Array.from({ length: 501 }, (_, i) => `<${i},1,0>字`).join(""));
  for (const parsed of [enhanced, krc]) {
    assert.equal(parsed.timing, "native-line");
    assert.equal(parsed.lines[0].text.length, 501);
    assert.equal(parsed.lines[0].words, undefined);
  }
  const fits = parseKrc("[0,1000]" + Array.from({ length: 500 }, (_, i) => `<${i},1,0>字`).join(""));
  assert.equal(fits.timing, "native-word");
  assert.equal(fits.lines[0].words.length, 500);
  const longWord = parseKrc(`[0,1000]<0,10,0>${"长".repeat(201)}`);
  assert.equal(longWord.timing, "native-line", "a word longer than the contract allows is not cut");
  assert.equal(longWord.lines[0].text.length, 201);
});

test("documents that only fit by cutting lines or line text are refused, not shortened", () => {
  assert.equal(parseLrc(`[00:01.00]${"字".repeat(2001)}`), null);
  assert.equal(parseKrc(`[0,1000]${"字".repeat(2001)}`), null);
  assert.equal(parsePlain(`${"字".repeat(2001)}`), null);
  assert.equal(parseLyricsDocument("lrc", `[00:01.00]${"字".repeat(2001)}`), null, "no plain-text fallback for a refused timed document");
  assert.equal(parseLrc(Array.from({ length: 5001 }, (_, i) => `[00:${String(i % 60).padStart(2, "0")}.00]x`).join("\n")), null);
  assert.deepEqual(asAvailability("lrc", `[00:01.00]${"字".repeat(2001)}`), { status: "missing", reason: "not-found" });
});

test("a KRC label is never re-read as LRC; LRC without stamps still falls back to plain text", () => {
  assert.equal(parseLyricsDocument("krc", "[00:01.00]其实是LRC"), null);
  assert.equal(parseLyricsDocument("lrc", "[ar:Someone]\n只有文字").timing, "plain-text");
});

function serviceFixture() {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const stores = createSqlitePlaybackStores(db, () => null);
  let fetches = 0;
  const providers = new ProviderRegistry([
    {
      providerId: "fixture",
      catalog: { describe: () => null, search: () => [] },
      source: { resolve: async () => assert.fail("not used"), open: async () => assert.fail("not used") },
      lyrics: {
        fetch: async () => {
          fetches += 1;
          return { kind: "text", format: "lrc", text: "[00:01.00]新解析", documentKey: "doc-1" };
        }
      }
    }
  ]);
  const record = {
    sourceRevision: "rev-1",
    track: { providerId: "fixture", mediaId: "m1" },
    legacyTrackId: null,
    recordingId: "rec-1",
    confidence: "content-hash",
    duration: { kind: "unknown" },
    binding: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
    expiresAt: null
  };
  stores.resolvedSources.upsert(record);
  const service = new LyricsService({ providers, resolvedSources: stores.resolvedSources, store: stores.lyrics, clock: { now: () => 5 }, policy: DEFAULT_PLAYBACK_POLICY });
  return { db, stores, service, record, fetches: () => fetches };
}

test("lyrics stay bound to the requested recording and revision; stale or foreign cache rows are re-derived", async () => {
  const fx = serviceFixture();
  const signal = new AbortController().signal;
  const query = { track: fx.record.track, sourceRevision: "rev-1", recordingId: "rec-1" };
  await assert.rejects(fx.service.forRevision({ ...query, recordingId: "rec-other" }, signal), (error) => error.info.code === "revision_mismatch");

  // A row written by the earlier parser (no parser_version → 0) is not served.
  const stale = { status: "available", asset: { assetId: "old", recordingId: "rec-1", sourceRevision: "rev-1", timing: "native-word", offsetMs: 0, lines: [{ startMs: 1, endMs: null, text: "旧" }] } };
  fx.db.prepare("INSERT INTO lyrics_assets (source_revision, availability_json, created_at) VALUES ('rev-1', ?, 0)").run(JSON.stringify(stale));
  const fresh = await fx.service.forRevision(query, signal);
  assert.equal(fresh.asset.lines[0].text, "新解析");
  assert.equal(fx.fetches(), 1);
  assert.equal(fx.db.prepare("SELECT parser_version FROM lyrics_assets WHERE source_revision = 'rev-1'").get().parser_version, LYRICS_PARSER_VERSION);
  await fx.service.forRevision(query, signal);
  assert.equal(fx.fetches(), 1, "a current cache row is reused");

  // A current-version row naming another recording is never returned.
  const foreign = { status: "available", asset: { ...fresh.asset, recordingId: "rec-other" } };
  fx.stores.lyrics.put("rev-1", foreign, 6, LYRICS_PARSER_VERSION);
  const rebound = await fx.service.forRevision(query, signal);
  assert.equal(rebound.asset.recordingId, "rec-1");
  assert.equal(fx.fetches(), 2);
  fx.db.close();
});
