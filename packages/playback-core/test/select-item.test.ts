import assert from "node:assert/strict";
import test from "node:test";
import type { CoreConfig } from "../src/index.js";
import { cueAsset, Sim, track } from "./harness.js";

/**
 * Selecting a queue row that already exists ({kind:"item"}): the item keeps
 * its identity and origin, the rest of the queue keeps its order, prepared
 * resources are reused, and — like every manual move — the pending hand-over
 * narration is dropped, not saved for later.
 */
function playingA(config: Partial<CoreConfig> = {}) {
  const sim = new Sim(config);
  sim.cmd({
    type: "enqueue",
    position: "end",
    entries: ["a", "b", "c", "d"].map((name) => ({ track: track(name), display: { title: name, artist: "fixture" }, origin: name === "b" ? ("radio" as const) : ("user" as const) }))
  });
  const [a, b, c, d] = sim.snap.queue.map((entry) => entry.item.itemId);
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  return { sim, a: a!, b: b!, c: c!, d: d! };
}

const queueIds = (sim: Sim) => sim.snap.queue.map((entry) => entry.item.itemId);

test("planned: selecting B promotes its preheated deck, keeps itemId/origin and the queue, and cancels the pending cue", () => {
  const { sim, a, b, c, d } = playingA();
  assert.equal(sim.snap.transition?.phase, "planned");
  const bItem = sim.snap.queue.find((entry) => entry.item.itemId === b)!.item;
  const bLoad = sim.loadOf(b);
  sim.cueReady(cueAsset("下一首。慢慢进来。"));
  const voiceLoad = sim.lastEffect("voice.load");

  const mark = sim.mark();
  sim.cmd({ type: "select", target: { kind: "item", itemId: b } });
  const snap = sim.snap;
  assert.equal(snap.program?.item, bItem, "the same queue item, not a re-created one");
  assert.equal(snap.program?.item.origin, "radio");
  assert.equal(snap.program?.deck, bLoad.deck);
  assert.deepEqual(queueIds(sim), [b, c, d], "nothing else dropped or reordered");
  assert.deepEqual(snap.history.map((entry) => [entry.item.itemId, entry.outcome]), [[a, "skipped"]]);
  assert.equal(sim.effects("deck.load", mark).length, 0, "no reload of B");
  assert.equal(sim.effects("prepare.start", mark).length, 0, "no new preparation");
  assert.deepEqual(sim.effects("deck.play", mark).map((e) => e.loadId), [bLoad.loadId]);
  assert.deepEqual(sim.effects("voice.stop", mark).map((e) => e.voiceLoadId), [voiceLoad.voiceLoadId], "old hand-over narration stopped");
  assert.equal(sim.effects("voice.play", mark).length, 0, "and never spoken later");
  assert.equal(snap.voice, null);
  assert.equal(snap.transition, null);
  assert.ok(sim.state.reusableCue === null, "the manual move does not keep the narration for later");

  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
  assert.equal(sim.receipts()[1]!.receipt.idempotencyKey, `started:${b}`, "started is keyed by the kept itemId");
  assert.equal(sim.snap.transition?.toItemId, c, "the next hand-over plans from the kept queue");
});

test("planned with the cue still being generated: selecting B aborts the request", () => {
  const { sim, b } = playingA();
  const request = sim.lastEffect("cue.request");
  const mark = sim.mark();
  sim.cmd({ type: "select", target: { kind: "item", itemId: b } });
  assert.ok(sim.effects("operation.cancel", mark).some((e) => e.opId === request.opId));
  assert.equal(sim.snap.voice, null);
  assert.equal(sim.snap.program?.item.itemId, b);
});

test("prerolling: selecting the prerolling B promotes it as is — no load, prepare, pause or seek, and one started", () => {
  const { sim, a, b, c, d } = playingA({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 195_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  const bLoad = sim.loadOf(b);

  const mark = sim.mark();
  sim.cmd({ type: "select", target: { kind: "item", itemId: b } });
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.equal(sim.snap.program?.item.origin, "radio");
  for (const type of ["deck.load", "prepare.start", "voice.play"] as const) assert.equal(sim.effects(type, mark).length, 0, type);
  assert.equal(sim.effects("deck.pause", mark).filter((e) => e.loadId === bLoad.loadId).length, 0);
  assert.equal(sim.effects("deck.seek", mark).filter((e) => e.loadId === bLoad.loadId).length, 0);
  assert.equal(sim.snap.decks[bLoad.deck].gain, 1, "brought up from the silent preroll");
  assert.deepEqual(queueIds(sim), [b, c, d]);

  sim.deck(b, { kind: "playing", positionMs: 0 });
  sim.deck(b, { kind: "playing", positionMs: 10 });
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b], "B reported once");
});

test("selecting an item that was never prepared keeps the queue order, keeps B preheated and bounds the work to one preparation", () => {
  const { sim, a, b, c, d } = playingA();
  const aLoad = sim.loadOf(a);
  const bLoad = sim.loadOf(b);
  const cue = sim.lastEffect("cue.request");

  const mark = sim.mark();
  sim.cmd({ type: "select", target: { kind: "item", itemId: c } });
  assert.deepEqual(queueIds(sim), [c, b, d], "C moves to the front; B and D keep their order");
  assert.equal(sim.snap.program?.item.itemId, c);
  assert.ok(sim.effects("operation.cancel", mark).some((e) => e.opId === cue.opId), "A→B narration aborted");
  assert.deepEqual(sim.effects("deck.unload", mark).map((e) => e.loadId), [aLoad.loadId], "only A's deck is released");
  assert.deepEqual(sim.effects("prepare.start", mark).map((e) => e.itemId), [c], "exactly one new preparation");
  assert.equal(sim.snap.decks[bLoad.deck].role, "standby", "B stays preheated");
  assert.equal(sim.snap.transport, "requested");

  sim.resolve(c);
  const cLoad = sim.loadOf(c);
  assert.equal(cLoad.deck, aLoad.deck, "C takes the deck A freed, not B's");
  sim.deck(c, { kind: "can-play", through: true });
  sim.deck(c, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, c]);
  assert.equal(sim.snap.transition?.toItemId, b, "C hands over to B next");
  assert.equal(sim.effects("deck.load", mark).filter((e) => e.itemId === b).length, 0, "B is reused, not reloaded");
  assert.equal(sim.effects("prepare.start", mark).filter((e) => e.itemId !== c).length, 0);
  // Steady state of any started program with a planned next: lyrics per loaded deck (C, B) and one cue (C→B); nothing of A's.
  assert.deepEqual(sim.snap.pending.map((op) => op.kind).sort(), ["cue", "lyrics", "lyrics"]);
  assert.equal(sim.lastEffect("cue.request").binding.fromItemId, c);
});
