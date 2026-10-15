import assert from "node:assert/strict";
import test from "node:test";
import type { TransportStatus } from "@claudio/contracts";
import { Sim } from "./harness.js";

function crossfade() {
  const sim = new Sim({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  const [a, b, c] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady();
  return { sim, a: a!, b: b!, c: c! };
}

/** Records the transport after every step so a transient wrong pause cannot hide. */
function watch(sim: Sim): { seen: TransportStatus[]; run: (fn: () => void) => void } {
  const seen: TransportStatus[] = [];
  return {
    seen,
    run(fn) {
      fn();
      seen.push(sim.snap.transport);
    }
  };
}

test("preroll B asked to play → seek holds it → A ends → B promoted and played → B's old acks arrive: no global pause, one receipt", () => {
  const { sim, a, b } = crossfade();
  sim.deck(a, { kind: "time", positionMs: 194_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  const bLoad = sim.loadOf(b);

  const mark = sim.mark();
  sim.cmd({ type: "seek", positionMs: 199_900 });
  assert.ok(sim.effects("deck.pause", mark).some((e) => e.loadId === bLoad.loadId), "hold B");
  assert.equal(sim.snap.transition?.mode, "direct", "window was jumped over");
  sim.deck(a, { kind: "seeked", positionMs: 199_900 });
  sim.naturalEnd(a);
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.equal(sim.effects("deck.play", mark).filter((e) => e.loadId === bLoad.loadId).length, 1, "played again after the hold");

  // What B's element reports for the play → pause/seek → play it executed.
  const t = watch(sim);
  t.run(() => sim.deck(b, { kind: "playing", positionMs: 90 }));
  t.run(() => sim.deck(b, { kind: "paused", positionMs: 95, atEnd: false, requested: true }));
  t.run(() => sim.deck(b, { kind: "seeked", positionMs: 0 }));
  t.run(() => sim.deck(b, { kind: "playing", positionMs: 0 }));
  assert.ok(!t.seen.includes("paused"), `never a transport pause: ${t.seen.join(",")}`);
  assert.equal(sim.state.intent, "play");
  assert.equal(sim.snap.transport, "playing");
  const receipts = sim.receipts();
  assert.deepEqual(receipts.map((e) => e.receipt.itemId), [a, b], "exactly one B receipt");
  assert.equal(receipts[1]!.receipt.positionMs, 0, "not the pre-seek position");
  assert.equal(sim.effects("voice.play", mark).length, 0);
});

test("seek during a preroll: B's late playing/paused/seeked and then A's end", () => {
  const { sim, a, b } = crossfade();
  sim.deck(a, { kind: "time", positionMs: 194_000, rate: 1 });
  const bLoad = sim.loadOf(b);
  const mark = sim.mark();
  sim.cmd({ type: "seek", positionMs: 196_000 });

  const t = watch(sim);
  t.run(() => sim.deck(b, { kind: "playing", positionMs: 80 }));
  assert.equal(sim.snap.transition?.phase, "planned", "a held B playing is not a commit");
  assert.equal(sim.snap.program?.item.itemId, a);
  t.run(() => sim.deck(b, { kind: "paused", positionMs: 90, atEnd: false, requested: true }));
  t.run(() => sim.deck(b, { kind: "seeked", positionMs: 0 }));
  t.run(() => sim.deck(a, { kind: "seeked", positionMs: 196_000 }));
  t.run(() => sim.deck(a, { kind: "time", positionMs: 199_000, rate: 1 }));
  t.run(() => sim.naturalEnd(a));
  assert.equal(sim.snap.program?.item.itemId, b);
  t.run(() => sim.deck(b, { kind: "playing", positionMs: 0 }));

  assert.ok(!t.seen.includes("paused"), t.seen.join(","));
  assert.equal(sim.effects("voice.play", mark).length, 0, "skipped window is not caught up");
  const receipts = sim.receipts();
  assert.deepEqual(receipts.map((e) => e.receipt.itemId), [a, b]);
  assert.equal(receipts[1]!.receipt.loadId, bLoad.loadId);
  assert.equal(receipts[1]!.receipt.positionMs, 0);
});

test("pause then resume before the element answered: the late own paused does not pause the transport again", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.cmd({ type: "pause" });
  sim.cmd({ type: "resume" });
  const mark = sim.mark();
  sim.deck(a!, { kind: "paused", positionMs: 5000, atEnd: false, requested: true });
  assert.equal(sim.state.intent, "play");
  assert.equal(sim.effects("deck.pause", mark).length, 0);
  sim.deck(a!, { kind: "playing", positionMs: 5000 });
  assert.equal(sim.snap.transport, "playing");
  assert.equal(sim.receipts().length, 1);

  // The same event without `requested` is an interruption.
  sim.deck(a!, { kind: "paused", positionMs: 6000, atEnd: false, requested: false });
  assert.equal(sim.snap.transport, "paused");
});

test("a playing reported between the core's pause and its paused is from before the pause", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.deck(a!, { kind: "waiting", positionMs: 3000 });
  sim.cmd({ type: "pause" });
  sim.cmd({ type: "resume" });
  const early = sim.deck(a!, { kind: "playing", positionMs: 3000 });
  assert.equal(early.notes[0]?.kind, "stale");
  assert.equal(sim.snap.decks[sim.loadOf(a!).deck].status, "waiting");
  sim.deck(a!, { kind: "paused", positionMs: 3000, atEnd: false, requested: true });
  sim.deck(a!, { kind: "playing", positionMs: 3000 });
  assert.equal(sim.snap.transport, "playing");
});

test("pause then resume while the DJ talks: the voice's late own paused is not an interruption", () => {
  const sim = new Sim();
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.cueReady();
  sim.naturalEnd(a!);
  sim.voice({ kind: "playing", positionMs: 0 });
  sim.cmd({ type: "pause" });
  sim.cmd({ type: "resume" });
  sim.voice({ kind: "paused", positionMs: 700, atEnd: false, requested: true });
  assert.equal(sim.state.intent, "play");
  assert.equal(sim.snap.voice?.status, "starting");
  sim.voice({ kind: "playing", positionMs: 700 });
  assert.equal(sim.snap.transport, "playing");
});

test("a voice play rejection that answers a play already paused is ignored; resume still speaks", () => {
  const sim = new Sim();
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.cueReady();
  sim.naturalEnd(a!);
  sim.cmd({ type: "pause" });
  const late = sim.voice({ kind: "play-rejected", reason: "aborted" });
  assert.equal(late.notes[0]?.kind, "stale");
  assert.equal(sim.snap.transition?.phase, "talking", "not treated as a failed voice");
  sim.cmd({ type: "resume" });
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.voice?.status, "speaking");
  assert.equal(sim.snap.program?.item.itemId, a);
});

test("an interruption before the program ever played pauses the transport instead of a silent fake loading", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.resolve(a!);
  assert.equal(sim.snap.transport, "loading");
  sim.deck(a!, { kind: "paused", positionMs: 0, atEnd: false, requested: false });
  assert.equal(sim.snap.transport, "paused");
  const mark = sim.mark();
  sim.cmd({ type: "resume" });
  assert.deepEqual(sim.effects("deck.play", mark).map((e) => e.loadId), [sim.loadOf(a!).loadId]);
});

test("a controlled preroll that confirms playing commits and records exactly once", () => {
  const { sim, a, b } = crossfade();
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transition?.phase, "overlapping");
  sim.deck(b, { kind: "time", positionMs: 400, rate: 1 });
  sim.deck(b, { kind: "playing", positionMs: 500 });
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
  assert.equal(sim.effects("deck.pause").filter((e) => e.loadId === sim.loadOf(b).loadId).length, 0);
});
