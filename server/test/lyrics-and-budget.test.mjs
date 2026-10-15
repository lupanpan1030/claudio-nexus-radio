import assert from "node:assert/strict";
import test from "node:test";
import { parseClock, parseKrc, parseLrc, parseLyricsDocument, parsePlain } from "../application/lyrics/parse.ts";
import { toAvailability } from "../application/lyrics/lyrics-service.ts";
import { isSungLine, lyricOnsetHintMs, planIntroOverlap } from "../application/narration/intro-window.ts";

test("LRC clock keeps fractional precision instead of truncating to seconds", () => {
  assert.equal(parseClock("01:02.5"), 62_500);
  assert.equal(parseClock("01:02.05"), 62_050);
  assert.equal(parseClock("01:02.345"), 62_345);
  assert.equal(parseClock("00:07:20"), 7_200);
  assert.equal(parseClock("00:61.00"), null);
});

test("line-timed LRC stays native-line, expands repeated stamps and maps offset sign", () => {
  const parsed = parseLrc("[ti:x]\n[offset:+300]\n[00:12.50][00:40.00]副歌\n[00:05.10]第一句\n");
  assert.equal(parsed.timing, "native-line");
  assert.deepEqual(parsed.lines.map((line) => [line.startMs, line.text]), [[5100, "第一句"], [12500, "副歌"], [40000, "副歌"]]);
  // LRC +300 shows lyrics earlier; the contract's positive offset delays them.
  assert.equal(parsed.offsetMs, -300);
  assert.equal(parsed.lines.some((line) => line.words), false);
  assert.equal(parsed.lines.some((line) => line.endMs !== undefined), false, "no invented line ends");
});

test("enhanced LRC is native-word only when every sung character has a source word time", () => {
  const full = parseLrc("[00:01.00]<00:01.00>你<00:01.40>好<00:01.90>\n[00:03.00]<00:03.00>再<00:03.30>见<00:03.80>\n");
  assert.equal(full.timing, "native-word");
  assert.deepEqual(full.lines[0].words, [
    { startMs: 1000, endMs: 1400, text: "你" },
    { startMs: 1400, endMs: 1900, text: "好" }
  ]);
  const partial = parseLrc("[00:01.00]<00:01.00>你<00:01.40>好 世界\n[00:03.00]再见\n");
  assert.equal(partial.timing, "native-line");
  assert.equal(partial.lines[0].text, "你好 世界");
  assert.equal(partial.lines.some((line) => line.words), false);
});

test("KRC word offsets are relative to the line start", () => {
  const parsed = parseKrc("[id:$0]\n[1000,2000]<0,500,0>一<500,700,0>二\n[4000,1000]<0,1000,0>三\n");
  assert.equal(parsed.timing, "native-word");
  assert.deepEqual(parsed.lines[0], {
    startMs: 1000,
    endMs: 3000,
    text: "一二",
    words: [
      { startMs: 1000, endMs: 1500, text: "一" },
      { startMs: 1500, endMs: 2200, text: "二" }
    ]
  });
});

test("plain text never receives timing and instrumental markers become missing", () => {
  const plain = parsePlain("第一行\n\n第二行");
  assert.equal(plain.timing, "plain-text");
  assert.deepEqual(plain.lines, [{ text: "第一行" }, { text: "第二行" }]);
  assert.equal(parseLyricsDocument("lrc", "[ar:Someone]\n只有文字").timing, "plain-text");
  const source = { sourceRevision: "rev-1", recordingId: "rec-1" };
  assert.deepEqual(toAvailability(source, { kind: "text", format: "lrc", text: "[00:01.00]纯音乐，请欣赏", documentKey: "k" }), {
    status: "missing",
    reason: "instrumental"
  });
  const available = toAvailability(source, { kind: "text", format: "lrc", text: "[00:01.00]a", documentKey: "k" });
  assert.equal(available.status, "available");
  assert.equal(available.asset.sourceRevision, "rev-1");
  assert.equal(available.asset.recordingId, "rec-1");
});

test("the lyric onset hint skips Chinese credit rows and section markers but not sung brackets", () => {
  assert.equal(isSungLine("作词 : 某人"), false);
  assert.equal(isSungLine("编曲：某人"), false);
  assert.equal(isSungLine("[前奏]"), false);
  assert.equal(isSungLine("(Chorus 2)"), false);
  assert.equal(isSungLine("(ooh ooh)"), true);
  assert.equal(isSungLine("你好"), true);
  const asset = {
    assetId: "a",
    recordingId: "r",
    sourceRevision: "s",
    timing: "native-line",
    offsetMs: 200,
    lines: [
      { startMs: 0, text: "作词 : 某人" },
      { startMs: 1000, text: "作曲 : 某人" },
      { startMs: 9000, text: "第一句" }
    ]
  };
  assert.equal(lyricOnsetHintMs(asset), 9200);
  assert.equal(lyricOnsetHintMs({ ...asset, timing: "plain-text" }), null);
});

test("intro overlap needs an explicitly trusted window for this revision; a lyric line alone is never enough", () => {
  const lyrics = { assetId: "a", recordingId: "r", sourceRevision: "s", timing: "native-word", offsetMs: 0, lines: [{ startMs: 8000, text: "唱" }] };
  const hint = lyricOnsetHintMs(lyrics);
  assert.equal(hint, 8000);
  // The hint is not evidence: no window, no overlap — whatever the lyrics say.
  assert.deepEqual(planIntroOverlap({ sourceRevision: "s", window: null, spokenMs: 5000 }), { kind: "unavailable", reason: "no-trusted-intro-window" });
  assert.deepEqual(planIntroOverlap({ sourceRevision: "s", window: { sourceRevision: "s", vocalOnsetMs: hint, evidence: "lyrics" }, spokenMs: 5000 }), {
    kind: "unavailable",
    reason: "no-trusted-intro-window"
  });
  const trusted = { sourceRevision: "s", vocalOnsetMs: 8000, evidence: "verified" };
  assert.deepEqual(planIntroOverlap({ sourceRevision: "other", window: trusted, spokenMs: 5000 }), { kind: "unavailable", reason: "no-trusted-intro-window" }, "evidence is per revision");
  // With trusted evidence the budget follows min(onset - ramp, voice - head).
  assert.deepEqual(planIntroOverlap({ sourceRevision: "s", window: trusted, spokenMs: 5000 }), { kind: "overlap", overlapMs: 4000, leadMs: 1000, vocalOnsetMs: 8000 });
  assert.deepEqual(planIntroOverlap({ sourceRevision: "s", window: { ...trusted, evidence: "manual" }, spokenMs: 20_000 }), { kind: "overlap", overlapMs: 7600, leadMs: 12_400, vocalOnsetMs: 8000 });
  assert.deepEqual(planIntroOverlap({ sourceRevision: "s", window: trusted, spokenMs: null }), { kind: "unavailable", reason: "voice-duration-unknown" });
  assert.deepEqual(planIntroOverlap({ sourceRevision: "s", window: { ...trusted, vocalOnsetMs: 2000 }, spokenMs: 5000 }), { kind: "unavailable", reason: "vocals-too-early" });
  assert.deepEqual(planIntroOverlap({ sourceRevision: "s", window: trusted, spokenMs: 2000 }), { kind: "unavailable", reason: "voice-too-short" });
});
