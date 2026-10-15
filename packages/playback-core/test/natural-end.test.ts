import assert from "node:assert/strict";
import test from "node:test";
import { Sim } from "./harness.js";

function setup(djEnabled: boolean) {
  const sim = new Sim({}, { djEnabled });
  const [a, b, c] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  return { sim, a: a!, b: b!, c: c! };
}

test("DJ off: natural pause(atEnd)→ended keeps playing intent and starts B", () => {
  const { sim, a, b } = setup(false);
  sim.deck(a, { kind: "time", positionMs: 199_500, rate: 1 });
  const mark = sim.mark();
  sim.deck(a, { kind: "paused", positionMs: 200_000, atEnd: true, requested: false });
  assert.equal(sim.snap.transport, "playing", "the end arriving is not a transport pause");
  assert.equal(sim.effects("deck.pause", mark).length, 0);

  sim.deck(a, { kind: "ended" });
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.ok(sim.effects("deck.play", mark).some((e) => e.loadId === sim.loadOf(b).loadId), "B is told to play");
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transport, "playing");
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
  assert.equal(sim.snap.history.at(-1)?.outcome, "played");
});

test("DJ on: natural end of A → voice → natural end of voice → B, no manual resume needed", () => {
  const { sim, a, b } = setup(true);
  sim.cueReady();
  const voiceLoad = sim.lastEffect("voice.load");
  const mark = sim.mark();
  sim.naturalEnd(a);
  assert.equal(sim.snap.transition?.phase, "talking");
  assert.deepEqual(sim.effects("voice.play", mark).map((e) => e.voiceLoadId), [voiceLoad.voiceLoadId]);
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transport, "playing");

  sim.voice({ kind: "paused", positionMs: 4000, atEnd: true, requested: false });
  assert.equal(sim.snap.transport, "playing", "voice reaching its end is not a pause");
  assert.equal(sim.effects("voice.pause", mark).length, 0);
  sim.voice({ kind: "ended" });
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.ok(sim.effects("deck.play", mark).some((e) => e.loadId === sim.loadOf(b).loadId));
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
});

test("an OS interruption close to the end is still a pause: no guessing from position", () => {
  const { sim, a, b } = setup(false);
  sim.deck(a, { kind: "time", positionMs: 199_900, rate: 1 });
  const mark = sim.mark();
  sim.deck(a, { kind: "paused", positionMs: 199_950, atEnd: false, requested: false });
  assert.equal(sim.snap.transport, "paused");
  assert.equal(sim.snap.program?.item.itemId, a);
  assert.equal(sim.effects("deck.play", mark).length, 0, "B does not start under an interruption");

  const resumeMark = sim.mark();
  sim.cmd({ type: "resume" });
  assert.deepEqual(sim.effects("deck.play", resumeMark).map((e) => e.loadId), [sim.loadOf(a).loadId]);
  sim.deck(a, { kind: "playing", positionMs: 199_950 });
  sim.naturalEnd(a);
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.equal(sim.snap.transport, "loading", "B asked to play, not yet confirmed");
});

test("user pause near the end, then the paused fact, stays paused", () => {
  const { sim, a } = setup(true);
  sim.cueReady();
  sim.cmd({ type: "pause" });
  sim.deck(a, { kind: "paused", positionMs: 199_000, atEnd: false, requested: true });
  assert.equal(sim.snap.transport, "paused");
  assert.equal(sim.effects("voice.play").length, 0);
  assert.equal(sim.snap.transition?.phase, "planned");
});

test("an OS interruption of the voice pauses the transport; resume continues the same voice load", () => {
  const { sim, a, b } = setup(true);
  sim.cueReady();
  sim.naturalEnd(a);
  sim.voice({ kind: "playing", positionMs: 0 });
  const voiceLoad = sim.lastEffect("voice.load");

  const mark = sim.mark();
  sim.voice({ kind: "paused", positionMs: 1500, atEnd: false, requested: false });
  assert.equal(sim.snap.transport, "paused");
  assert.equal(sim.snap.voice?.status, "paused");
  assert.equal(sim.snap.program?.item.itemId, a, "B does not start while the voice is interrupted");
  assert.equal(sim.effects("deck.play", mark).length, 0);

  const resumeMark = sim.mark();
  sim.cmd({ type: "resume" });
  assert.deepEqual(sim.effects("voice.play", resumeMark).map((e) => e.voiceLoadId), [voiceLoad.voiceLoadId]);
  assert.equal(sim.effects("voice.load", resumeMark).length, 0);
  assert.equal(sim.effects("deck.play", resumeMark).length, 0, "ended A is not restarted");
  sim.voice({ kind: "playing", positionMs: 1500 });
  sim.voiceNaturalEnd();
  assert.equal(sim.snap.program?.item.itemId, b);
});

test("repeated ended / paused after a natural end are duplicates without effects", () => {
  const { sim, a, b } = setup(false);
  sim.naturalEnd(a);
  assert.equal(sim.snap.program?.item.itemId, b);
  const again = sim.fact({ type: "deck.media", ...sim.loadOf(a), event: { kind: "ended" } });
  assert.equal(again.notes[0]?.kind, "stale", "A's load was released by the hand-over");

  const dj = setup(true);
  dj.sim.cueReady();
  dj.sim.naturalEnd(dj.a);
  const mark = dj.sim.mark();
  const ended = dj.sim.deck(dj.a, { kind: "ended" });
  const paused = dj.sim.deck(dj.a, { kind: "paused", positionMs: 200_000, atEnd: true, requested: false });
  assert.equal(ended.notes[0]?.kind, "duplicate");
  assert.equal(paused.notes[0]?.kind, "duplicate");
  assert.equal(dj.sim.since(mark).length, 0);
  assert.equal(dj.sim.snap.transition?.phase, "talking");
});

test("a stray playing on an ended A while the DJ talks is silenced and does not revive A", () => {
  const { sim, a, b } = setup(true);
  sim.cueReady();
  sim.naturalEnd(a);
  sim.voice({ kind: "playing", positionMs: 0 });
  const aLoad = sim.loadOf(a);

  const mark = sim.mark();
  const stray = sim.deck(a, { kind: "playing", positionMs: 0 });
  assert.equal(stray.notes[0]?.kind, "duplicate");
  assert.deepEqual(sim.effects("deck.pause", mark).map((e) => e.loadId), [aLoad.loadId]);
  assert.equal(sim.snap.decks[aLoad.deck].status, "ended");
  assert.equal(sim.snap.display.kind, "voice");
  assert.equal(sim.receipts().length, 1);

  sim.voiceNaturalEnd();
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.equal(sim.snap.history.at(-1)?.outcome, "played", "A still counts as finished");
});

test("A ending during a preroll talks at once; a stray playing on the ended A is silenced", () => {
  const { sim, a, b } = (() => {
    const s = new Sim({ preferredTalkMode: "talk-over-crossfade" });
    const [a, b] = s.enqueue("a", "b");
    s.cmd({ type: "resume" });
    s.startProgram(a!);
    s.resolve(b!);
    s.deck(b!, { kind: "can-play", through: true });
    return { sim: s, a: a!, b: b! };
  })();
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 195_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  sim.naturalEnd(a);
  assert.equal(sim.snap.transition?.phase, "talking");
  const mark = sim.mark();
  sim.deck(a, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.effects("deck.pause", mark).map((e) => e.loadId), [sim.loadOf(a).loadId]);
  assert.equal(sim.snap.transition?.phase, "talking");
  sim.voice({ kind: "playing", positionMs: 0 });
  sim.voiceNaturalEnd();
  // B was held when A ended; its pause is acknowledged before the promoted play can count.
  sim.deck(b, { kind: "paused", positionMs: 0, atEnd: false, requested: true });
  sim.deck(b, { kind: "seeked", positionMs: 0 });
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
});

test("seek after a natural end replays A for real; the spoken hand-over is not repeated", () => {
  const { sim, a, b } = setup(true);
  sim.cueReady();
  sim.naturalEnd(a);
  sim.voice({ kind: "playing", positionMs: 0 });
  const aLoad = sim.loadOf(a);

  const mark = sim.mark();
  sim.cmd({ type: "seek", positionMs: 10_000 });
  assert.ok(sim.effects("deck.play", mark).some((e) => e.loadId === aLoad.loadId));
  sim.deck(a, { kind: "seeked", positionMs: 10_000 });
  sim.deck(a, { kind: "playing", positionMs: 10_000 });
  assert.equal(sim.snap.decks[aLoad.deck].status, "playing", "seek is the intent that may revive an ended deck");
  assert.equal(sim.snap.transport, "playing");
  assert.equal(sim.receipts().length, 1, "same item, same load: no second receipt");

  sim.naturalEnd(a);
  assert.equal(sim.snap.program?.item.itemId, b, "direct: this pair already spoke");
  assert.equal(sim.effects("voice.play", mark).length, 0);
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
});
