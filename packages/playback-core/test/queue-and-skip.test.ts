import assert from "node:assert/strict";
import test from "node:test";
import { media, Sim, track } from "./harness.js";

function playingA() {
  const sim = new Sim({}, { djEnabled: false });
  const [a, b, c] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  return { sim, a: a!, b: b!, c: c! };
}

test("fast skip A→B→C: late results for B are rejected and only A and C start", () => {
  const { sim, a, b, c } = playingA();
  const aLoad = sim.loadOf(a);

  sim.cmd({ type: "next" }); // to B (standby preparation still in flight)
  assert.equal(sim.snap.program?.item.itemId, b);
  const bPrepare = sim.lastEffect("prepare.start", (e) => e.itemId === b);

  const mark = sim.mark();
  sim.cmd({ type: "next" }); // to C before B resolved
  assert.equal(sim.snap.program?.item.itemId, c);
  assert.ok(sim.effects("operation.cancel", mark).some((e) => e.opId === bPrepare.opId), "B preparation aborted");

  const before = sim.state;
  const late = sim.fact({ type: "prepare.resolved", opId: bPrepare.opId, itemId: b, media: media(track("b")) });
  assert.equal(late.state, before, "stale result leaves state untouched");
  assert.equal(late.effects.length, 0);
  assert.equal(late.notes[0]?.kind, "stale");

  const lateA = sim.fact({ type: "deck.media", deck: aLoad.deck, loadId: aLoad.loadId, event: { kind: "ended" } });
  assert.equal(lateA.notes[0]?.kind, "stale", "old deck event rejected");

  sim.startProgram(c);
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, c]);
  assert.deepEqual(
    sim.snap.history.map((h) => [h.item.itemId, h.outcome, h.started]),
    [
      [a, "skipped", true],
      [b, "skipped", false]
    ]
  );
  assert.equal(sim.snap.transport, "playing");
});

test("the same track queued twice is two items with two receipts", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [first, second] = sim.enqueue("same", "same");
  assert.notEqual(first, second);
  assert.deepEqual(sim.snap.queue[0]?.item.track, sim.snap.queue[1]?.item.track);

  sim.cmd({ type: "resume" });
  sim.startProgram(first!);
  assert.equal(sim.snap.queue.length, 1, "only the started appearance is consumed");
  assert.equal(sim.snap.queue[0]?.item.itemId, second);

  sim.resolve(second!);
  sim.deck(first!, { kind: "ended" });
  sim.deck(second!, { kind: "playing", positionMs: 0 });
  const keys = sim.receipts().map((e) => e.receipt.idempotencyKey);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test("queue entry is reserved while loading and consumed only on confirmed playing", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  assert.equal(sim.snap.queue[0]?.reservation, "program");
  assert.equal(sim.snap.transport, "requested");

  sim.resolve(a!);
  assert.equal(sim.snap.transport, "loading");
  assert.equal(sim.snap.queue[0]?.item.itemId, a, "still queued while loading");
  assert.equal(sim.receipts().length, 0, "loading is not playing");

  sim.deck(a!, { kind: "playing", positionMs: 0 });
  assert.notEqual(sim.snap.queue[0]?.item.itemId, a);
  assert.equal(sim.snap.queue[0]?.reservation, "standby", "next item reserved for preheat");
});

test("a repeated ended event advances only once", () => {
  const { sim, a, b } = playingA();
  sim.resolve(b);
  sim.deck(a, { kind: "ended" });
  assert.equal(sim.snap.program?.item.itemId, b);
  const loadsBefore = sim.effects("deck.load").length;
  const historyBefore = sim.snap.history.length;

  const again = sim.fact({ type: "deck.media", ...sim.loadOf(a), event: { kind: "ended" } });
  assert.ok(again.notes.some((n) => n.kind === "stale" || n.kind === "duplicate"));
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.equal(sim.effects("deck.load").length, loadsBefore);
  assert.equal(sim.snap.history.length, historyBefore);
});

test("preparing the next item never counts as a play, and a failed preheat keeps the item", () => {
  const { sim, b } = playingA();
  const request = sim.lastEffect("prepare.start", (e) => e.itemId === b);
  assert.equal(request.purpose, "standby");
  sim.fact({ type: "prepare.settled", opId: request.opId, itemId: b, outcome: "failed", error: { class: "unavailable", code: "gone" } });
  const entry = sim.snap.queue.find((e) => e.item.itemId === b);
  assert.ok(entry, "item not removed by a failed preparation");
  assert.equal(entry.lastError?.code, "gone");
  assert.equal(sim.receipts().length, 1);
});

test("enqueue next inserts after the program and re-plans the standby", () => {
  const { sim, b } = playingA();
  const bPrepare = sim.lastEffect("prepare.start", (e) => e.itemId === b);
  const mark = sim.mark();
  sim.cmd({ type: "enqueue", position: "next", entries: [{ track: track("x"), display: null, origin: "chat" }] });
  const x = sim.snap.queue[0]!.item.itemId;
  assert.equal(sim.snap.transition?.toItemId, x);
  assert.ok(sim.effects("operation.cancel", mark).some((e) => e.opId === bPrepare.opId), "old standby preparation released");
  assert.equal(sim.snap.queue.find((e) => e.item.itemId === b)?.reservation, "none");
});

test("select plays a new track now and keeps the rest of the queue", () => {
  const { sim, a, b, c } = playingA();
  sim.cmd({ type: "select", target: { kind: "track", entry: { track: track("z"), display: null, origin: "user" } } });
  const z = sim.snap.program!.item.itemId;
  assert.notEqual(z, a);
  assert.deepEqual(sim.snap.queue.map((e) => e.item.itemId).slice(1), [b, c]);
  sim.startProgram(z);
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, z]);
});
