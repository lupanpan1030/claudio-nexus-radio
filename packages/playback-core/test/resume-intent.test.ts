import assert from "node:assert/strict";
import test from "node:test";
import { resumableQueueItems, type CoreConfig } from "../src/index.js";
import { Sim, track } from "./harness.js";

function setup(config: Partial<CoreConfig> = {}) {
  const sim = new Sim(config);
  const [a, b, c] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  return { sim, a: a!, b: b!, c: c! };
}

const resumable = (sim: Sim) => resumableQueueItems(sim.state).map((item) => item.itemId);

test("A played to its end while the DJ talks before B: A is heard, B leads — starting, speaking and paused alike", () => {
  const { sim, a, b, c } = setup();
  sim.cueReady();
  assert.deepEqual(resumable(sim), [a, b, c]);

  sim.naturalEnd(a);
  assert.equal(sim.snap.transition?.phase, "talking");
  assert.equal(sim.snap.program?.item.itemId, a, "A stays program until the talk is over");
  assert.equal(sim.snap.voice?.status, "starting");
  assert.deepEqual(resumable(sim), [b, c]);

  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.voice?.status, "speaking");
  assert.deepEqual(resumable(sim), [b, c]);

  // During a sequential talk voice.pause is a transport pause, the same transport as an ordinary pause of A.
  sim.cmd({ type: "voice.pause" });
  sim.voice({ kind: "paused", positionMs: 1200, atEnd: false, requested: true });
  assert.equal(sim.snap.transport, "paused");
  assert.equal(sim.snap.voice?.status, "paused");
  assert.deepEqual(resumable(sim), [b, c]);
});

test("the selector only reads: program, history, receipts and the running cue are left as they are", () => {
  const { sim, a } = setup();
  sim.cueReady();
  sim.naturalEnd(a);
  sim.voice({ kind: "playing", positionMs: 0 });
  const before = structuredClone(sim.state);
  resumableQueueItems(sim.state);
  assert.deepEqual(sim.state, before);
  assert.equal(sim.state.program?.item.itemId, a);
  assert.equal(sim.state.program?.started, true);
  assert.equal(sim.state.history.length, 0, "A is retired only when the talk completes");
  assert.equal(sim.state.cue?.status, "speaking");
});

test("an ordinary pause of A in the middle keeps A first", () => {
  const { sim, a, b, c } = setup();
  sim.cueReady();
  sim.cmd({ type: "pause" });
  sim.deck(a, { kind: "paused", positionMs: 90_000, atEnd: false, requested: true });
  assert.equal(sim.snap.transport, "paused");
  assert.deepEqual(resumable(sim), [a, b, c]);
});

test("a program that is not loaded yet, or still playing, stays first", () => {
  const sim = new Sim();
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  assert.equal(sim.state.program?.deck, null);
  assert.deepEqual(resumable(sim), [a, b]);
  sim.startProgram(a!);
  assert.deepEqual(resumable(sim), [a, b]);
});

test("a manual replay of B's narration keeps B first, speaking or paused", () => {
  const { sim, a, b, c } = setup();
  sim.cueReady();
  sim.naturalEnd(a);
  sim.voice({ kind: "playing", positionMs: 0 });
  sim.voiceNaturalEnd();
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.deepEqual(resumable(sim), [b, c]);

  sim.cmd({ type: "voice.replay" });
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.voice?.origin, "manual");
  assert.equal(sim.snap.voice?.status, "speaking");
  assert.deepEqual(resumable(sim), [b, c]);

  sim.cmd({ type: "voice.pause" });
  assert.equal(sim.snap.voice?.status, "paused");
  assert.deepEqual(resumable(sim), [b, c]);
});

test("crossfade: while B prerolls A still leads; once they overlap B does", () => {
  const { sim, a, b, c } = setup({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  assert.deepEqual(resumable(sim), [a, b, c]);

  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transition?.phase, "overlapping");
  assert.deepEqual(resumable(sim), [b, c]);
});

test("A ending during a preroll hands over to the talk: B leads", () => {
  const { sim, a, b, c } = setup({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  sim.naturalEnd(a);
  assert.equal(sim.snap.transition?.phase, "talking");
  assert.deepEqual(resumable(sim), [b, c]);
});

test("a played-out queue resumes nothing", () => {
  const sim = new Sim();
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.naturalEnd(a!);
  assert.equal(sim.snap.transport, "exhausted");
  assert.deepEqual(resumable(sim), []);
});

test("only the ended program's own occurrence is dropped: a later occurrence of the same track stays, in order", () => {
  const sim = new Sim();
  const [a, b, again] = sim.enqueue("a", "b", "a");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady();
  sim.naturalEnd(a!);
  assert.equal(sim.snap.transition?.phase, "talking");
  const items = resumableQueueItems(sim.state);
  assert.deepEqual(items.map((item) => item.itemId), [b, again]);
  assert.deepEqual(items.at(-1)?.track, track("a"));
});
