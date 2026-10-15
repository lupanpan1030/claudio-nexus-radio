import assert from "node:assert/strict";
import test from "node:test";
import { asId, type LyricsAsset } from "@claudio/contracts";
import { media, Sim, track } from "./harness.js";

function lyricsFor(revision: string, recording: string): LyricsAsset {
  return {
    assetId: asId(`lyrics-${revision}`),
    recordingId: asId(recording),
    sourceRevision: asId(revision),
    timing: "native-line",
    offsetMs: 0,
    lines: [{ startMs: 0, text: "la" }]
  };
}

function playingWithLyricsAndCue() {
  const sim = new Sim();
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  const lyricsRequest = sim.lastEffect("lyrics.request", (e) => e.itemId === a);
  sim.fact({
    type: "lyrics.result",
    opId: lyricsRequest.opId,
    itemId: a!,
    sourceRevision: lyricsRequest.sourceRevision,
    result: { status: "available", asset: lyricsFor(lyricsRequest.sourceRevision, lyricsRequest.recordingId) }
  });
  sim.resolve(b!);
  sim.cueReady();
  return { sim, a: a!, b: b!, lyricsRequest };
}

test("source refresh to a different recording drops lyrics and cues bound to the old revision", () => {
  const { sim, a, lyricsRequest } = playingWithLyricsAndCue();
  assert.equal(sim.snap.display.kind === "music" && sim.snap.display.lyrics.status, "available");
  const oldCue = sim.lastEffect("voice.load");
  sim.tick(60_000);
  sim.deck(a, { kind: "time", positionMs: 60_000, rate: 1 });

  const mark = sim.mark();
  sim.deck(a, { kind: "error", error: { class: "expired", code: "stream_expired" } });
  const refresh = sim.lastEffect("prepare.start", (e) => e.itemId === a);
  assert.equal(refresh.purpose, "refresh");
  assert.equal(refresh.previousRevision, lyricsRequest.sourceRevision);
  assert.equal(sim.snap.transport, "requested");

  sim.resolve(a, { recording: "rec-a-other", revision: "rev-a-2" });
  const effects = sim.since(mark);
  assert.ok(effects.some((e) => e.type === "voice.stop" && e.voiceLoadId === oldCue.voiceLoadId), "old cue cancelled");
  const reload = sim.lastEffect("deck.load", (e) => e.itemId === a);
  assert.equal(reload.startAtMs, 0, "a different recording does not inherit the old position");
  assert.equal(reload.media.sourceRevision, "rev-a-2");
  const display = sim.snap.display;
  assert.ok(display.kind === "music" && display.lyrics.status === "loading", "old lyrics no longer displayed");
  assert.equal(sim.lastEffect("lyrics.request", (e) => e.itemId === a).sourceRevision, "rev-a-2");
  assert.equal(sim.snap.transition?.fromRevision, "rev-a-2", "new transition bound to the new revision");
  assert.notEqual(sim.snap.transition?.cueId, oldCue.cueId);

  const stale = sim.fact({
    type: "lyrics.result",
    opId: lyricsRequest.opId,
    itemId: a,
    sourceRevision: lyricsRequest.sourceRevision,
    result: { status: "available", asset: lyricsFor(lyricsRequest.sourceRevision, lyricsRequest.recordingId) }
  });
  assert.equal(stale.notes[0]?.kind, "stale");

  sim.deck(a, { kind: "playing", positionMs: 0 });
  assert.equal(sim.receipts().length, 1, "same queue item is not recorded twice after a source change");
});

test("refreshing an expired URL of the same recording keeps position, lyrics and cue", () => {
  const { sim, a } = playingWithLyricsAndCue();
  sim.deck(a, { kind: "time", positionMs: 42_000, rate: 1 });
  const cueBefore = sim.snap.voice?.cueId;
  sim.deck(a, { kind: "error", error: { class: "expired", code: "stream_expired" } });
  const lyricsRequests = sim.effects("lyrics.request").length;
  sim.resolve(a); // same recording + revision, new handle
  const reload = sim.lastEffect("deck.load", (e) => e.itemId === a);
  assert.equal(reload.startAtMs, 42_000);
  assert.equal(sim.effects("lyrics.request").length, lyricsRequests, "lyrics kept");
  assert.equal(sim.snap.voice?.cueId, cueBefore, "cue kept");
  sim.deck(a, { kind: "playing", positionMs: 42_000 });
  const display = sim.snap.display;
  assert.ok(display.kind === "music" && display.lyrics.status === "available");
  assert.equal(sim.receipts().length, 1);
});

test("lyrics for another revision are never shown", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  const request = sim.lastEffect("lyrics.request");
  sim.fact({
    type: "lyrics.result",
    opId: request.opId,
    itemId: a!,
    sourceRevision: request.sourceRevision,
    result: { status: "available", asset: lyricsFor("some-other-revision", "rec-x") }
  });
  const display = sim.snap.display;
  assert.ok(display.kind === "music" && display.lyrics.status === "unmatched");
});

test("stop settles every pending operation, releases decks and leaves unstarted items queued", () => {
  const sim = new Sim();
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  // In flight now: B preparation, narration, A lyrics.
  assert.ok(sim.snap.pending.length >= 3);
  const pendingIds = sim.snap.pending.map((p) => p.opId);

  const mark = sim.mark();
  sim.cmd({ type: "stop" });
  assert.deepEqual(sim.snap.pending, []);
  const cancelled = sim.effects("operation.cancel", mark).map((e) => e.opId);
  assert.deepEqual([...cancelled].sort(), [...pendingIds].sort());
  assert.ok(sim.effects("deck.unload", mark).length >= 1);
  assert.equal(sim.snap.decks.A.role, "idle");
  assert.equal(sim.snap.decks.B.role, "idle");
  assert.equal(sim.snap.transport, "idle");
  assert.deepEqual(sim.snap.queue.map((e) => [e.item.itemId, e.reservation]), [[b, "none"]]);
  assert.equal(sim.snap.history.at(-1)?.outcome, "stopped");

  for (const opId of pendingIds) {
    const late = sim.fact({ type: "cue.settled", opId, cueId: asId("whatever"), outcome: "failed", error: null });
    assert.equal(late.notes[0]?.kind, "stale");
  }
});

test("stop before the program ever played keeps it queued, and resume starts it again", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  const request = sim.lastEffect("prepare.start");
  sim.cmd({ type: "stop" });
  assert.equal(sim.snap.queue[0]?.item.itemId, a);
  assert.equal(sim.snap.history.length, 0);
  const late = sim.fact({ type: "prepare.resolved", opId: request.opId, itemId: a!, media: { track: request.track } as never });
  assert.equal(late.notes[0]?.kind, "stale");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  assert.equal(sim.receipts().length, 1);
});

test("a cancelled cue settles to direct and a stale voice event after skip is ignored", () => {
  const sim = new Sim();
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  const request = sim.lastEffect("cue.request");
  sim.fact({ type: "cue.settled", opId: request.opId, cueId: request.binding.cueId, outcome: "timed-out", error: null });
  assert.equal(sim.snap.transition?.mode, "direct");
  assert.equal(sim.snap.voice, null);
  assert.ok(!sim.snap.pending.some((p) => p.kind === "cue"));
  sim.resolve(b!);
  sim.deck(a!, { kind: "ended" });
  assert.equal(sim.snap.program?.item.itemId, b);
});

test("failures are terminal and auto-advance is bounded", () => {
  const sim = new Sim({ maxConsecutiveFailures: 2 }, { djEnabled: false });
  const [a, b, c] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  const request = sim.lastEffect("prepare.start", (e) => e.itemId === a);
  sim.fact({ type: "prepare.settled", opId: request.opId, itemId: a!, outcome: "failed", error: { class: "unavailable", code: "not_found" } });
  assert.equal(sim.snap.program?.item.itemId, b, "advanced after first failure");

  sim.resolve(b!);
  sim.deck(b!, { kind: "error", error: { class: "invalid", code: "decode" } });
  assert.equal(sim.snap.program, null, "stopped after reaching the failure bound");
  assert.equal(sim.snap.transport, "failed");
  assert.deepEqual(sim.snap.history.map((h) => [h.item.itemId, h.outcome, h.started]), [
    [a, "failed", false],
    [b, "failed", false]
  ]);
  assert.deepEqual(sim.snap.queue.map((e) => e.item.itemId), [c]);
  assert.deepEqual(sim.snap.pending, []);
  assert.equal(sim.receipts().length, 0);

  sim.cmd({ type: "resume" });
  sim.startProgram(c!);
  assert.equal(sim.snap.transport, "playing");
});

test("a resolver returning a different catalog entry is treated as a failure", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  const request = sim.lastEffect("prepare.start");
  sim.fact({ type: "prepare.resolved", opId: request.opId, itemId: a!, media: media(track("not-a")) });
  assert.equal(sim.snap.history[0]?.outcome, "failed");
  assert.equal(sim.snap.program, null);
  assert.equal(sim.effects("deck.load").length, 0);
});

test("an expired cached handle is re-resolved instead of used for a new load", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!, { expiresAt: sim.now + 1000 });
  sim.cmd({ type: "stop" });
  sim.tick(5000);
  const loads = sim.effects("deck.load").length;
  sim.cmd({ type: "resume" });
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.equal(sim.effects("deck.load").length, loads, "expired handle not loaded");
  const refresh = sim.lastEffect("prepare.start", (e) => e.itemId === b);
  assert.equal(refresh.purpose, "refresh");
  assert.equal(refresh.previousRevision, "rev-b-1");
  sim.resolve(b!);
  assert.equal(sim.effects("deck.load").length, loads + 1);
});
