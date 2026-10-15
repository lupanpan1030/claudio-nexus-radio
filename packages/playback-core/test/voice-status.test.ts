import assert from "node:assert/strict";
import test from "node:test";
import { extrapolatePosition } from "@claudio/contracts";
import { cueAsset, Sim } from "./harness.js";
import type { CoreConfig } from "../src/index.js";

function talking(config: Partial<CoreConfig> = {}, asset = cueAsset()) {
  const sim = new Sim(config);
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady(asset);
  return { sim, a: a!, b: b! };
}

test("voice.play issued is only starting: no speaking, no voice subtitles, transport loading", () => {
  const { sim, a } = talking();
  sim.naturalEnd(a);
  assert.equal(sim.effects("voice.play").length, 1);
  assert.equal(sim.snap.voice?.status, "starting");
  assert.equal(sim.snap.transport, "loading");
  assert.equal(sim.snap.display.kind, "music", "subtitles stay on A until the voice really plays");
  assert.equal(sim.snap.voice?.clock, null);

  sim.voice({ kind: "waiting", positionMs: 0 });
  assert.equal(sim.snap.voice?.status, "starting", "buffering before the first playing is not speech");
  assert.equal(sim.snap.transport, "loading");

  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.voice?.status, "speaking");
  assert.equal(sim.snap.transport, "playing");
  assert.equal(sim.snap.display.kind, "voice");
});

test("voice play rejected never becomes speaking; the music continues", () => {
  const { sim, a, b } = talking();
  sim.naturalEnd(a);
  const seen: string[] = [];
  seen.push(sim.snap.display.kind);
  sim.rejectVoice("not-allowed");
  seen.push(sim.snap.display.kind);
  assert.deepEqual(seen, ["music", "music"]);
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.ok(sim.effects("deck.play").some((e) => e.loadId === sim.loadOf(b).loadId));
});

test("pause while voice.play is pending stops it; a late playing is silenced and not counted as speech", () => {
  const { sim, a } = talking();
  sim.naturalEnd(a);
  const voiceLoad = sim.lastEffect("voice.load");

  const mark = sim.mark();
  sim.cmd({ type: "pause" });
  assert.deepEqual(sim.effects("voice.pause", mark).map((e) => e.voiceLoadId), [voiceLoad.voiceLoadId]);
  assert.equal(sim.snap.voice?.status, "paused");

  const late = sim.mark();
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.effects("voice.pause", late).length, 1, "late playing pushed back");
  assert.equal(sim.snap.voice?.status, "paused");
  assert.equal(sim.snap.transport, "paused");
  assert.equal(sim.snap.display.kind, "music");

  const resume = sim.mark();
  sim.cmd({ type: "resume" });
  assert.deepEqual(sim.effects("voice.play", resume).map((e) => e.voiceLoadId), [voiceLoad.voiceLoadId]);
  assert.equal(sim.snap.voice?.status, "starting");
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.voice?.status, "speaking");
});

test("voice clock uses the applied playbackRate from the first playing; pause/resume keeps the remaining position", () => {
  const base = cueAsset("快一点", 4000);
  const { sim, a } = talking({}, { ...base, voice: { ...base.voice, playbackRate: 1.25 } });
  sim.naturalEnd(a);
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.voice?.clock?.rate, 1.25, "no hard-coded 1 waiting for timeupdate");

  sim.tick(1000);
  sim.cmd({ type: "pause" });
  const held = sim.snap.voice!.clock!;
  assert.equal(held.rate, 0);
  assert.equal(held.positionMs, 1250);
  sim.voice({ kind: "paused", positionMs: 1260, atEnd: false, requested: true });
  sim.tick(5000);
  sim.voice({ kind: "time", positionMs: 1260, rate: 1.25 });
  assert.equal(extrapolatePosition(sim.snap.voice!.clock!, sim.now), 1260, "a late timeupdate does not restart the clock");
  assert.equal(sim.snap.voice?.status, "paused");

  const resume = sim.mark();
  sim.cmd({ type: "resume" });
  assert.equal(sim.effects("voice.load", resume).length, 0, "same load continues; nothing restarts from zero");
  assert.equal(extrapolatePosition(sim.snap.voice!.clock!, sim.now + 1000), 1260, "still frozen until playing is confirmed");
  sim.voice({ kind: "playing", positionMs: 1260 });
  assert.deepEqual(sim.snap.voice?.clock, { positionMs: 1260, observedAt: sim.now, rate: 1.25 });
});

test("voice waiting after it spoke shows waiting and freezes the subtitle clock", () => {
  const { sim, a } = talking();
  sim.naturalEnd(a);
  sim.voice({ kind: "playing", positionMs: 0 });
  sim.tick(800);
  sim.voice({ kind: "waiting", positionMs: 800 });
  assert.equal(sim.snap.voice?.status, "waiting");
  assert.equal(sim.snap.transport, "waiting");
  assert.equal(sim.snap.display.kind, "voice");
  assert.equal(sim.snap.voice?.clock?.rate, 0);
  sim.voice({ kind: "playing", positionMs: 800 });
  assert.equal(sim.snap.voice?.status, "speaking");
  assert.equal(sim.snap.transport, "playing");
});

test("crossfade commit asks for the voice; subtitles switch to it only on its playing", () => {
  const sim = new Sim({ preferredTalkMode: "talk-over-crossfade" });
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady();
  sim.deck(a!, { kind: "time", positionMs: 193_000, rate: 1 });
  sim.deck(b!, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transition?.phase, "overlapping");
  assert.equal(sim.snap.voice?.status, "starting");
  assert.equal(sim.snap.display.kind, "music");
  assert.equal(sim.snap.display.kind === "music" && sim.snap.display.itemId, b);
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.display.kind, "voice");
});
