import assert from "node:assert/strict";
import test from "node:test";
import { asId, type QueueEntryRequest, type QueueItemId } from "@claudio/contracts";
import { createInitialState, createSequentialIds, isReservableIdFactory, step, withReservations, type IdFactory } from "../src/index.js";
import { Sim, track } from "./harness.js";

function entry(name: string, itemId?: QueueItemId): QueueEntryRequest {
  return { track: track(name), display: { title: name, artist: "fixture" }, origin: "radio", ...(itemId ? { itemId } : {}) };
}

function reserve(sim: Sim): QueueItemId {
  return asId<QueueItemId>(sim.ids.reserve("item"));
}

test("factory: a reservation is claimable exactly once, next() ids never, and the in-flight set is bounded", () => {
  const ids = createSequentialIds("t", { maxReserved: 2 });
  assert.ok(isReservableIdFactory(ids));
  const plain = ids.next("item");
  assert.equal(ids.isReserved(plain), false);
  assert.equal(ids.claim(plain), false, "an ordinary id is not claimable");

  const r1 = ids.reserve("item");
  const r2 = ids.reserve("item");
  assert.notEqual(r1, r2);
  assert.notEqual(r1, plain);
  assert.equal(ids.reservedCount, 2);
  assert.throws(() => ids.reserve("item"), RangeError, "a leak surfaces instead of growing forever");
  assert.equal(ids.claim(r1), true);
  assert.equal(ids.claim(r1), false, "claimed once");
  assert.equal(ids.release(r1), false, "claimed ids cannot be released back");
  assert.equal(ids.release(r2), true);
  assert.equal(ids.isReserved(r2), false);
  assert.equal(ids.claim(r2), false, "released ids cannot be claimed");
  assert.equal(ids.reservedCount, 0);
  assert.doesNotThrow(() => ids.reserve("item"));

  const wrapped = withReservations({ next: (kind) => `uuid-${kind}-${Math.random()}` });
  const id = wrapped.reserve("item");
  assert.ok(id.startsWith("uuid-item-"));
  assert.equal(wrapped.claim(id), true);
  assert.throws(() => withReservations({ next: () => "x" }, { maxReserved: 0 }), RangeError);
});

test("a reserved candidate id becomes the queue item id and is consumed; reusing it is a no-op", () => {
  const sim = new Sim();
  const candidate = reserve(sim);
  sim.cmd({ type: "enqueue", position: "end", entries: [entry("r", candidate)] });
  assert.equal(sim.itemIdAt(0), candidate);
  assert.equal(sim.ids.isReserved(candidate), false);
  assert.equal(sim.ids.reservedCount, 0);
  sim.cmd({ type: "resume" });
  assert.equal(sim.lastEffect("prepare.start").itemId, candidate, "the core prepares under the id the server already knows");

  const before = sim.snap.queue;
  const again = sim.cmd({ type: "enqueue", position: "end", entries: [entry("r2", candidate)] });
  assert.ok(again.notes.some((n) => n.kind === "ignored" && n.reason.includes("already used")));
  assert.deepEqual(again.effects, []);
  assert.deepEqual(sim.snap.queue, before);
});

test("the whole batch is checked first: one bad entry leaves the queue, the reservations and the id counter untouched", () => {
  const sim = new Sim();
  const good = reserve(sim);
  const unreserved = asId<QueueItemId>("made-up");
  const probeBefore = sim.ids.next("op");
  const result = sim.cmd({ type: "enqueue", position: "end", entries: [entry("a"), entry("g", good), entry("bad", unreserved), entry("b")] });
  assert.ok(result.notes.some((n) => n.reason.includes("not an unclaimed reservation")));
  assert.equal(sim.snap.queue.length, 0);
  assert.equal(sim.ids.isReserved(good), true, "not consumed by the failed command");
  const probeAfter = sim.ids.next("op");
  assert.equal(Number(probeAfter.split(":").at(-1)), Number(probeBefore.split(":").at(-1)) + 1, "no ids generated for the rejected batch");

  const twice = sim.cmd({ type: "enqueue", position: "end", entries: [entry("g1", good), entry("g2", good)] });
  assert.ok(twice.notes.some((n) => n.reason.includes("repeated")));
  assert.equal(sim.snap.queue.length, 0);
  assert.equal(sim.ids.isReserved(good), true);

  sim.cmd({ type: "enqueue", position: "end", entries: [entry("a"), entry("g", good), entry("b")] });
  assert.deepEqual(sim.snap.queue.map((e) => e.item.track.mediaId), ["a", "g", "b"], "mixed batch: supplied and generated ids");
  assert.equal(sim.itemIdAt(1), good);
  assert.equal(new Set(sim.snap.queue.map((e) => e.item.itemId)).size, 3);
});

test("an id that played and left history and receipts long ago is still refused", () => {
  const sim = new Sim({ historyLimit: 1, receiptLimit: 1 }, { djEnabled: false });
  const first = reserve(sim);
  sim.cmd({ type: "enqueue", position: "end", entries: [entry("a", first), entry("b"), entry("c")] });
  sim.cmd({ type: "resume" });
  for (let index = 0; index < 3; index += 1) {
    const program = sim.snap.program!.item.itemId;
    sim.startProgram(program);
    sim.naturalEnd(program);
  }
  assert.ok(sim.snap.history.every((h) => h.item.itemId !== first), "beyond historyLimit");
  assert.ok(sim.snap.receipts.every((r) => r.itemId !== first), "beyond receiptLimit");
  const result = sim.cmd({ type: "enqueue", position: "end", entries: [entry("again", first)] });
  assert.ok(result.notes.some((n) => n.reason.includes("not an unclaimed reservation")));
  assert.equal(sim.snap.queue.length, 0);
});

test("select and replace-queue accept reservations under the same rules", () => {
  const sim = new Sim();
  const picked = reserve(sim);
  sim.cmd({ type: "select", target: { kind: "track", entry: entry("p", picked) } });
  assert.equal(sim.snap.program?.item.itemId, picked);
  const reused = sim.cmd({ type: "select", target: { kind: "track", entry: entry("p2", picked) } });
  assert.ok(reused.notes.some((n) => n.kind === "ignored"));
  assert.equal(sim.snap.program?.item.itemId, picked);

  const x = reserve(sim);
  const y = reserve(sim);
  sim.cmd({ type: "replace-queue", entries: [entry("x", x), entry("y", y)], autoplay: true });
  assert.equal(sim.snap.program?.item.itemId, x);
  assert.equal(sim.itemIdAt(1), y);
  assert.equal(sim.ids.reservedCount, 0);
});

test("a released candidate cannot be enqueued, and failed candidates leave nothing reserved", () => {
  const sim = new Sim();
  const kept = reserve(sim);
  const failed = reserve(sim);
  assert.equal(sim.ids.release(failed), true);
  const result = sim.cmd({ type: "enqueue", position: "end", entries: [entry("k", kept), entry("f", failed)] });
  assert.ok(result.notes.some((n) => n.kind === "ignored"));
  assert.equal(sim.ids.release(kept), true, "the app releases the batch it gave up on");
  assert.equal(sim.ids.reservedCount, 0);
});

test("restore enqueues without old ids; a stale persisted id is refused, never adopted", () => {
  const sim = new Sim();
  const result = sim.cmd({ type: "enqueue", position: "end", entries: [{ ...entry("old", asId<QueueItemId>("t:item:1")), origin: "restore" }] });
  assert.ok(result.notes.some((n) => n.kind === "ignored"));
  sim.cmd({ type: "enqueue", position: "end", entries: [{ ...entry("old"), origin: "restore" }] });
  assert.equal(sim.snap.queue.length, 1);
});

test("supplied ids need a reservable factory", () => {
  const plain: IdFactory = { next: (kind) => `p:${kind}:${Math.random()}` };
  const result = step(createInitialState(), { kind: "command", command: { type: "enqueue", position: "end", entries: [entry("a", asId<QueueItemId>("p:item:1"))] } }, { now: 1, ids: plain });
  assert.ok(result.notes.some((n) => n.reason.includes("reservable")));
  assert.equal(result.state.queue.length, 0);
});
