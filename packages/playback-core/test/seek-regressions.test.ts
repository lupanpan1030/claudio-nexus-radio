import assert from "node:assert/strict";
import test from "node:test";
import { Sim } from "./harness.js";

function crossfade() {
  const sim = new Sim({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  const [a, b] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  return { sim, a: a!, b: b! };
}

test("seek exactly onto the anchor skips the window; one ms before keeps it ahead", () => {
  const onAnchor = crossfade();
  onAnchor.sim.cueReady();
  const mark = onAnchor.sim.mark();
  onAnchor.sim.cmd({ type: "seek", positionMs: 192_000 });
  assert.equal(onAnchor.sim.snap.transition?.mode, "direct", "192 000 = anchor: jumped over");
  assert.equal(onAnchor.sim.effects("voice.load", mark).length, 0);
  onAnchor.sim.deck(onAnchor.a, { kind: "seeked", positionMs: 192_000 });
  onAnchor.sim.deck(onAnchor.a, { kind: "time", positionMs: 195_000, rate: 1 });
  assert.equal(onAnchor.sim.snap.transition?.phase, "planned");
  onAnchor.sim.naturalEnd(onAnchor.a);
  assert.equal(onAnchor.sim.snap.program?.item.itemId, onAnchor.b);
  assert.equal(onAnchor.sim.effects("voice.play", mark).length, 0);

  const before = crossfade();
  before.sim.cueReady();
  before.sim.cmd({ type: "seek", positionMs: 191_999 });
  assert.equal(before.sim.snap.transition?.mode, "talk-over-crossfade", "191 999 < anchor: still ahead");
  before.sim.voice({ kind: "can-play", through: true });
  before.sim.deck(before.a, { kind: "seeked", positionMs: 191_999 });
  before.sim.deck(before.a, { kind: "time", positionMs: 191_999, rate: 1 });
  assert.equal(before.sim.snap.transition?.phase, "planned");
  before.sim.deck(before.a, { kind: "time", positionMs: 192_000, rate: 1 });
  assert.equal(before.sim.snap.transition?.phase, "prerolling", "reached by playing");
});

test("after seeking back out of the window, A's old time and ended do not reopen it or end A", () => {
  const { sim, a, b } = crossfade();
  sim.deck(a, { kind: "time", positionMs: 195_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "planned", "no cue yet");
  sim.cmd({ type: "seek", positionMs: 100_000 });
  sim.cueReady();
  const bLoad = sim.loadOf(b);
  const mark = sim.mark();

  const oldTime = sim.deck(a, { kind: "time", positionMs: 195_200, rate: 1 });
  assert.equal(oldTime.notes[0]?.kind, "stale");
  assert.equal(sim.snap.transition?.phase, "planned", "old position does not start a preroll");
  const oldEnd = sim.deck(a, { kind: "ended" });
  assert.equal(oldEnd.notes[0]?.kind, "stale");
  assert.equal(sim.snap.program?.item.itemId, a, "old end does not hand over");
  assert.equal(sim.effects("deck.play", mark).filter((e) => e.loadId === bLoad.loadId).length, 0);
  assert.equal(sim.effects("voice.play", mark).length, 0);
  assert.equal(sim.snap.decks[sim.loadOf(a).deck].clock?.positionMs, 100_000);

  sim.deck(a, { kind: "seeked", positionMs: 100_000 });
  sim.deck(a, { kind: "time", positionMs: 150_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "planned");
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling", "the window ahead is still reached by playing");
});

test("unknown A duration: a seek cannot be judged to pass the end, so reaching the end by playing still talks", () => {
  // Without a duration there is no anchor and no way to call the seek a jump over A's end;
  // A's end is then reached by playing from the seek point, and the sequential talk runs.
  const sim = new Sim({ preferredTalkMode: "talk-over-crossfade" });
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.resolve(a!, { durationMs: null });
  sim.deck(a!, { kind: "can-play", through: true });
  sim.deck(a!, { kind: "playing", positionMs: 0 });
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady();

  sim.cmd({ type: "seek", positionMs: 599_000 });
  assert.equal(sim.snap.transition?.mode, "talk-over-crossfade", "not skipped: no known end");
  sim.voice({ kind: "can-play", through: true });
  sim.deck(a!, { kind: "seeked", positionMs: 599_000 });
  sim.deck(a!, { kind: "time", positionMs: 599_800, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "planned", "no anchor, no preroll");
  const mark = sim.mark();
  sim.naturalEnd(a!, 600_000);
  assert.equal(sim.snap.transition?.phase, "talking");
  assert.equal(sim.snap.transition?.mode, "sequential-talk");
  assert.equal(sim.effects("voice.play", mark).length, 1);
});
