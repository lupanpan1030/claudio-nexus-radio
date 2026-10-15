import assert from "node:assert/strict";
import test from "node:test";
import { Sim, track } from "./harness.js";

function playingLast(djEnabled = false) {
  const sim = new Sim({}, { djEnabled });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  return { sim, a: a! };
}

/** Read fresh: assertions on an earlier snapshot must not narrow later reads. */
function programId(sim: Sim) {
  return sim.snap.program?.item.itemId;
}

function refill(sim: Sim, name: string, position: "next" | "end" = "end") {
  sim.cmd({ type: "enqueue", position, entries: [{ track: track(name), display: null, origin: "radio" }] });
}

test("the queue running out is not a stop: transport is exhausted and a refill starts by itself", () => {
  for (const djEnabled of [false, true]) {
    const { sim, a } = playingLast(djEnabled);
    assert.equal(sim.snap.transition, null, "nothing to hand over to");
    sim.naturalEnd(a);
    assert.equal(sim.snap.program, null);
    assert.equal(sim.snap.transport, "exhausted", "played out and waiting, not loading");
    assert.equal(sim.snap.history.at(-1)?.outcome, "played");
    assert.deepEqual(sim.snap.decks.A.role, "idle");

    const mark = sim.mark();
    refill(sim, "x");
    const x = programId(sim);
    assert.ok(x, "the refilled head became program");
    assert.equal(sim.lastEffect("prepare.start", (e) => e.itemId === x).purpose, "program");
    assert.equal(sim.snap.transport, "requested");
    sim.resolve(x);
    assert.ok(sim.effects("deck.play", mark).some((e) => e.loadId === sim.loadOf(x).loadId));
    sim.deck(x, { kind: "playing", positionMs: 0 });
    assert.equal(sim.snap.transport, "playing");
    assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, x]);
  }
});

test("skipping the last item also leaves playback wanted; the refill starts", () => {
  const { sim, a } = playingLast();
  sim.cmd({ type: "next" });
  assert.equal(sim.snap.transport, "exhausted");
  assert.equal(sim.snap.history.at(-1)?.outcome, "skipped");
  refill(sim, "x");
  assert.ok(sim.snap.program);
  assert.notEqual(sim.snap.program.item.itemId, a);
});

test("after an explicit pause or stop a late refill only waits in the queue", () => {
  const paused = playingLast();
  paused.sim.naturalEnd(paused.a);
  paused.sim.cmd({ type: "pause" });
  assert.equal(paused.sim.snap.transport, "idle");
  const pauseMark = paused.sim.mark();
  refill(paused.sim, "x");
  assert.equal(paused.sim.snap.program, null);
  assert.equal(paused.sim.effects("prepare.start", pauseMark).length, 0, "nothing prepared to play");
  assert.equal(paused.sim.snap.queue.length, 1);
  paused.sim.cmd({ type: "resume" });
  assert.equal(programId(paused.sim), paused.sim.snap.queue[0]?.item.itemId, "an explicit resume plays it");

  const stopped = playingLast();
  stopped.sim.cmd({ type: "stop" });
  const stopMark = stopped.sim.mark();
  refill(stopped.sim, "x");
  assert.equal(stopped.sim.snap.program, null);
  assert.equal(stopped.sim.snap.transport, "idle");
  assert.equal(stopped.sim.effects("prepare.start", stopMark).length, 0);
});

test("a refill while the last item is paused mid-track does not make anything sound", () => {
  const { sim, a } = playingLast();
  sim.cmd({ type: "pause" });
  sim.deck(a, { kind: "paused", positionMs: 50_000, atEnd: false, requested: true });
  const mark = sim.mark();
  refill(sim, "x");
  assert.equal(sim.snap.program?.item.itemId, a);
  assert.equal(sim.effects("deck.play", mark).length, 0);
  assert.equal(sim.snap.transport, "paused");
});

test("refills that keep failing stop at the consecutive-failure bound instead of looping", () => {
  const sim = new Sim({ maxConsecutiveFailures: 3 }, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  const fail = (itemId: string) => {
    const request = sim.lastEffect("prepare.start", (e) => e.itemId === itemId);
    sim.fact({ type: "prepare.settled", opId: request.opId, itemId: request.itemId, outcome: "failed", error: { class: "unavailable", code: "gone" } });
  };
  fail(a!);
  assert.equal(sim.snap.transport, "exhausted", "one failure with nothing queued waits for a refill");

  refill(sim, "x");
  fail(sim.snap.program!.item.itemId);
  assert.equal(sim.snap.transport, "exhausted");
  refill(sim, "y");
  fail(sim.snap.program!.item.itemId);
  assert.equal(sim.snap.transport, "failed", "bound reached: stopped");
  assert.equal(sim.state.intent, "stop");

  const mark = sim.mark();
  refill(sim, "z");
  assert.equal(sim.snap.program, null, "no automatic retry after the bound");
  assert.equal(sim.effects("prepare.start", mark).length, 0);
  assert.equal(sim.snap.history.filter((h) => h.outcome === "failed").length, 3);
  assert.equal(sim.receipts().length, 0);
});
