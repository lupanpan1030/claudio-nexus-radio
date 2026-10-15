import assert from "node:assert/strict";
import test from "node:test";
import type { QueueEntryRequest } from "@claudio/contracts";
import { cueAsset, Sim, track } from "./harness.js";

function entries(...names: string[]): QueueEntryRequest[] {
  return names.map((name) => ({ track: track(name), display: { title: name, artist: "fixture" }, origin: "chat" as const }));
}

function names(sim: Sim): string[] {
  return sim.snap.queue.map((entry) => String(entry.item.track.mediaId));
}

/** A playing, B preheated on the standby deck with lyrics, A→B narration requested, C waiting. */
function playingWithStandby() {
  const sim = new Sim();
  const [a, b, c] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  return { sim, a: a!, b: b!, c: c! };
}

test("load-only replace keeps the program, drops the waiting items with their deck, lyrics and cue, and never plays", () => {
  const { sim, a, b } = playingWithStandby();
  const bLoad = sim.loadOf(b).loadId;
  const cueOp = sim.lastEffect("cue.request").opId;
  const lyricsOp = sim.lastEffect("lyrics.request", (e) => e.itemId === b).opId;

  const mark = sim.mark();
  sim.cmd({ type: "replace-queue", entries: entries("x", "y"), autoplay: false });
  assert.equal(sim.snap.program?.item.itemId, a);
  assert.deepEqual(names(sim), ["x", "y"]);
  assert.ok(sim.effects("deck.unload", mark).some((e) => e.loadId === bLoad));
  const cancelled = sim.effects("operation.cancel", mark).map((e) => e.opId);
  assert.ok(cancelled.includes(cueOp) && cancelled.includes(lyricsOp));
  assert.equal(sim.effects("deck.play", mark).length, 0);
  const x = sim.itemIdAt(0);
  assert.equal(sim.snap.transition?.toItemId, x, "narration re-planned to the new head");
  assert.equal(sim.lastEffect("prepare.start").itemId, x);
  assert.equal(sim.lastEffect("prepare.start").purpose, "standby");
  assert.equal(sim.snap.transport, "playing");
  assert.ok(sim.snap.pending.every((op) => op.opId !== cueOp && op.opId !== lyricsOp));
});

test("load-only replace cancels an in-flight preparation of a dropped item", () => {
  const sim = new Sim();
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  const prep = sim.lastEffect("prepare.start", (e) => e.itemId === b);
  const mark = sim.mark();
  sim.cmd({ type: "replace-queue", entries: entries("x"), autoplay: false });
  assert.ok(sim.effects("operation.cancel", mark).some((e) => e.opId === prep.opId));
  const late = sim.fact({ type: "prepare.resolved", opId: prep.opId, itemId: b!, media: { ...sim.lastEffect("deck.load").media, track: track("b") } });
  assert.equal(late.notes[0]?.kind, "stale");
});

test("load-only replace during a sequential talk keeps the executing target and the voice", () => {
  const { sim, b } = playingWithStandby();
  sim.deck(b, { kind: "can-play", through: true });
  sim.cueReady();
  sim.naturalEnd(sim.snap.program!.item.itemId);
  sim.voice({ kind: "playing", positionMs: 0 });

  const mark = sim.mark();
  sim.cmd({ type: "replace-queue", entries: entries("x"), autoplay: false });
  assert.equal(sim.snap.transition?.phase, "talking");
  assert.equal(sim.effects("voice.stop", mark).length, 0);
  assert.deepEqual(names(sim), ["b", "x"]);
  sim.voiceNaturalEnd();
  assert.equal(sim.snap.program?.item.itemId, b);
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transition?.toItemId, sim.itemIdAt(0));
  assert.deepEqual(names(sim), ["x"]);
});

test("load-only replace from idle or exhausted waits for resume; nothing is prepared or played", () => {
  const idle = new Sim();
  let mark = idle.mark();
  idle.cmd({ type: "replace-queue", entries: entries("x", "y"), autoplay: false });
  assert.equal(idle.snap.transport, "idle");
  assert.deepEqual(idle.since(mark), []);
  idle.cmd({ type: "resume" });
  assert.equal(idle.snap.program?.item.track.mediaId, "x");

  const sim = new Sim();
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.naturalEnd(a!);
  assert.equal(sim.snap.transport, "exhausted");
  mark = sim.mark();
  sim.cmd({ type: "replace-queue", entries: entries("x"), autoplay: false });
  assert.equal(sim.snap.transport, "idle", "loading a list is not a request to play it");
  assert.equal(sim.effects("prepare.start", mark).length, 0);
  assert.equal(sim.effects("deck.play", mark).length, 0);
  sim.enqueue("z");
  assert.equal(sim.snap.program === null, true, "a later refill does not start it either");
  sim.cmd({ type: "resume" });
  assert.equal(sim.snap.program?.item.track.mediaId, "x");
});

test("load-only replace with an empty list clears the waiting items only", () => {
  const { sim, a } = playingWithStandby();
  sim.cmd({ type: "replace-queue", entries: [], autoplay: false });
  assert.equal(sim.snap.program?.item.itemId, a);
  assert.deepEqual(sim.snap.queue, []);
  assert.equal(sim.snap.transition, null);
  assert.equal(sim.snap.transport, "playing");
});

test("autoplay replace cancels the transition once, plays entries[0] and queues the rest in one step", () => {
  const { sim, a } = playingWithStandby();
  const result = sim.cmd({ type: "replace-queue", entries: entries("x", "y", "z"), autoplay: true });
  assert.equal(result.notes.filter((n) => n.reason.startsWith("transition cancelled")).length, 1);
  const x = sim.snap.program!.item.itemId;
  assert.equal(sim.snap.program?.item.track.mediaId, "x");
  assert.deepEqual(names(sim), ["x", "y", "z"]);
  assert.deepEqual(sim.snap.history.map((h) => [h.item.itemId, h.outcome]), [[a, "skipped"]]);
  assert.equal(sim.lastEffect("prepare.start").itemId, x);
  sim.startProgram(x);
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, x]);
  assert.equal(sim.snap.transition?.toItemId, sim.itemIdAt(0));
  assert.deepEqual(names(sim), ["y", "z"]);
});

test("autoplay replace during a sequential talk stops the voice and the target", () => {
  const { sim, b } = playingWithStandby();
  sim.deck(b, { kind: "can-play", through: true });
  sim.cueReady();
  const voice = sim.lastEffect("voice.load");
  sim.naturalEnd(sim.snap.program!.item.itemId);
  sim.voice({ kind: "playing", positionMs: 0 });
  const bLoad = sim.loadOf(b).loadId;

  const mark = sim.mark();
  sim.cmd({ type: "replace-queue", entries: entries("x"), autoplay: true });
  assert.ok(sim.effects("voice.stop", mark).some((e) => e.voiceLoadId === voice.voiceLoadId));
  assert.ok(sim.effects("deck.unload", mark).some((e) => e.loadId === bLoad));
  assert.equal(sim.snap.program?.item.track.mediaId, "x");
  assert.equal(sim.snap.history.at(-1)?.outcome, "played", "A had really ended");
  assert.equal(sim.state.retainedNarration, null, "narration for the dropped B is not kept");
});

test("autoplay replace from idle starts entries[0]; an empty autoplay list is ignored", () => {
  const sim = new Sim();
  sim.cmd({ type: "replace-queue", entries: entries("x", "y"), autoplay: true });
  assert.equal(sim.snap.program?.item.track.mediaId, "x");
  assert.equal(sim.snap.transport, "requested");

  const { sim: playing, a } = playingWithStandby();
  const before = playing.snap;
  const result = playing.cmd({ type: "replace-queue", entries: [], autoplay: true });
  assert.ok(result.notes.some((n) => n.kind === "ignored"));
  assert.deepEqual(result.effects, []);
  assert.equal(playing.snap.program?.item.itemId, a);
  assert.deepEqual(playing.snap.queue, before.queue);
  assert.deepEqual(playing.snap.transition, before.transition);
});

test("autoplay replace during a crossfade overlap drops the outgoing deck and the voice", () => {
  const sim = new Sim({ preferredTalkMode: "talk-over-crossfade" });
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady(cueAsset());
  sim.deck(a!, { kind: "time", positionMs: 193_000, rate: 1 });
  sim.deck(b!, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transition?.phase, "overlapping");
  const aLoad = sim.loadOf(a!).loadId;
  const mark = sim.mark();
  sim.cmd({ type: "replace-queue", entries: entries("x"), autoplay: true });
  assert.ok(sim.effects("deck.unload", mark).some((e) => e.loadId === aLoad));
  assert.equal(sim.snap.voice, null);
  assert.equal(sim.snap.program?.item.track.mediaId, "x");
  assert.equal(sim.snap.decks.A.role === "outgoing" || sim.snap.decks.B.role === "outgoing", false);
});
