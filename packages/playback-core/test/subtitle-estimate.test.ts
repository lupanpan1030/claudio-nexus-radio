import assert from "node:assert/strict";
import test from "node:test";
import { decode, subtitleTrackDecoder, type CueAsset, type SubtitleTrack } from "@claudio/contracts";
import { estimateSubtitleTiming, MAX_ESTIMATED_SEGMENTS, toSnapshot, type CoreConfig } from "../src/index.js";
import { cueAsset, Sim } from "./harness.js";

const SCRIPT = "雨停了。今晚的城市很安静，适合慢慢听一首歌！下一首，送给还在路上的你";

const plain = (text: string): SubtitleTrack => ({ timing: "plain-text", segments: [{ text }] });

function asset(text: string, durationMs: number | null, playbackRate = 1): CueAsset {
  const base = cueAsset(text, durationMs);
  return { ...base, voice: { ...base.voice, playbackRate } };
}

function assertWellFormed(track: SubtitleTrack, durationMs: number): void {
  assert.equal(track.timing, "estimated");
  assert.ok(decode(subtitleTrackDecoder, track).ok, "passes the shared decoder");
  assert.equal(track.segments[0]!.startMs, 0);
  assert.equal(track.segments.at(-1)!.endMs, durationMs, "ends exactly at the measured media duration");
  track.segments.forEach((segment, index) => {
    assert.ok(segment.endMs! >= segment.startMs!);
    if (index > 0) assert.equal(segment.startMs, track.segments[index - 1]!.endMs, "contiguous, monotonic");
  });
}

test("plain-text script with a measured duration becomes estimated sentences weighted by length and pauses", () => {
  const track = estimateSubtitleTiming(plain(SCRIPT), 6000);
  assertWellFormed(track, 6000);
  assert.deepEqual(
    track.segments.map((segment) => segment.text),
    ["雨停了。", "今晚的城市很安静，适合慢慢听一首歌！", "下一首，送给还在路上的你"],
    "split after sentence punctuation; the unpunctuated tail is its own sentence"
  );
  const lengths = track.segments.map((segment) => segment.endMs! - segment.startMs!);
  assert.ok(lengths[0]! < lengths[2]! && lengths[2]! < lengths[1]!, `longer sentences get more time: ${lengths}`);
  assert.equal(track.segments.some((segment) => Array.from(segment.text).length === 1), false, "never per-character");
});

test("nothing is invented without a usable duration or a sentence boundary; native and estimated tracks are kept as they are", () => {
  const source = plain(SCRIPT);
  for (const duration of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(estimateSubtitleTiming(source, duration), source, String(duration));
  const single = plain("下一首，送给还在路上的你");
  assert.equal(estimateSubtitleTiming(single, 6000), single, "one sentence: no boundary to place");
  const tooShort = plain("好。走。");
  assert.equal(estimateSubtitleTiming(tooShort, 700), tooShort, "under two segments' worth of audio");
  const native: SubtitleTrack = { timing: "native-line", segments: [{ startMs: 0, endMs: 900, text: "a." }, { startMs: 900, text: "b." }] };
  assert.equal(estimateSubtitleTiming(native, 6000), native);
  const estimated: SubtitleTrack = { timing: "estimated", segments: [{ startMs: 0, endMs: 10, text: "x。" }] };
  assert.equal(estimateSubtitleTiming(estimated, 6000), estimated);
});

test("Unicode, whitespace, closing quotes, decimals and line breaks split correctly and keep every character", () => {
  const text = "  “你好！”她说。\n\nIt's 3.5 degrees.  Stay warm?  𠮷野家🍜 见 ";
  const track = estimateSubtitleTiming(plain(text), 9000);
  assertWellFormed(track, 9000);
  assert.deepEqual(track.segments.map((segment) => segment.text), ["“你好！”", "她说。", "It's 3.5 degrees.", "Stay warm?", "𠮷野家🍜 见"]);
  const kept = track.segments.map((segment) => segment.text).join("").replace(/\s/gu, "");
  assert.equal(kept, text.replace(/\s/gu, ""), "no character lost or split inside a surrogate pair");
  assert.equal(track.segments.some((segment) => /�/u.test(segment.text)), false);

  const multi: SubtitleTrack = { timing: "plain-text", segments: [{ text: "第一段" }, { text: "第二段。第三句" }] };
  assert.deepEqual(estimateSubtitleTiming(multi, 3000).segments.map((segment) => segment.text), ["第一段", "第二段。", "第三句"]);
});

test("segment count is bounded: many sentences merge into contiguous groups, short audio gets fewer segments, oversize groups fall back", () => {
  const sentences = Array.from({ length: 120 }, (_, index) => `第${index}句。`);
  const many = estimateSubtitleTiming(plain(sentences.join("")), 120_000);
  assertWellFormed(many, 120_000);
  assert.equal(many.segments.length, MAX_ESTIMATED_SEGMENTS);
  assert.equal(many.segments.map((segment) => segment.text).join(""), sentences.join(""), "order and text kept");

  const short = estimateSubtitleTiming(plain("一。二。三。四。五。"), 1000);
  assertWellFormed(short, 1000);
  assert.equal(short.segments.length, 2, "1 s of audio holds at most two segments");

  // Three 1900-character plain segments of short sentences squeezed into two groups would exceed the decoder's 2000-character segment limit.
  const long: SubtitleTrack = { timing: "plain-text", segments: Array.from({ length: 3 }, () => ({ text: "很长的一句话。".repeat(271) })) };
  assert.equal(estimateSubtitleTiming(long, 1000), long, "an invalid projection is never published");
});

/** A → narration into B (spoken), B confirmed playing; returns the voice subtitle seen while it spoke. */
function speakInto(config: Partial<CoreConfig>, cue: CueAsset) {
  const sim = new Sim(config);
  const [a, b] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady(cue);
  sim.naturalEnd(a!);
  sim.voice({ kind: "playing", positionMs: 0 });
  const whileSpeaking = sim.snap;
  sim.voiceNaturalEnd();
  sim.deck(b!, { kind: "playing", positionMs: 0 });
  return { sim, whileSpeaking, b: b! };
}

test("the snapshot projects voice, display and retained narration; the stored asset, effects and receipts are untouched", () => {
  const cue = asset(SCRIPT, 6000, 0.86);
  const original = structuredClone(cue);
  const { sim, whileSpeaking, b } = speakInto({}, cue);
  const voice = whileSpeaking.voice!;
  assertWellFormed(voice.subtitle!, 6000);
  assert.equal(whileSpeaking.display.kind, "voice");
  assert.equal(whileSpeaking.display.kind === "voice" && whileSpeaking.display.subtitle, voice.subtitle, "display and voice show one track");
  assert.equal(voice.scriptText, SCRIPT);

  assert.deepEqual(cue, original, "the asset object was not edited");
  const loaded = sim.lastEffect("voice.load").asset;
  assert.equal(loaded, cue, "the executor loads the stored asset");
  assert.equal(loaded.script.subtitle.timing, "plain-text");
  assert.equal(sim.snap.narration.retained?.subtitle, voice.subtitle, "retained narration shows the same times");
  assert.equal(sim.snap.narration.retained?.spokenMs, 6000 / 0.86, "spoken length still follows the rate");

  // Projection is display only: the same run with it switched off emits the same effects and receipts.
  const off = speakInto({ estimateNarrationTiming: false }, asset(SCRIPT, 6000, 0.86));
  assert.deepEqual(off.whileSpeaking.voice?.subtitle, plain(SCRIPT), "switch off: the server's plain text");
  assert.deepEqual(off.sim.snap.narration.retained?.subtitle, plain(SCRIPT));
  assert.deepEqual(off.sim.log, sim.log);
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId)[1], b);
});

test("segment times are on the rate-1 voice clock: the playback rate never moves a boundary", () => {
  const atOne = speakInto({}, asset(SCRIPT, 6000, 1)).whileSpeaking.voice!.subtitle;
  const slower = speakInto({}, asset(SCRIPT, 6000, 0.86)).whileSpeaking.voice!.subtitle;
  const faster = speakInto({}, asset(SCRIPT, 6000, 1.25)).whileSpeaking.voice!.subtitle;
  assert.deepEqual(slower, atOne);
  assert.deepEqual(faster, atOne);
});

test("unknown voice duration keeps plain text; owner and observer see the same track; a manual replay shows the original times", () => {
  const unknown = speakInto({}, asset(SCRIPT, null)).whileSpeaking;
  assert.deepEqual(unknown.voice?.subtitle, plain(SCRIPT));

  const { sim, whileSpeaking } = speakInto({}, asset(SCRIPT, 6000, 0.86));
  const observed = JSON.parse(JSON.stringify(toSnapshot(sim.state)));
  assert.deepEqual(observed.narration.retained.subtitle, sim.snap.narration.retained?.subtitle, "serialized for an observer: identical");
  assert.equal(toSnapshot(sim.state).narration.retained?.subtitle, sim.snap.narration.retained?.subtitle, "one object across snapshots");

  sim.cmd({ type: "voice.replay" });
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.voice?.origin, "manual");
  assert.deepEqual(sim.snap.voice?.subtitle, whileSpeaking.voice?.subtitle, "the replay uses the same voice times as the original");
  assert.equal(sim.snap.display.kind, "music", "a replay still never takes the display");
});

test("the switch is validated like the rest of the core config", () => {
  assert.throws(() => new Sim({ estimateNarrationTiming: "yes" as unknown as boolean }), /estimateNarrationTiming/);
  assert.equal(new Sim().state.config.estimateNarrationTiming, true, "on by default");
});
