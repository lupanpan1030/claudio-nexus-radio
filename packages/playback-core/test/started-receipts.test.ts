import assert from "node:assert/strict";
import test from "node:test";
import { Sim } from "./harness.js";

function playingAWithPreheatedB() {
  const sim = new Sim({}, { djEnabled: false });
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  return { sim, a: a!, b: b! };
}

test("an unrequested playing on a standby deck is held at its start; once promoted it records only on a fresh playing", () => {
  const { sim, a, b } = playingAWithPreheatedB();
  const standby = sim.loadOf(b);
  assert.equal(sim.snap.decks[standby.deck].role, "standby");
  assert.equal(sim.snap.decks[standby.deck].gain, 0, "standby is silent");

  // Nobody asked B to play (no preroll), yet its element reports playing.
  const mark = sim.mark();
  sim.tick(3000);
  sim.deck(b, { kind: "playing", positionMs: 2500 });
  assert.deepEqual(sim.effects("deck.pause", mark).map((e) => e.loadId), [standby.loadId], "silenced");
  assert.deepEqual(sim.effects("deck.seek", mark).map((e) => [e.loadId, e.positionMs]), [[standby.loadId, 0]], "rewound");
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a], "standby playing is not a started fact");

  // The user skips before the element acknowledged the pause.
  const loadsBefore = sim.effects("deck.load").length;
  const next = sim.mark();
  sim.cmd({ type: "next" });
  assert.equal(sim.snap.decks[standby.deck].role, "program");
  assert.equal(sim.snap.decks[standby.deck].gain, 1);
  assert.ok(sim.effects("deck.play", next).some((e) => e.loadId === standby.loadId));
  assert.equal(sim.receipts().length, 1, "its earlier playing predates the pause and confirms nothing");

  sim.deck(b, { kind: "paused", positionMs: 2510, atEnd: false, requested: true });
  assert.equal(sim.snap.transport, "loading", "own pause answering a superseded request is not an interruption");
  sim.deck(b, { kind: "seeked", positionMs: 0 });
  sim.deck(b, { kind: "playing", positionMs: 0 });
  const receipts = sim.receipts();
  assert.deepEqual(receipts.map((e) => e.receipt.itemId), [a, b]);
  assert.equal(receipts[1]!.receipt.loadId, standby.loadId, "same load, promoted, not reloaded");
  assert.equal(receipts[1]!.receipt.positionMs, 0, "did not drift on unheard");
  assert.equal(sim.effects("deck.load").length, loadsBefore);
  assert.equal(sim.snap.transport, "playing");
});

test("committed first, playing later also records exactly once", () => {
  const { sim, a, b } = playingAWithPreheatedB();
  sim.cmd({ type: "next" });
  assert.equal(sim.receipts().length, 1, "commit alone is not enough");
  sim.deck(b, { kind: "waiting", positionMs: 0 });
  assert.equal(sim.snap.transport, "waiting");
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
});

test("pause and resume never produce another receipt and re-anchor gains", () => {
  const { sim, a } = playingAWithPreheatedB();
  const program = sim.loadOf(a);
  const mark = sim.mark();
  sim.cmd({ type: "pause" });
  assert.ok(sim.effects("deck.pause", mark).some((e) => e.loadId === program.loadId));
  sim.deck(a, { kind: "paused", positionMs: 5000, atEnd: false, requested: true });
  assert.equal(sim.snap.transport, "paused");

  const resumeMark = sim.mark();
  sim.cmd({ type: "resume" });
  const plays = sim.effects("deck.play", resumeMark);
  assert.deepEqual(plays.map((e) => e.loadId), [program.loadId], "only the program deck resumes; standby stays held");
  assert.ok(sim.effects("deck.gain", resumeMark).some((e) => e.loadId === program.loadId), "gain automation re-anchored");
  sim.deck(a, { kind: "playing", positionMs: 5000 });
  assert.equal(sim.receipts().length, 1);
});

test("a late playing event after pause is pushed back to paused and does not count", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.resolve(a!);
  sim.cmd({ type: "pause" });
  const mark = sim.mark();
  sim.deck(a!, { kind: "playing", positionMs: 0 });
  assert.equal(sim.effects("deck.pause", mark).length, 1, "intent enforced again");
  assert.equal(sim.receipts().length, 0);
  // The element answers the first pause (it had been asked to play, so it fires `pause`).
  sim.deck(a!, { kind: "paused", positionMs: 40, atEnd: false, requested: true });
  sim.cmd({ type: "resume" });
  sim.deck(a!, { kind: "playing", positionMs: 100 });
  assert.equal(sim.receipts().length, 1);
});

test("play() rejection blocks without recording; a user resume recovers", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.resolve(a!);
  sim.deck(a!, { kind: "play-rejected", reason: "not-allowed" });
  assert.equal(sim.snap.transport, "blocked");
  assert.equal(sim.receipts().length, 0);

  const mark = sim.mark();
  sim.cmd({ type: "resume" });
  assert.equal(sim.effects("deck.play", mark).length, 1);
  sim.deck(a!, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transport, "playing");
  assert.equal(sim.receipts().length, 1);
});

test("volume 0 and mute still count as a legitimate play", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "set-volume", channel: "music", value: 0 });
  sim.cmd({ type: "set-muted", muted: true });
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  assert.equal(sim.receipts().length, 1);
  assert.deepEqual(sim.lastEffect("output.volume"), { type: "output.volume", music: 0, voice: 1, muted: true });
});

test("receipt failures are recorded without touching audio", () => {
  const { sim, a } = playingAWithPreheatedB();
  const receipt = sim.receipts()[0]!.receipt;
  const result = sim.fact({ type: "receipt.settled", idempotencyKey: receipt.idempotencyKey, itemId: a, outcome: "failed" });
  assert.equal(result.effects.length, 0);
  assert.deepEqual(sim.snap.receipts.find((r) => r.itemId === a)?.status, "failed");
  assert.equal(sim.snap.transport, "playing");
});
