import assert from "node:assert/strict";
import test from "node:test";
import { Sim } from "./harness.js";

/**
 * Fact sequences in the order one media element dispatches its events
 * (play/playing/pause/seeked share one task source). They show what the core
 * concludes from such an order; whether a browser produces it is R2's
 * real-media evidence, not proven here.
 */

function crossfadeTwo() {
  const sim = new Sim({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  return { sim, a: a!, b: b! };
}

test("independent repro: an unconfirmed preroll's late playing after hold → promote is not a start; a refused second play leaves B unstarted", () => {
  const { sim, a, b } = crossfadeTwo();
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 194_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  const bLoad = sim.loadOf(b);
  const play1 = sim.lastEffect("deck.play", (e) => e.loadId === bLoad.loadId);

  sim.cmd({ type: "seek", positionMs: 199_900 });
  assert.equal(sim.snap.decks[bLoad.deck].status, "ready", "B was never confirmed playing");
  sim.deck(a, { kind: "seeked", positionMs: 199_900 });
  sim.naturalEnd(a, 200_000);
  assert.equal(sim.snap.program?.item.itemId, b);
  const play2 = sim.lastEffect("deck.play", (e) => e.loadId === bLoad.loadId);
  assert.notEqual(play2.playId, play1.playId);

  const late = sim.deck(b, { kind: "playing", positionMs: 90 });
  assert.equal(late.notes[0]?.kind, "stale", "playing queued before the hold's pause acknowledgement");
  assert.equal(sim.snap.program?.started, false);
  assert.ok(sim.snap.queue.some((e) => e.item.itemId === b), "B not consumed");
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a]);
  const failuresBefore = sim.state.consecutiveFailures;

  sim.deck(b, { kind: "paused", positionMs: 95, atEnd: false, requested: true });
  sim.deck(b, { kind: "seeked", positionMs: 0 });
  const stalePlay1 = sim.fact({ type: "deck.media", deck: bLoad.deck, loadId: bLoad.loadId, event: { kind: "play-rejected", reason: "not-allowed", playId: play1.playId } });
  assert.equal(stalePlay1.notes[0]?.kind, "stale", "a rejection of play #1 says nothing about play #2");
  assert.equal(sim.snap.transport, "loading");
  sim.rejectPlay(b, "not-allowed");
  assert.equal(sim.snap.transport, "blocked");
  assert.equal(sim.snap.program?.started, false);
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a]);
  assert.equal(sim.state.consecutiveFailures, failuresBefore, "failure counter not reset by a start that never happened");

  sim.cmd({ type: "resume" });
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.program?.started, true);
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b], "one receipt, after the retry really played");
});

test("preroll → transport pause → next: the first play's playing before the pause acknowledgement is not B's start", () => {
  const { sim, a, b } = crossfadeTwo();
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 194_000, rate: 1 });
  sim.cmd({ type: "pause" });
  sim.deck(a, { kind: "paused", positionMs: 194_000, atEnd: false, requested: true });
  sim.cmd({ type: "next" });
  assert.equal(sim.snap.program?.item.itemId, b);
  sim.deck(b, { kind: "playing", positionMs: 30 });
  assert.equal(sim.snap.program?.started, false);
  sim.deck(b, { kind: "paused", positionMs: 30, atEnd: false, requested: true });
  sim.deck(b, { kind: "playing", positionMs: 30 });
  assert.equal(sim.snap.program?.started, true);
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
});

test("every pause needs its own acknowledgement: two quick pause/resume rounds hold until both arrive", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.resolve(a!);
  sim.cmd({ type: "pause" });
  sim.cmd({ type: "resume" });
  sim.cmd({ type: "pause" });
  sim.cmd({ type: "resume" });
  assert.equal(sim.state.decks[sim.loadOf(a!).deck].pausesAwaited, 2);
  sim.deck(a!, { kind: "playing", positionMs: 0 });
  sim.deck(a!, { kind: "paused", positionMs: 0, atEnd: false, requested: true });
  const between = sim.deck(a!, { kind: "playing", positionMs: 0 });
  assert.equal(between.notes[0]?.kind, "stale");
  sim.deck(a!, { kind: "paused", positionMs: 0, atEnd: false, requested: true });
  sim.deck(a!, { kind: "playing", positionMs: 0 });
  assert.equal(sim.receipts().length, 1);
  assert.equal(sim.snap.transport, "playing");
});

test("a pause the executor acknowledges at once (nothing owed, e.g. a play still waiting for unlock) never stalls", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.resolve(a!);
  sim.cmd({ type: "pause" });
  sim.deck(a!, { kind: "paused", positionMs: 0, atEnd: false, requested: true });
  sim.cmd({ type: "resume" });
  sim.deck(a!, { kind: "playing", positionMs: 0 });
  assert.equal(sim.receipts().length, 1);
  const unload = sim.mark();
  sim.cmd({ type: "stop" });
  assert.equal(sim.effects("deck.unload", unload).length, 1);
  assert.equal(sim.state.decks.A.pausesAwaited + sim.state.decks.B.pausesAwaited, 0, "unload forgets owed acknowledgements");
});

test("an aborted play is not a block: the interruption that caused it decides", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.resolve(a!);
  sim.rejectPlay(a!, "aborted");
  assert.notEqual(sim.snap.transport, "blocked");
  assert.equal(sim.snap.transport, "loading");
  sim.deck(a!, { kind: "playing", positionMs: 0 });
  assert.equal(sim.receipts().length, 1);
});

test("seek racing the natural end: the end's pause dispatched after the seek does not pause the transport", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.deck(a!, { kind: "can-play", through: true });
  sim.deck(a!, { kind: "metadata", duration: { kind: "known", ms: 200_000, source: "media-element" } });
  const aLoad = sim.loadOf(a!).loadId;
  const mark = sim.mark();
  sim.cmd({ type: "seek", positionMs: 100_000 });
  assert.ok(sim.effects("deck.play", mark).some((e) => e.loadId === aLoad), "play asked again with the seek");
  sim.deck(a!, { kind: "paused", positionMs: 100_000, atEnd: false, requested: false });
  assert.equal(sim.snap.transport, "loading", "not paused: the listener just sought");
  assert.notEqual(sim.state.intent, "pause");
  assert.equal(sim.effects("deck.play", mark).filter((e) => e.loadId === aLoad).length, 2);
  sim.deck(a!, { kind: "seeked", positionMs: 100_000 });
  sim.deck(a!, { kind: "playing", positionMs: 100_000 });
  assert.equal(sim.snap.transport, "playing");
  assert.equal(sim.snap.program?.item.itemId, a);
  assert.equal(sim.receipts().length, 1);
});

test("seek after the end's pause but before its ended: the stale ended is dropped and play is requested", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.deck(a!, { kind: "can-play", through: true });
  sim.deck(a!, { kind: "metadata", duration: { kind: "known", ms: 200_000, source: "media-element" } });
  sim.deck(a!, { kind: "paused", positionMs: 200_000, atEnd: true, requested: false });
  const aLoad = sim.loadOf(a!).loadId;
  const mark = sim.mark();
  sim.cmd({ type: "seek", positionMs: 50_000 });
  assert.ok(sim.effects("deck.play", mark).some((e) => e.loadId === aLoad));
  const ended = sim.deck(a!, { kind: "ended" });
  assert.equal(ended.notes[0]?.kind, "stale");
  assert.equal(sim.snap.program?.item.itemId, a);
  sim.deck(a!, { kind: "seeked", positionMs: 50_000 });
  sim.deck(a!, { kind: "playing", positionMs: 50_000 });
  assert.equal(sim.snap.transport, "playing");
});

test("an external pause with no seek pending still pauses the transport", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.deck(a!, { kind: "paused", positionMs: 10_000, atEnd: false, requested: false });
  assert.equal(sim.snap.transport, "paused");
});
