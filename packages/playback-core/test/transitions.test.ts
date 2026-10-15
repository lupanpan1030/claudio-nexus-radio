import assert from "node:assert/strict";
import test from "node:test";
import { cueAsset, Sim } from "./harness.js";
import type { CoreConfig } from "../src/index.js";

function setup(config: Partial<CoreConfig> = {}) {
  const sim = new Sim(config);
  const [a, b, c] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: false });
  return { sim, a: a!, b: b!, c: c! };
}

test("sequential talk: A ends → voice speaks → B starts; subtitles follow voice then B", () => {
  const { sim, a, b } = setup();
  assert.equal(sim.snap.transition?.mode, "sequential-talk");
  sim.cueReady();
  const voiceLoad = sim.lastEffect("voice.load");
  assert.equal(sim.effects("voice.play").length, 0, "loaded, not spoken yet");

  sim.deck(a, { kind: "ended" });
  assert.equal(sim.snap.transition?.phase, "talking");
  assert.equal(sim.lastEffect("voice.play").voiceLoadId, voiceLoad.voiceLoadId);
  assert.equal(sim.snap.voice?.status, "starting", "asked to play, not yet speaking");
  assert.notEqual(sim.snap.display.kind, "voice", "subtitles wait for the voice to really play");
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.voice?.status, "speaking");
  assert.equal(sim.snap.display.kind, "voice");
  assert.equal(sim.snap.transport, "playing");
  assert.equal(sim.snap.program?.item.itemId, a, "B is not program while the DJ talks");

  const mark = sim.mark();
  sim.voice({ kind: "ended" });
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.ok(sim.effects("deck.play", mark).some((e) => e.loadId === sim.loadOf(b).loadId));
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.display.kind, "music");
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
});

test("late TTS: window passes without a cue → direct hand-over, late cue is rejected", () => {
  const { sim, a, b } = setup();
  const request = sim.lastEffect("cue.request");
  const mark = sim.mark();
  sim.deck(a, { kind: "ended" });
  assert.ok(sim.effects("operation.cancel", mark).some((e) => e.opId === request.opId), "pending narration aborted");
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.ok(sim.last!.notes.some((n) => n.reason.includes("narration dropped")));

  const late = sim.fact({ type: "cue.ready", opId: request.opId, cueId: request.binding.cueId, transitionId: request.binding.transitionId, asset: cueAsset() });
  assert.equal(late.notes[0]?.kind, "stale");
  assert.equal(sim.effects("voice.load").length, 0);
  assert.equal(sim.effects("voice.play").length, 0);
});

test("a voice asset that is not yet playable at the window is dropped, not waited for", () => {
  const { sim, a, b } = setup();
  sim.cueReady(cueAsset(), { playable: false });
  const voiceLoad = sim.lastEffect("voice.load");
  const mark = sim.mark();
  sim.deck(a, { kind: "ended" });
  assert.ok(sim.effects("voice.stop", mark).some((e) => e.voiceLoadId === voiceLoad.voiceLoadId));
  assert.equal(sim.effects("voice.play", mark).length, 0);
  assert.equal(sim.snap.program?.item.itemId, b);
});

test("a repeated ended for A while the DJ talks does not advance twice", () => {
  const { sim, a } = setup();
  sim.cueReady();
  sim.deck(a, { kind: "ended" });
  const again = sim.deck(a, { kind: "ended" });
  assert.equal(again.notes[0]?.kind, "duplicate");
  assert.equal(sim.snap.transition?.phase, "talking");
  assert.equal(sim.snap.program?.item.itemId, a);
});

test("pause while the DJ talks pauses the voice; resume continues the same cue", () => {
  const { sim, a } = setup();
  sim.cueReady();
  sim.deck(a, { kind: "ended" });
  sim.voice({ kind: "playing", positionMs: 0 });
  const voiceLoad = sim.lastEffect("voice.load");

  const mark = sim.mark();
  sim.cmd({ type: "pause" });
  assert.deepEqual(sim.effects("voice.pause", mark).map((e) => e.voiceLoadId), [voiceLoad.voiceLoadId]);
  assert.equal(sim.effects("deck.play", mark).length, 0);
  assert.equal(sim.snap.transport, "paused");

  const resumeMark = sim.mark();
  sim.cmd({ type: "resume" });
  assert.deepEqual(sim.effects("voice.play", resumeMark).map((e) => e.voiceLoadId), [voiceLoad.voiceLoadId]);
  assert.equal(sim.effects("voice.load", resumeMark).length, 0, "no reload → no restart from zero");
  assert.equal(sim.effects("cue.request", resumeMark).length, 0);
  assert.equal(sim.effects("deck.play", resumeMark).length, 0, "ended A is not restarted");
});

test("pause before the window keeps the waiting cue from starting", () => {
  const { sim } = setup();
  sim.cueReady();
  sim.cmd({ type: "pause" });
  // While paused A cannot reach its end; even a stray voice playing is silenced.
  const mark = sim.mark();
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.effects("voice.pause", mark).length, 1);
  assert.equal(sim.snap.voice?.status, "ready");
});

test("seek cancels a ready cue; a later normal transition may reuse the unspoken asset", () => {
  const { sim, a } = setup();
  sim.cueReady();
  const oldTransition = sim.snap.transition!.transitionId;
  const oldVoice = sim.lastEffect("voice.load");
  const requestsBefore = sim.effects("cue.request").length;

  const mark = sim.mark();
  sim.cmd({ type: "seek", positionMs: 30_000 });
  assert.ok(sim.effects("voice.stop", mark).some((e) => e.voiceLoadId === oldVoice.voiceLoadId));
  assert.ok(sim.effects("deck.seek", mark).some((e) => e.loadId === sim.loadOf(a).loadId && e.positionMs === 30_000));
  const next = sim.snap.transition!;
  assert.notEqual(next.transitionId, oldTransition, "new transition identity");
  assert.notEqual(next.cueId, oldVoice.cueId, "new cue identity");
  assert.equal(sim.effects("cue.request").length, requestsBefore, "unspoken asset reused, not regenerated");
  assert.equal(sim.snap.voice?.status, "ready");
  assert.equal(sim.effects("voice.play", mark).length, 0, "nothing replayed because of the seek");
});

test("seek after the voice started cancels it and never re-speaks that hand-over", () => {
  const { sim, a, b } = setup();
  sim.cueReady();
  sim.deck(a, { kind: "ended" });
  sim.voice({ kind: "playing", positionMs: 0 });

  const mark = sim.mark();
  sim.cmd({ type: "seek", positionMs: 10_000 });
  assert.equal(sim.effects("voice.stop", mark).length, 1);
  assert.ok(sim.effects("deck.play", mark).some((e) => e.loadId === sim.loadOf(a).loadId), "A plays again from the seek point");
  assert.equal(sim.snap.transition?.mode, "direct");
  assert.equal(sim.snap.voice, null);
  assert.equal(sim.snap.display.kind, "music");

  sim.deck(a, { kind: "playing", positionMs: 10_000 });
  const endMark = sim.mark();
  sim.deck(a, { kind: "ended" });
  assert.equal(sim.effects("voice.play", endMark).length, 0);
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.equal(sim.receipts().length, 1, "A not recorded again after seek/replay");
});

test("seek into the crossfade window: no catch-up voice, neither now nor on the media facts that follow", () => {
  const { sim, a, b } = setup({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 150_000, rate: 1 });
  const oldTransition = sim.snap.transition!.transitionId;
  const oldVoice = sim.lastEffect("voice.load");
  const requestsBefore = sim.effects("cue.request").length;

  const mark = sim.mark();
  sim.cmd({ type: "seek", positionMs: 195_000 });
  assert.ok(sim.effects("voice.stop", mark).some((e) => e.voiceLoadId === oldVoice.voiceLoadId));
  assert.notEqual(sim.snap.transition?.transitionId, oldTransition);
  assert.equal(sim.snap.transition?.mode, "direct", "window at 192 s was jumped over");
  assert.equal(sim.snap.voice, null);
  assert.equal(sim.effects("voice.load", mark).length, 0, "skipped window does not even preload a voice");

  // What a real runtime reports next: the old voice element, A's seek, B ready, time passing.
  assert.equal(sim.fact({ type: "voice.media", cueId: oldVoice.cueId, voiceLoadId: oldVoice.voiceLoadId, event: { kind: "can-play", through: true } }).notes[0]?.kind, "stale");
  sim.deck(a, { kind: "seeked", positionMs: 195_000 });
  sim.deck(a, { kind: "playing", positionMs: 195_000 });
  sim.deck(b, { kind: "can-play", through: true });
  sim.deck(a, { kind: "time", positionMs: 197_000, rate: 1 });
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transition?.phase, "planned", "a stray B playing is not a crossfade");
  assert.equal(sim.snap.program?.item.itemId, a);
  sim.deck(a, { kind: "time", positionMs: 199_500, rate: 1 });
  sim.deck(a, { kind: "ended" });
  sim.deck(b, { kind: "playing", positionMs: 0 });

  assert.equal(sim.snap.program?.item.itemId, b, "direct hand-over at A's end");
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
  assert.equal(sim.effects("voice.play", mark).length, 0, "nothing spoken for the skipped window");
  assert.equal(sim.effects("cue.request").length, requestsBefore + 1, "only B→C asks for new narration");
  assert.notEqual(sim.lastEffect("cue.request").binding.fromItemId, a);
});

test("seek into the window and back before it: reaching the window by playing narrates once under a new identity", () => {
  const { sim, a, b } = setup({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  sim.cueReady();
  const oldVoice = sim.lastEffect("voice.load");
  const requestsBefore = sim.effects("cue.request").length;
  const start = sim.mark();

  sim.cmd({ type: "seek", positionMs: 195_000 });
  const skipped = sim.snap.transition!;
  assert.equal(skipped.mode, "direct");
  sim.deck(a, { kind: "seeked", positionMs: 195_000 });

  sim.cmd({ type: "seek", positionMs: 100_000 });
  const replanned = sim.snap.transition!;
  assert.notEqual(replanned.transitionId, skipped.transitionId);
  assert.equal(replanned.mode, "talk-over-crossfade", "window is ahead again");
  assert.notEqual(replanned.cueId, oldVoice.cueId);
  assert.equal(sim.effects("cue.request").length, requestsBefore, "unspoken asset reused, not regenerated");
  const newVoice = sim.lastEffect("voice.load");
  assert.notEqual(newVoice.voiceLoadId, oldVoice.voiceLoadId);
  assert.equal(newVoice.cueId, replanned.cueId);

  sim.deck(a, { kind: "seeked", positionMs: 100_000 });
  sim.voice({ kind: "can-play", through: true });
  sim.deck(a, { kind: "time", positionMs: 150_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "planned");
  assert.equal(sim.effects("voice.play", start).length, 0);
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling", "window reached by playing");
  sim.deck(b, { kind: "playing", positionMs: 0 });

  const plays = sim.effects("voice.play", start);
  assert.equal(plays.length, 1);
  assert.equal(plays[0]?.voiceLoadId, newVoice.voiceLoadId);
  assert.equal(plays[0]?.cueId, replanned.cueId);
  sim.voice({ kind: "playing", positionMs: 0 });
  sim.voice({ kind: "ended" });
  sim.deck(a, { kind: "ended" });
  assert.equal(sim.effects("voice.play", start).length, 1, "spoken exactly once");
});

test("sequential talk: a seek short of A's end keeps the window ahead; a seek to the end skips it", () => {
  const ahead = setup();
  ahead.sim.cueReady();
  const aheadMark = ahead.sim.mark();
  ahead.sim.cmd({ type: "seek", positionMs: 199_000 });
  assert.equal(ahead.sim.snap.transition?.mode, "sequential-talk");
  ahead.sim.voice({ kind: "can-play", through: true });
  ahead.sim.deck(ahead.a, { kind: "playing", positionMs: 199_000 });
  assert.equal(ahead.sim.effects("voice.play", aheadMark).length, 0);
  ahead.sim.deck(ahead.a, { kind: "ended" });
  assert.equal(ahead.sim.snap.transition?.phase, "talking");
  assert.equal(ahead.sim.effects("voice.play", aheadMark).length, 1);

  const past = setup();
  past.sim.cueReady();
  const pastMark = past.sim.mark();
  past.sim.cmd({ type: "seek", positionMs: 250_000 });
  assert.equal(past.sim.snap.transition?.mode, "direct", "clamped to the end = window jumped over");
  past.sim.deck(past.a, { kind: "ended" });
  assert.equal(past.sim.snap.program?.item.itemId, past.b);
  assert.equal(past.sim.effects("voice.play", pastMark).length, 0);
});

test("a voice that already spoke is not re-spoken after seeking back before the crossfade window", () => {
  const { sim, a, b } = setup({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  sim.cueReady();
  sim.deck(a, { kind: "ended" });
  assert.equal(sim.snap.transition?.phase, "talking", "window missed: spoke sequentially");
  sim.voice({ kind: "playing", positionMs: 0 });

  const mark = sim.mark();
  sim.cmd({ type: "seek", positionMs: 100_000 });
  assert.equal(sim.snap.transition?.mode, "direct");
  sim.deck(a, { kind: "playing", positionMs: 100_000 });
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  sim.deck(a, { kind: "time", positionMs: 199_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "planned", "no crossfade without narration");
  sim.deck(a, { kind: "ended" });
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.equal(sim.effects("voice.play", mark).length, 0);
  assert.equal(sim.effects("voice.load", mark).length, 0);
});

test("a narration asset that arrives already expired is not loaded; the hand-over goes direct", () => {
  const { sim, a, b } = setup();
  const asset = cueAsset();
  const mark = sim.mark();
  sim.cueReady({ ...asset, voice: { ...asset.voice, stream: { ...asset.voice.stream, expiresAt: sim.now } } }, { playable: false });
  assert.equal(sim.effects("voice.load", mark).length, 0, "expired handle never backs a new load");
  assert.equal(sim.snap.transition?.mode, "direct");
  assert.equal(sim.snap.voice, null);
  sim.deck(a, { kind: "ended" });
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.equal(sim.effects("voice.play", mark).length, 0);
});

test("an unspoken asset that expired before reuse is requested anew, not reloaded", () => {
  const { sim } = setup();
  const asset = cueAsset();
  sim.cueReady({ ...asset, voice: { ...asset.voice, stream: { ...asset.voice.stream, expiresAt: sim.now + 10_000 } } });
  const requests = sim.effects("cue.request").length;
  sim.tick(20_000);
  const mark = sim.mark();
  sim.cmd({ type: "seek", positionMs: 30_000 });
  assert.equal(sim.effects("voice.load", mark).length, 0);
  assert.equal(sim.effects("cue.request").length, requests + 1, "new cue generated for the new transition");
  assert.equal(sim.snap.voice?.status, "requested");
});

test("skip during the DJ stops the voice immediately and starts B", () => {
  const { sim, a, b } = setup();
  sim.cueReady();
  sim.deck(a, { kind: "ended" });
  sim.voice({ kind: "playing", positionMs: 500 });
  const mark = sim.mark();
  sim.cmd({ type: "next" });
  assert.equal(sim.effects("voice.stop", mark).length, 1);
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.equal(sim.snap.history.at(-1)?.outcome, "played", "A had finished");
  const stale = sim.voice({ kind: "ended" });
  assert.equal(stale.notes[0]?.kind, "stale");
});

test("turning the DJ off mid-voice stops it and hands over to B", () => {
  const { sim, a, b } = setup();
  sim.cueReady();
  sim.deck(a, { kind: "ended" });
  sim.voice({ kind: "playing", positionMs: 0 });
  sim.cmd({ type: "set-dj-enabled", enabled: false });
  assert.equal(sim.effects("voice.stop").length, 1);
  assert.equal(sim.snap.program?.item.itemId, b);
});

test("voice playback failure continues the music", () => {
  const { sim, a, b } = setup();
  sim.cueReady();
  sim.deck(a, { kind: "ended" });
  sim.voice({ kind: "error", error: { class: "unavailable", code: "decode" } });
  assert.equal(sim.snap.program?.item.itemId, b);
});

test("talk over crossfade: B prerolls silently, commits on its own playing, A ducks then fades", () => {
  const { sim, a, b, c } = setup({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 150_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "planned");
  assert.equal(sim.snap.transition?.anchorMs, 192_000);

  const prerollMark = sim.mark();
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  const bLoad = sim.loadOf(b);
  assert.ok(sim.effects("deck.play", prerollMark).some((e) => e.loadId === bLoad.loadId));
  assert.equal(sim.snap.decks[bLoad.deck].gain, 0);
  assert.equal(sim.receipts().length, 1, "preroll is not program output");
  assert.equal(sim.effects("voice.play", prerollMark).length, 0, "voice waits for B to really play");

  const commitMark = sim.mark();
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transition?.phase, "overlapping");
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
  assert.equal(sim.effects("voice.play", commitMark).length, 1);
  const aDeck = sim.loadOf(a).deck;
  assert.equal(sim.snap.decks[aDeck].role, "outgoing");
  assert.equal(sim.snap.decks[aDeck].gain, 0.3);
  assert.equal(sim.snap.decks[bLoad.deck].gain, 0.3);

  sim.voice({ kind: "playing", positionMs: 0 });
  sim.voice({ kind: "ended" });
  assert.equal(sim.snap.decks[bLoad.deck].gain, 1, "B back to full (relative to user volume)");
  assert.equal(sim.snap.decks[aDeck].gain, 0);
  sim.deck(a, { kind: "ended" });
  assert.equal(sim.snap.decks[aDeck].role, "idle", "outgoing released after its end");
  assert.equal(sim.snap.transition?.fromItemId, b, "next hand-over planned only after the overlap completed");
  assert.equal(sim.snap.transition?.toItemId, c);
  sim.resolve(c);
  assert.equal(sim.loadOf(c).deck, aDeck, "freed deck preheats C");
  assert.equal(sim.snap.decks[aDeck].role, "standby");
});

test("crossfade preroll rejected: A keeps playing and the hand-over degrades to sequential talk", () => {
  const { sim, a, b } = setup({ preferredTalkMode: "talk-over-crossfade" });
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 195_000, rate: 1 });
  sim.deck(b, { kind: "play-rejected", reason: "not-allowed" });
  assert.equal(sim.snap.transition?.phase, "planned");
  assert.equal(sim.snap.transition?.mode, "sequential-talk");
  assert.equal(sim.snap.program?.item.itemId, a);
  sim.deck(a, { kind: "ended" });
  assert.equal(sim.snap.transition?.phase, "talking");
});

test("A ends during a preroll and B then fails: the hand-over still completes", () => {
  const { sim, a, b, c } = setup({ preferredTalkMode: "talk-over-crossfade" });
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 199_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  sim.deck(a, { kind: "ended" });
  assert.equal(sim.snap.transition?.phase, "prerolling", "waiting for B to confirm");
  sim.deck(b, { kind: "error", error: { class: "invalid", code: "decode" } });
  assert.equal(sim.snap.transition?.phase, "talking", "falls back to talking instead of stalling");
  sim.voice({ kind: "playing", positionMs: 0 });
  sim.voice({ kind: "ended" });
  assert.equal(sim.snap.program?.item.itemId, b, "B retried once as program");
  const retry = sim.lastEffect("deck.load", (e) => e.itemId === b);
  sim.fact({ type: "deck.media", deck: retry.deck, loadId: retry.loadId, event: { kind: "error", error: { class: "invalid", code: "decode" } } });
  assert.equal(sim.snap.program?.item.itemId, c, "terminal failure advances");
  assert.equal(sim.snap.history.find((h) => h.item.itemId === b)?.outcome, "failed");
});

test("unknown A duration: no invented anchor, crossfade degrades to talking at the end", () => {
  const sim = new Sim({ preferredTalkMode: "talk-over-crossfade" });
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.resolve(a!, { durationMs: null });
  sim.deck(a!, { kind: "playing", positionMs: 0 });
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady();
  sim.deck(a!, { kind: "time", positionMs: 600_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "planned");
  assert.equal(sim.snap.transition?.anchorMs, null);
  assert.equal(sim.snap.decks[sim.loadOf(a!).deck].duration.kind, "unknown");
  sim.deck(a!, { kind: "ended" });
  assert.equal(sim.snap.transition?.phase, "talking");
  assert.equal(sim.snap.transition?.mode, "sequential-talk");
});

test("skip during a crossfade preroll promotes the prerolling B without reloading or speaking", () => {
  const { sim, a, b } = setup({ preferredTalkMode: "talk-over-crossfade" });
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 195_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  const bLoad = sim.loadOf(b);
  const loads = sim.effects("deck.load").length;

  const mark = sim.mark();
  sim.cmd({ type: "next" });
  assert.equal(sim.effects("voice.stop", mark).length, 1, "loaded voice released");
  assert.equal(sim.effects("voice.play", mark).length, 0);
  assert.equal(sim.effects("deck.load").length, loads, "B promoted in place");
  assert.equal(sim.snap.decks[bLoad.deck].role, "program");
  assert.equal(sim.snap.decks[bLoad.deck].gain, 1);
  assert.equal(sim.snap.decks[sim.loadOf(a).deck].role, "idle");

  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
  assert.equal(sim.snap.transition?.fromItemId, b);
});
