import assert from "node:assert/strict";
import test from "node:test";
import type { CueAsset } from "@claudio/contracts";
import { toSnapshot, type CoreConfig } from "../src/index.js";
import { cueAsset, Sim } from "./harness.js";

/** A → (spoken sequential narration) → B confirmed playing; B→C planned with its cue requested. */
function spokenIntoB(config: Partial<CoreConfig> = {}, asset: CueAsset = cueAsset()) {
  const sim = new Sim(config);
  const [a, b, c] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady(asset);
  const autoLoad = sim.lastEffect("voice.load");
  sim.naturalEnd(a!);
  sim.voice({ kind: "playing", positionMs: 0 });
  sim.voiceNaturalEnd();
  sim.deck(b!, { kind: "playing", positionMs: 0 });
  return { sim, a: a!, b: b!, c: c!, autoLoad };
}

function gainsOf(sim: Sim, from: number, loadId: string): number[] {
  return sim.effects("deck.gain", from).filter((e) => e.loadId === loadId).map((e) => e.gain);
}

test("narration spoken into B stays replayable on B; replay → stop → replay → natural end, never a receipt", () => {
  const { sim, a, b, autoLoad } = spokenIntoB();
  const bLoad = sim.loadOf(b).loadId;
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.deepEqual(sim.snap.narration.replay, { available: true });
  assert.equal(sim.snap.narration.retained?.itemId, b, "belongs to B, not to the retired A");
  assert.equal(sim.snap.narration.retained?.cueId, autoLoad.cueId);
  assert.equal(sim.snap.narration.retained?.spokenMs, 4000);
  const spokenPairs = [...sim.state.spokenPairs];
  const requests = sim.effects("cue.request").length;

  const first = sim.mark();
  sim.cmd({ type: "voice.replay" });
  const load1 = sim.lastEffect("voice.load");
  assert.notEqual(load1.cueId, autoLoad.cueId, "a new cue identity");
  assert.notEqual(load1.voiceLoadId, autoLoad.voiceLoadId);
  assert.equal(load1.asset, autoLoad.asset, "same immutable asset, shared by reference");
  assert.deepEqual(sim.effects("voice.play", first).map((e) => e.voiceLoadId), [load1.voiceLoadId]);
  assert.deepEqual(gainsOf(sim, first, bLoad), [0.3], "program ducked under the manual voice");
  assert.equal(sim.snap.voice?.origin, "manual");
  assert.equal(sim.snap.voice?.status, "starting");
  assert.deepEqual(sim.snap.narration.replay, { available: false, reason: "voice-active" });
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.voice?.status, "speaking");
  assert.equal(sim.snap.display.kind, "music", "lyrics keep following B; the DJ panel reads voice");
  assert.equal(sim.snap.transport, "playing");

  const stop = sim.mark();
  sim.cmd({ type: "voice.stop" });
  assert.deepEqual(sim.effects("voice.stop", stop).map((e) => e.voiceLoadId), [load1.voiceLoadId]);
  assert.deepEqual(gainsOf(sim, stop, bLoad), [1], "duck released to the latest user volume");
  assert.equal(sim.snap.voice?.origin, "transition", "the voice channel went back to B→C narration");
  assert.deepEqual(sim.snap.narration.replay, { available: true }, "stop does not use up the replay");

  sim.cmd({ type: "voice.replay" });
  const load2 = sim.lastEffect("voice.load");
  assert.notEqual(load2.cueId, load1.cueId);
  assert.notEqual(load2.voiceLoadId, load1.voiceLoadId);
  sim.voice({ kind: "playing", positionMs: 0 });
  const end = sim.mark();
  sim.voiceNaturalEnd();
  assert.deepEqual(gainsOf(sim, end, bLoad), [1]);
  assert.deepEqual(sim.snap.narration.replay, { available: true });

  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b], "manual voice never adds a started receipt");
  assert.deepEqual(sim.state.spokenPairs, spokenPairs, "automatic spoken pairs untouched");
  assert.equal(sim.effects("cue.request").length, requests, "no network generation for a replay");
});

test("first track has no narration to replay; nothing is fabricated", () => {
  const sim = new Sim();
  const [a] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  assert.equal(sim.snap.narration.retained, null);
  assert.deepEqual(sim.snap.narration.replay, { available: false, reason: "no-narration" });
  const mark = sim.mark();
  sim.cmd({ type: "voice.replay" });
  assert.equal(sim.since(mark).length, 0);
  assert.ok(sim.last!.notes.some((n) => n.kind === "ignored" && n.reason.includes("no-narration")));
});

test("replay waits for B to really start, and refuses an expired asset", () => {
  const base = cueAsset();
  const expiring = { ...base, voice: { ...base.voice, stream: { ...base.voice.stream, expiresAt: 400_000 } } };
  const sim = new Sim();
  const [a, b] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady(expiring);
  sim.naturalEnd(a!);
  sim.voice({ kind: "playing", positionMs: 0 });
  sim.voiceNaturalEnd();
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.deepEqual(sim.snap.narration.replay, { available: false, reason: "not-started" });
  sim.deck(b!, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.snap.narration.replay, { available: true });
  assert.equal(sim.snap.narration.retained?.expiresAt, 400_000);

  assert.deepEqual(toSnapshot(sim.state, 400_000).narration.replay, { available: false, reason: "expired" }, "judged at the caller's clock");
  sim.now = 400_001;
  sim.deck(b!, { kind: "time", positionMs: 1000, rate: 1 });
  assert.deepEqual(sim.snap.narration.replay, { available: false, reason: "expired" }, "default clock = latest input");
  const mark = sim.mark();
  sim.cmd({ type: "voice.replay" });
  assert.equal(sim.effects("voice.load", mark).length, 0);
  assert.ok(sim.last!.notes.some((n) => n.reason.includes("expired")));
});

test("B changes recording: retained narration is dropped, a running replay stops, replay is refused", () => {
  const { sim, b } = spokenIntoB({ maxRefreshAttempts: 2 });
  sim.cmd({ type: "voice.replay" });
  sim.voice({ kind: "playing", positionMs: 0 });
  const manual = sim.lastEffect("voice.load");

  // Same-source refresh keeps everything.
  sim.deck(b, { kind: "error", error: { class: "expired", code: "stream_expired" } });
  sim.resolve(b);
  assert.equal(sim.snap.voice?.cueId, manual.cueId, "same recording: the replay goes on");
  assert.equal(sim.snap.narration.retained?.itemId, b);
  assert.equal(sim.lastEffect("deck.gain", (e) => e.loadId === sim.loadOf(b).loadId).gain, 0.3, "reloaded program stays ducked");

  const mark = sim.mark();
  sim.deck(b, { kind: "error", error: { class: "expired", code: "stream_expired" } });
  sim.resolve(b, { revision: "rev-b-2", recording: "rec-b-other" });
  assert.ok(sim.effects("voice.stop", mark).some((e) => e.voiceLoadId === manual.voiceLoadId), "replay of the old recording stops");
  assert.notEqual(sim.snap.voice?.origin, "manual");
  assert.equal(sim.snap.narration.retained, null);
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.snap.narration.replay, { available: false, reason: "no-narration" });
  const again = sim.mark();
  sim.cmd({ type: "voice.replay" });
  assert.equal(sim.effects("voice.load", again).length, 0);
});

test("a pending automatic cue gives way and is reused after the replay: no second request, no second slot", () => {
  const { sim, b } = spokenIntoB();
  const request = sim.lastEffect("cue.request");
  assert.equal(request.binding.fromItemId, b);
  const requests = sim.effects("cue.request").length;

  const mark = sim.mark();
  sim.cmd({ type: "voice.replay" });
  assert.equal(sim.effects("operation.cancel", mark).length, 0, "generation keeps running");
  assert.ok(sim.snap.pending.some((op) => op.opId === request.opId));
  assert.equal(sim.snap.voice?.origin, "manual");
  sim.voice({ kind: "playing", positionMs: 0 });

  // Asset arrives while the manual voice speaks: not loaded over it.
  const ready = sim.mark();
  sim.fact({ type: "cue.ready", opId: request.opId, cueId: request.binding.cueId, transitionId: request.binding.transitionId, asset: cueAsset("下一首") });
  assert.equal(sim.effects("voice.load", ready).length, 0);
  assert.equal(sim.snap.voice?.origin, "manual");

  const end = sim.mark();
  sim.voiceNaturalEnd();
  const reload = sim.effects("voice.load", end);
  assert.equal(reload.length, 1);
  assert.equal(reload[0]!.asset.script.text, "下一首", "the generated asset, reused");
  assert.equal(sim.effects("cue.request").length, requests, "no extra generation");
  assert.equal(sim.snap.voice?.origin, "transition");
  assert.equal(sim.snap.voice?.status, "ready");
  assert.equal(sim.snap.transition?.cueId, reload[0]!.cueId);
});

test("a parked request that is still generating when the replay ends continues as the transition cue", () => {
  const { sim } = spokenIntoB();
  const request = sim.lastEffect("cue.request");
  sim.cmd({ type: "voice.replay" });
  sim.voice({ kind: "playing", positionMs: 0 });
  sim.cmd({ type: "voice.stop" });
  assert.equal(sim.snap.voice?.cueId, request.binding.cueId, "same cue identity, same operation");
  assert.equal(sim.snap.voice?.status, "requested");
  sim.cueReady(cueAsset("下一首"));
  assert.equal(sim.snap.voice?.status, "ready");
  assert.equal(sim.effects("cue.request").filter((e) => e.binding.fromItemId === request.binding.fromItemId).length, 1);
});

test("a preloaded automatic cue gives way and is reloaded from the same asset", () => {
  const { sim, c } = spokenIntoB();
  sim.resolve(c);
  sim.cueReady(cueAsset("C 来了"));
  const autoLoad = sim.lastEffect("voice.load");
  const requests = sim.effects("cue.request").length;

  const mark = sim.mark();
  sim.cmd({ type: "voice.replay" });
  assert.ok(sim.effects("voice.stop", mark).some((e) => e.voiceLoadId === autoLoad.voiceLoadId), "preloaded voice released for the manual one");
  sim.voice({ kind: "playing", positionMs: 0 });
  const end = sim.mark();
  sim.voiceNaturalEnd();
  const reload = sim.effects("voice.load", end);
  assert.equal(reload.length, 1);
  assert.equal(reload[0]!.asset, autoLoad.asset);
  assert.equal(sim.effects("cue.request").length, requests);
});

test("the program ending under a manual replay stops it and hands over directly; the next item inherits nothing", () => {
  const { sim, b, c } = spokenIntoB();
  sim.resolve(c);
  sim.deck(c, { kind: "can-play", through: true });
  sim.cmd({ type: "voice.replay" });
  sim.voice({ kind: "playing", positionMs: 0 });
  const manual = sim.lastEffect("voice.load");

  const mark = sim.mark();
  sim.naturalEnd(b);
  assert.ok(sim.effects("voice.stop", mark).some((e) => e.voiceLoadId === manual.voiceLoadId));
  assert.equal(sim.effects("voice.play", mark).length, 0, "no automatic narration starts mid-hand-over");
  assert.equal(sim.snap.program?.item.itemId, c);
  assert.ok(sim.effects("deck.play", mark).some((e) => e.loadId === sim.loadOf(c).loadId));
  sim.deck(c, { kind: "playing", positionMs: 0 });
  assert.equal(sim.receipts().filter((e) => e.receipt.itemId === c).length, 1);
  assert.equal(sim.snap.narration.retained, null);
  assert.deepEqual(sim.snap.narration.replay, { available: false, reason: "no-narration" });
});

test("listener voice pause survives a transport pause/resume; the music returns to full gain", () => {
  const { sim, b } = spokenIntoB();
  const bLoad = sim.loadOf(b).loadId;
  sim.cmd({ type: "voice.replay" });
  const manual = sim.lastEffect("voice.load");
  sim.voice({ kind: "playing", positionMs: 0 });

  let mark = sim.mark();
  sim.cmd({ type: "voice.pause" });
  assert.deepEqual(sim.effects("voice.pause", mark).map((e) => e.voiceLoadId), [manual.voiceLoadId]);
  assert.equal(sim.effects("deck.pause", mark).length, 0, "music keeps playing");
  assert.deepEqual(gainsOf(sim, mark, bLoad), [1]);
  assert.equal(sim.snap.voice?.pausedBy, "user");
  assert.equal(sim.snap.transport, "playing");
  sim.voice({ kind: "paused", positionMs: 500, atEnd: false, requested: true });

  sim.cmd({ type: "pause" });
  assert.equal(sim.snap.voice?.pausedBy, "user");
  mark = sim.mark();
  sim.cmd({ type: "resume" });
  assert.equal(sim.effects("voice.play", mark).length, 0, "transport resume does not resume a voice the listener paused");
  assert.ok(sim.effects("deck.play", mark).some((e) => e.loadId === bLoad));
  assert.deepEqual(gainsOf(sim, mark, bLoad), [1]);
  assert.equal(sim.snap.voice?.status, "paused");

  mark = sim.mark();
  sim.cmd({ type: "voice.resume" });
  assert.deepEqual(sim.effects("voice.play", mark).map((e) => e.voiceLoadId), [manual.voiceLoadId]);
  assert.deepEqual(gainsOf(sim, mark, bLoad), [0.3]);
  assert.equal(sim.snap.voice?.pausedBy, null);
});

test("transport pause holds a manual voice; voice.resume never resumes the transport", () => {
  const { sim, b } = spokenIntoB();
  const bLoad = sim.loadOf(b).loadId;
  sim.cmd({ type: "voice.replay" });
  const manual = sim.lastEffect("voice.load");
  sim.voice({ kind: "playing", positionMs: 0 });

  let mark = sim.mark();
  sim.cmd({ type: "pause" });
  assert.deepEqual(sim.effects("voice.pause", mark).map((e) => e.voiceLoadId), [manual.voiceLoadId]);
  assert.equal(sim.snap.voice?.pausedBy, "transport");
  assert.deepEqual(gainsOf(sim, mark, bLoad), [], "duck kept while everything is held");
  sim.cmd({ type: "voice.resume" });
  assert.ok(sim.last!.notes.some((n) => n.kind === "ignored"));

  mark = sim.mark();
  sim.cmd({ type: "resume" });
  assert.deepEqual(sim.effects("voice.play", mark).map((e) => e.voiceLoadId), [manual.voiceLoadId]);
  assert.deepEqual(gainsOf(sim, mark, bLoad), [0.3], "gain re-anchored at the duck");
  sim.voice({ kind: "playing", positionMs: 300 });

  // Listener pauses the voice, then the transport, then asks for the voice: it waits for the transport.
  sim.cmd({ type: "voice.pause" });
  sim.cmd({ type: "pause" });
  mark = sim.mark();
  sim.cmd({ type: "voice.resume" });
  assert.equal(sim.effects("voice.play", mark).length, 0);
  assert.equal(sim.effects("deck.play", mark).length, 0);
  assert.equal(sim.snap.transport, "paused");
  assert.equal(sim.snap.voice?.pausedBy, "transport");
  mark = sim.mark();
  sim.cmd({ type: "resume" });
  assert.deepEqual(sim.effects("voice.play", mark).map((e) => e.voiceLoadId), [manual.voiceLoadId]);
  assert.deepEqual(gainsOf(sim, mark, bLoad), [0.3]);
});

test("voice.pause during a sequential talk pauses the transport; voice.stop there hands over and keeps the narration for B", () => {
  const sim = new Sim();
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady();
  const auto = sim.lastEffect("voice.load");
  sim.naturalEnd(a!);
  sim.voice({ kind: "playing", positionMs: 0 });

  sim.cmd({ type: "voice.pause" });
  assert.equal(sim.snap.transport, "paused", "the voice is the program output here");
  assert.equal(sim.snap.voice?.pausedBy, "transport");
  sim.cmd({ type: "voice.resume" });
  assert.equal(sim.snap.transport, "paused", "voice.resume does not resume the transport");
  sim.cmd({ type: "resume" });
  assert.equal(sim.snap.voice?.status, "starting");
  sim.voice({ kind: "playing", positionMs: 900 });

  const mark = sim.mark();
  sim.cmd({ type: "voice.stop" });
  assert.ok(sim.effects("voice.stop", mark).some((e) => e.voiceLoadId === auto.voiceLoadId));
  assert.equal(sim.snap.program?.item.itemId, b);
  sim.deck(b!, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.snap.narration.replay, { available: true }, "stopped after it spoke: still replayable on B");
  sim.cmd({ type: "voice.replay" });
  assert.equal(sim.lastEffect("voice.load").asset, auto.asset);
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
});

test("an automatic cue stopped before it spoke is not retained", () => {
  const sim = new Sim();
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady();
  sim.naturalEnd(a!);
  assert.equal(sim.snap.voice?.status, "starting");
  sim.cmd({ type: "voice.stop" });
  sim.deck(b!, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.snap.narration.replay, { available: false, reason: "no-narration" });
});

test("cancelling the next transition early leaves the narration that introduced the program alone", () => {
  const { sim, b, c } = spokenIntoB();
  sim.cmd({ type: "remove", itemId: c });
  assert.equal(sim.snap.transition === null, true);
  assert.equal(sim.snap.narration.retained?.itemId, b);
  assert.deepEqual(sim.snap.narration.replay, { available: true });
  const [d] = sim.enqueue("d");
  assert.equal(sim.snap.transition?.toItemId, d);
  assert.deepEqual(sim.snap.narration.replay, { available: true });
});

test("skip/select/stop end a manual replay and the narration with its program", () => {
  const first = spokenIntoB();
  first.sim.cmd({ type: "voice.replay" });
  const manual = first.sim.lastEffect("voice.load");
  const mark = first.sim.mark();
  first.sim.cmd({ type: "next" });
  assert.ok(first.sim.effects("voice.stop", mark).some((e) => e.voiceLoadId === manual.voiceLoadId));
  assert.equal(first.sim.snap.program?.item.itemId, first.c);
  assert.equal(first.sim.snap.narration.retained, null);

  const second = spokenIntoB();
  second.sim.cmd({ type: "voice.replay" });
  second.sim.cmd({ type: "stop" });
  assert.equal(second.sim.snap.voice, null);
  assert.equal(second.sim.state.retainedNarration, null);
  assert.equal(second.sim.state.parkedCue, null);
  assert.deepEqual(second.sim.snap.pending, []);
});

test("manual voice rejected or failing releases the duck and leaves the replay available", () => {
  const { sim, b } = spokenIntoB();
  const bLoad = sim.loadOf(b).loadId;
  sim.cmd({ type: "voice.replay" });
  const mark = sim.mark();
  sim.rejectVoice("not-allowed");
  assert.deepEqual(gainsOf(sim, mark, bLoad), [1]);
  assert.equal(sim.snap.voice?.origin, "transition");
  assert.equal(sim.snap.transport, "playing", "a refused manual voice does not stop the music");
  assert.deepEqual(sim.snap.narration.replay, { available: true });
});

test("no automatic narration window opens while a manual replay holds the voice", () => {
  const { sim, b, c } = spokenIntoB({ preferredTalkMode: "talk-over-crossfade" });
  sim.resolve(c);
  sim.deck(c, { kind: "can-play", through: true });
  sim.cueReady(cueAsset("C 来了"));
  sim.cmd({ type: "voice.replay" });
  sim.voice({ kind: "playing", positionMs: 0 });
  const cLoad = sim.loadOf(c).loadId;

  let mark = sim.mark();
  sim.deck(b, { kind: "time", positionMs: 193_000, rate: 1 });
  assert.equal(sim.effects("deck.play", mark).filter((e) => e.loadId === cLoad).length, 0, "no preroll under the manual voice");
  assert.equal(sim.snap.transition?.phase, "planned");

  mark = sim.mark();
  sim.voiceNaturalEnd();
  assert.equal(sim.snap.transition?.phase, "planned", "reloaded voice is not playable yet");
  sim.voice({ kind: "can-play", through: true });
  sim.deck(b, { kind: "time", positionMs: 194_000, rate: 1 });
  assert.ok(sim.effects("deck.play", mark).some((e) => e.loadId === cLoad), "window still open: crossfade runs once the voice is free");
  assert.equal(sim.snap.transition?.phase, "prerolling");
});

test("turning DJ off keeps a manual replay but drops the parked narration request", () => {
  const { sim } = spokenIntoB();
  const request = sim.lastEffect("cue.request");
  sim.cmd({ type: "voice.replay" });
  const mark = sim.mark();
  sim.cmd({ type: "set-dj-enabled", enabled: false });
  assert.ok(sim.effects("operation.cancel", mark).some((e) => e.opId === request.opId));
  assert.equal(sim.effects("voice.stop", mark).length, 0);
  assert.equal(sim.snap.voice?.origin, "manual");
  sim.voice({ kind: "playing", positionMs: 0 });
  sim.voiceNaturalEnd();
  assert.equal(sim.snap.voice, null, "DJ off: nothing requested after the replay");
  assert.equal(sim.snap.transition?.mode, "direct");
});

test("retained narration and snapshot share the immutable asset and stay frozen", () => {
  const { sim } = spokenIntoB();
  const retained = sim.state.retainedNarration!;
  assert.ok(Object.isFrozen(retained) && Object.isFrozen(retained.asset));
  const before = sim.state;
  sim.cmd({ type: "voice.replay" });
  assert.equal(sim.state.retainedNarration, before.retainedNarration, "unchanged partition shared, not copied");
  assert.equal(sim.snap.narration.retained?.subtitle, retained.asset.script.subtitle);
  assert.equal(before.cue?.origin, "transition", "previous state untouched by the replay");
});
