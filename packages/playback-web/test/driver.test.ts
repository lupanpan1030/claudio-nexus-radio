import assert from "node:assert/strict";
import test from "node:test";
import { asId, type CueId, type DeckId, type LoadId, type PlayRequestId, type VoiceLoadId } from "@claudio/contracts";
import { createBrowserDriver, type DriverEffect, type MediaFact } from "../src/index.js";
import { FakeAudioContext, FakeMediaElement } from "./fake-dom.js";
import { ManualTimers, cueAsset, flush, media, track } from "./helpers.js";

async function setup(state: "running" | "suspended" = "running") {
  const timers = new ManualTimers();
  const ctx = new FakeAudioContext(state);
  const elements: FakeMediaElement[] = [];
  const facts: MediaFact[] = [];
  const driver = await createBrowserDriver({
    urls: { music: (h) => ({ url: `/m/${h}`, crossOrigin: null }), voice: (h) => ({ url: `/v/${h}`, crossOrigin: null }) },
    clock: () => timers.now,
    timers,
    document: null,
    createContext: () => ctx as unknown as AudioContext,
    createElement: () => {
      const element = new FakeMediaElement();
      elements.push(element);
      return element as unknown as HTMLAudioElement;
    },
    timeouts: { loadMs: 1_000, startMs: 2_000, stallMs: 3_000, unlockMs: 500 },
    timeFactIntervalMs: 0
  });
  driver.connect((fact) => facts.push(fact));
  const kinds = (loadId: string) => facts.filter((f) => f.type === "deck.media" && f.loadId === loadId).map((f) => f.event.kind);
  return { driver, ctx, elements, facts, timers, kinds };
}

const L = (id: string) => asId<LoadId>(id);
const load = (deck: DeckId, loadId: string, startAtMs = 0): DriverEffect => ({ type: "deck.load", deck, loadId: L(loadId), itemId: asId("item"), media: media(track(loadId)), startAtMs });
let playCounter = 0;
const deck = (type: "deck.play" | "deck.pause" | "deck.unload", d: DeckId, loadId: string): DriverEffect =>
  type === "deck.play" ? { type, deck: d, loadId: L(loadId), playId: asId<PlayRequestId>(`play-${++playCounter}`) } : { type, deck: d, loadId: L(loadId) };

test("each load gets a fresh element and source; the old element's queued events and play promise never reach the runtime", async () => {
  const { driver, ctx, elements, facts, kinds } = await setup();
  driver.execute(load("A", "L1"));
  elements[0]!.ready(12);
  elements[0]!.playMode = "pending";
  driver.execute(deck("deck.play", "A", "L1"));
  driver.execute(load("A", "L2")); // replaces L1 while its play() is pending
  const old = elements[0]!;
  assert.equal(old.src, "", "old element emptied");
  assert.ok(ctx.sources[0]!.disconnected > 0, "old source node disconnected");
  const before = facts.length;
  for (const type of ["playing", "pause", "timeupdate", "ended", "error"]) old.fire(type);
  await flush(); // the AbortError of the old play() settles here
  assert.equal(facts.length, before, "nothing from the replaced load, under any identity");
  elements[1]!.ready(12);
  assert.deepEqual(kinds("L2"), ["metadata", "can-play"]);
  assert.equal(ctx.sources.length, 2);
  assert.ok(elements.every((el) => el.tapped), "each element tapped exactly once (a second tap would throw)");
  assert.equal(driver.diagnostics().liveElements, 1);
});

test("play() resolving is not reported; only the element's playing event is", async () => {
  const { driver, elements, kinds } = await setup();
  driver.execute(load("A", "L1"));
  elements[0]!.ready(12);
  driver.execute(deck("deck.play", "A", "L1"));
  await flush();
  assert.deepEqual(kinds("L1"), ["metadata", "can-play"]);
  elements[0]!.fire("playing");
  assert.deepEqual(kinds("L1"), ["metadata", "can-play", "playing"]);
});

test("pause classification: own pause answers requested; OS pause is external; end-of-media pause carries atEnd", async () => {
  const { driver, elements, facts } = await setup();
  driver.execute(load("A", "L1"));
  const el = elements[0]!;
  el.ready(12);
  el.playMode = "pending";
  driver.execute(deck("deck.play", "A", "L1"));
  driver.execute(deck("deck.pause", "A", "L1"));
  await flush();
  assert.equal(facts.some((f) => f.event.kind === "play-rejected"), false, "AbortError from our own pause is not a rejection");
  el.fire("pause");
  // External pause while playing.
  el.paused = false;
  el.fire("playing");
  el.paused = true;
  el.fire("pause");
  // Natural end.
  el.paused = false;
  el.fire("playing");
  el.paused = true;
  el.ended = true;
  el.fire("pause");
  el.fire("ended");
  const pauses = facts.filter((f) => f.event.kind === "paused").map((f) => f.event as unknown as { atEnd: boolean; requested: boolean });
  assert.deepEqual(pauses, [
    { kind: "paused", positionMs: 0, atEnd: false, requested: true },
    { kind: "paused", positionMs: 0, atEnd: false, requested: false },
    { kind: "paused", positionMs: 0, atEnd: true, requested: false }
  ]);
  assert.equal(facts.at(-1)?.event.kind, "ended");
  // pause() on an already paused element fires nothing, so it must not be counted.
  driver.execute(deck("deck.pause", "A", "L1"));
  el.fire("pause");
  assert.equal((facts.at(-1)?.event as unknown as { requested: boolean }).requested, false);
});

test("bounded waits: load, start and stall watchdogs report one classified error and silence the load", async () => {
  const { driver, elements, timers, kinds, facts } = await setup();
  driver.execute(load("A", "L1"));
  timers.advance(1_000);
  assert.deepEqual(kinds("L1"), ["error"]);
  elements[0]!.ready(12);
  assert.deepEqual(kinds("L1"), ["error"], "a failed load stays silent");

  driver.execute(load("B", "L2"));
  elements[1]!.ready(12);
  elements[1]!.playMode = "pending"; // a play() promise that never settles
  driver.execute(deck("deck.play", "B", "L2"));
  timers.advance(2_000);
  assert.deepEqual(kinds("L2"), ["metadata", "can-play", "error"]);

  driver.execute(load("A", "L3"));
  const el = elements[2]!;
  el.ready(12);
  driver.execute(deck("deck.play", "A", "L3"));
  el.fire("playing");
  el.fire("waiting");
  timers.advance(2_000);
  el.fire("playing"); // data came back in time
  el.fire("waiting");
  timers.advance(3_000);
  assert.deepEqual(kinds("L3"), ["metadata", "can-play", "playing", "waiting", "playing", "waiting", "error"]);
  const codes = facts.filter((f) => f.event.kind === "error").map((f) => (f.event.kind === "error" ? `${f.event.error.class}/${f.event.error.code}` : ""));
  assert.deepEqual(codes, ["retryable/media_load_timeout", "retryable/media_start_timeout", "retryable/media_stall_timeout"]);
  assert.equal(timers.size, 0, "no watchdog left behind");
});

test("a suspended AudioContext: play waits for resume() at most unlockMs, then reports not-allowed; a gesture unlock lets it play", async () => {
  const { driver, ctx, elements, timers, kinds } = await setup("suspended");
  driver.execute(load("A", "L1"));
  elements[0]!.ready(12);
  driver.execute(deck("deck.play", "A", "L1"));
  timers.advance(500);
  await flush();
  assert.deepEqual(kinds("L1"), ["metadata", "can-play", "play-rejected"]);
  assert.equal(elements[0]!.paused, true, "element never asked to play into a silent graph");
  driver.unlock();
  ctx.allowResume();
  await flush();
  driver.execute(deck("deck.play", "A", "L1"));
  assert.equal(elements[0]!.paused, false, "plays synchronously once the context runs");
});

test("durations: Infinity stays unknown; a later finite durationchange is reported once", async () => {
  const { driver, elements, facts } = await setup();
  driver.execute(load("A", "L1"));
  const el = elements[0]!;
  el.duration = Number.POSITIVE_INFINITY;
  el.readyState = 1;
  el.fire("loadedmetadata");
  el.duration = 200;
  el.fire("durationchange");
  el.fire("durationchange");
  const durations = facts.filter((f) => f.event.kind === "metadata").map((f) => (f.event.kind === "metadata" ? f.event.duration : null));
  assert.deepEqual(durations, [{ kind: "unknown" }, { kind: "known", ms: 200_000, source: "media-element" }]);
});

test("gains: fades cancel and re-anchor; pause holds automation; user volume moves the bus, not the deck multiplier; stale loads are ignored", async () => {
  const { driver, ctx } = await setup();
  const [channelA, , musicBus, voiceBus, master] = ctx.gains;
  driver.execute(load("A", "L1"));
  channelA!.gain.calls.length = 0;
  driver.execute({ type: "deck.gain", deck: "A", loadId: L("L1"), gain: 1, rampMs: 0 });
  driver.execute({ type: "deck.gain", deck: "A", loadId: L("L1"), gain: 0.3, rampMs: 600 });
  assert.deepEqual(channelA!.gain.calls, ["cancel@10", "set(0)@10", "set(1)@10", "cancel@10", "set(1)@10", "curve(1→0.3)@10.006+0.594"]);
  driver.execute({ type: "output.volume", music: 0.5, voice: 0.8, muted: false });
  assert.equal(musicBus!.gain.value, 0.5);
  assert.equal(voiceBus!.gain.value, 0.8);
  assert.equal(master!.gain.value, 1);
  assert.ok(Math.abs(channelA!.gain.value - 0.3) < 1e-6, "duck multiplier untouched by the user volume");
  channelA!.gain.calls.length = 0;
  driver.execute(deck("deck.pause", "A", "L1"));
  assert.deepEqual(channelA!.gain.calls, ["cancel@10", "set(0.3)@10"], "pending automation cancelled and held");
  channelA!.gain.calls.length = 0;
  driver.execute({ type: "deck.gain", deck: "A", loadId: L("old"), gain: 1, rampMs: 0 });
  assert.deepEqual(channelA!.gain.calls, [], "effect for another load ignored");
});

test("voice channel: new voice load replaces the old element; stop releases it; at most three live elements", async () => {
  const { driver, elements, facts } = await setup();
  const asset = cueAsset();
  const voice = (n: number) => ({ cueId: asId<CueId>(`cue${n}`), voiceLoadId: asId<VoiceLoadId>(`vl${n}`) });
  driver.execute(load("A", "L1"));
  driver.execute(load("B", "L2"));
  driver.execute({ type: "voice.load", ...voice(1), asset });
  driver.execute({ type: "voice.load", ...voice(2), asset });
  assert.equal(driver.diagnostics().liveElements, 3);
  elements[2]!.fire("canplay");
  assert.equal(facts.filter((f) => f.type === "voice.media").length, 0, "replaced voice load is silent");
  elements[3]!.ready(1.8);
  assert.deepEqual(facts.filter((f) => f.type === "voice.media").map((f) => (f.type === "voice.media" ? f.voiceLoadId : "")), ["vl2", "vl2"]);
  driver.execute({ type: "voice.stop", ...voice(2) });
  assert.equal(elements[3]!.src, "");
  assert.equal(driver.diagnostics().liveElements, 2);
});

test("live clock reads the element: advancing only while playing; frozen while waiting or paused", async () => {
  const { driver, elements } = await setup();
  driver.execute(load("A", "L1"));
  const el = elements[0]!;
  el.ready(12);
  driver.execute(deck("deck.play", "A", "L1"));
  el.fire("playing");
  el.advanceTo(3.5);
  let clock = driver.readClock().decks.A!;
  assert.deepEqual([clock.positionMs, clock.rate, clock.state, clock.loadId], [3500, 1, "playing", "L1"]);
  el.readyState = 2;
  el.fire("waiting");
  clock = driver.readClock().decks.A!;
  assert.deepEqual([clock.rate, clock.state], [0, "waiting"]);
  el.readyState = 4;
  el.fire("playing");
  driver.execute(deck("deck.pause", "A", "L1"));
  el.fire("pause");
  clock = driver.readClock().decks.A!;
  assert.deepEqual([clock.rate, clock.state], [0, "paused"]);
  assert.ok(Object.isFrozen(driver.readClock()), "read-only reading, no element reference");
});

test("dispose releases every element, closes the context and settles a pending unlock; later effects are ignored", async () => {
  const { driver, ctx, elements, timers, facts } = await setup("suspended");
  driver.execute(load("A", "L1"));
  elements[0]!.ready(12);
  driver.execute(deck("deck.play", "A", "L1")); // waits for resume()
  driver.execute({ type: "voice.load", cueId: asId("c"), voiceLoadId: asId("v"), asset: cueAsset() });
  await driver.dispose();
  assert.equal(ctx.state, "closed");
  assert.ok(elements.every((el) => el.src === ""));
  assert.equal(timers.size, 0, "unlock wait and watchdogs cleared");
  const count = facts.length;
  driver.execute(load("B", "L9"));
  assert.equal(elements.length, 2, "no element created after dispose");
  await flush();
  assert.equal(facts.length, count);
  const diag = driver.diagnostics();
  assert.deepEqual([diag.liveElements, diag.createdElements, diag.releasedElements, diag.disposed], [0, 2, 2, true]);
});

const V = { cueId: asId<CueId>("cue1"), voiceLoadId: asId<VoiceLoadId>("vl1") };
const voiceKinds = (facts: MediaFact[]) => facts.filter((f) => f.type === "voice.media").map((f) => f.event.kind);
const lastOf = (facts: MediaFact[], loadId: string) => facts.filter((f) => f.type === "deck.media" && f.loadId === loadId).at(-1)?.event;

test("AudioContext suspend: live channels report waiting and rate 0; resume reports playing at the actual position, only for channels still meant to play", async () => {
  const { driver, ctx, elements, facts, timers, kinds } = await setup();
  driver.execute(load("A", "L1"));
  driver.execute(load("B", "L2")); // standby: loaded, never asked to play
  driver.execute({ type: "voice.load", ...V, asset: cueAsset() });
  const [a, b, v] = elements as [FakeMediaElement, FakeMediaElement, FakeMediaElement];
  a.ready(200);
  b.ready(200);
  v.ready(5);
  driver.execute(deck("deck.play", "A", "L1"));
  driver.execute({ type: "voice.play", ...V, playId: asId<PlayRequestId>("vplay") });
  a.fire("playing");
  v.fire("playing");
  a.advanceTo(12.5);
  v.advanceTo(0.8);
  const before = facts.length;

  void ctx.suspend();
  assert.deepEqual(facts.slice(before).map((f) => `${f.type === "deck.media" ? f.loadId : "voice"}:${f.event.kind}`), ["L1:waiting", "voice:waiting"]);
  const held = driver.readClock();
  assert.deepEqual([held.decks.A?.rate, held.decks.A?.state, held.voice?.rate, held.voice?.state], [0, "waiting", 0, "waiting"]);
  assert.equal(held.decks.B?.state, "paused", "standby untouched");
  timers.advance(120_000);
  assert.equal(facts.some((f) => f.event.kind === "error"), false, "a frozen output is neither a start nor a stall timeout");

  // The element clock does not advance while nothing renders; whatever it reads on resume is reported.
  a.advanceTo(12.6);
  ctx.setState("running");
  assert.deepEqual(lastOf(facts, "L1"), { kind: "playing", positionMs: 12_600 });
  assert.equal(voiceKinds(facts).at(-1), "playing");
  assert.equal(kinds("L2").includes("playing"), false, "a standby is not started by the context resuming");
  assert.deepEqual([driver.readClock().decks.A?.rate, driver.readClock().decks.A?.state], [1, "playing"]);
});

test("while suspended: pause, unload and stop are final; resume revives none of them and creates no timers", async () => {
  const { driver, ctx, elements, facts, timers } = await setup();
  driver.execute(load("A", "L1"));
  driver.execute({ type: "voice.load", ...V, asset: cueAsset() });
  const [a, v] = elements as [FakeMediaElement, FakeMediaElement];
  a.ready(200);
  v.ready(5);
  driver.execute(deck("deck.play", "A", "L1"));
  driver.execute({ type: "voice.play", ...V, playId: asId<PlayRequestId>("vplay") });
  a.fire("playing");
  v.fire("playing");
  void ctx.suspend();
  driver.execute(deck("deck.pause", "A", "L1"));
  a.fire("pause");
  driver.execute({ type: "voice.stop", ...V });
  const count = facts.length;
  ctx.setState("running");
  assert.equal(facts.length, count, "nothing reported: A was paused by request, the voice released");
  assert.equal(a.paused, true);
  assert.equal(timers.size, 0);

  // Skip while suspended: the old load is released; the new one plays only once output runs.
  driver.execute(load("A", "L3"));
  const c = elements[2]!;
  c.ready(200);
  void ctx.suspend();
  ctx.resumeAllowed = false;
  driver.execute(deck("deck.play", "A", "L3"));
  assert.equal(c.paused, true, "not started into a suspended graph");
  ctx.allowResume();
  await flush();
  assert.equal(c.paused, false);
  c.fire("playing");
  assert.deepEqual(lastOf(facts, "L3"), { kind: "playing", positionMs: 0 });
  await driver.dispose();
  assert.equal(timers.size, 0);
});

test("an element that starts while the output is suspended reports waiting, then playing once the output runs", async () => {
  const { driver, ctx, elements, kinds } = await setup();
  driver.execute(load("A", "L1"));
  const a = elements[0]!;
  a.ready(200);
  driver.execute(deck("deck.play", "A", "L1"));
  void ctx.suspend(); // between play() and the element's `playing`
  a.fire("playing");
  assert.deepEqual(kinds("L1"), ["metadata", "can-play", "waiting"]);
  ctx.setState("running");
  assert.deepEqual(kinds("L1"), ["metadata", "can-play", "waiting", "playing"]);
});

test("a context closed by someone else fails live loads once with audio_output_closed; later plays fail instead of asking for a gesture", async () => {
  const { driver, ctx, elements, facts, timers } = await setup();
  driver.execute(load("A", "L1"));
  elements[0]!.ready(200);
  driver.execute(deck("deck.play", "A", "L1"));
  elements[0]!.fire("playing");
  ctx.setState("closed");
  const errors = facts.filter((f) => f.event.kind === "error").map((f) => (f.event.kind === "error" ? f.event.error.code : ""));
  assert.deepEqual(errors, ["audio_output_closed"]);
  driver.execute(load("A", "L2"));
  elements[1]!.ready(200);
  driver.execute(deck("deck.play", "A", "L2"));
  await flush();
  assert.deepEqual(lastOf(facts, "L2"), { kind: "error", error: { class: "unavailable", code: "audio_output_closed" } });
  assert.equal(facts.some((f) => f.event.kind === "play-rejected"), false, "not reported as a missing gesture");
  const resumes = ctx.resumeCalls;
  driver.unlock();
  assert.equal(ctx.resumeCalls, resumes, "unlock does not retry a closed context");
  assert.equal(timers.size, 0);
});

test("seek acknowledgement: one seeked per latest target, deferred seeks answered after metadata, declined or unanswered seeks answered from the element", async () => {
  const { driver, elements, facts, timers } = await setup();
  const seeks = (loadId: string) => facts.filter((f) => f.type === "deck.media" && f.loadId === loadId && f.event.kind === "seeked").map((f) => (f.event.kind === "seeked" ? f.event.positionMs : -1));
  const seek = (loadId: string, positionMs: number): DriverEffect => ({ type: "deck.seek", deck: "A", loadId: L(loadId), positionMs });

  // Overlapping seeks: the first one's seeked is dispatched while the element already seeks again.
  driver.execute(load("A", "L1"));
  const a = elements[0]!;
  a.ready(200);
  driver.execute(seek("L1", 10_000));
  driver.execute(seek("L1", 20_000));
  a.fire("seeked"); // task queued for the first seek; element.seeking is still true
  assert.deepEqual(seeks("L1"), [], "the old target is not acknowledged as the new one");
  a.completeSeek();
  assert.deepEqual(seeks("L1"), [20_000]);
  // Same position again still gets exactly one answer.
  driver.execute(seek("L1", 20_000));
  a.completeSeek();
  assert.deepEqual(seeks("L1"), [20_000, 20_000]);

  // Before metadata the seek waits for loadedmetadata, then is answered like any other.
  driver.execute(load("A", "L2", 3_000));
  const b = elements[1]!;
  driver.execute(seek("L2", 0));
  b.ready(200);
  assert.deepEqual(b.seeks, [0], "the later seek replaced the resume point");
  b.completeSeek();
  assert.deepEqual(seeks("L2"), [0]);

  // Nothing seekable: the element declines synchronously and never fires seeked.
  b.seekableEmpty = true;
  b.advanceTo(7);
  driver.execute(seek("L2", 50_000));
  assert.deepEqual(seeks("L2"), [0, 7_000], "answered at once with where the element actually is");

  // The element stops seeking without a seeked event: the check answers it, once.
  b.seekableEmpty = false;
  driver.execute(seek("L2", 60_000));
  timers.advance(1_000);
  assert.deepEqual(seeks("L2"), [0, 7_000], "still seeking: keep waiting");
  b.seeking = false;
  timers.advance(1_000);
  assert.deepEqual(seeks("L2"), [0, 7_000, 60_000]);
  b.fire("seeked");
  assert.deepEqual(seeks("L2"), [0, 7_000, 60_000], "a late native seeked is not a second answer");
  driver.execute(deck("deck.unload", "A", "L2"));
  assert.equal(timers.size, 0);
});

test("own-pause barrier: a playing queued before an unanswered own pause belongs to the superseded play and is not reported", async () => {
  const { driver, elements, kinds } = await setup();
  driver.execute(load("B", "L1"));
  const b = elements[0]!;
  b.ready(200);
  b.playMode = "pending";
  driver.execute(deck("deck.play", "B", "L1")); // preroll play #1; its `playing` gets queued
  driver.execute(deck("deck.pause", "B", "L1")); // hold
  driver.execute({ type: "deck.seek", deck: "B", loadId: L("L1"), positionMs: 0 });
  driver.execute(deck("deck.play", "B", "L1")); // promote: play #2
  b.fire("playing"); // play #1's queued event arrives first
  assert.deepEqual(kinds("L1"), ["metadata", "can-play"], "stale playing not reported");
  b.fire("pause"); // the own pause's answer
  b.completeSeek();
  assert.deepEqual(kinds("L1"), ["metadata", "can-play", "paused", "seeked"]);
  // play #2 is refused: nothing ever claimed playing.
  b.plays.splice(0).forEach((p) => p.reject(new DOMException("denied", "NotAllowedError")));
  await flush();
  assert.deepEqual(kinds("L1"), ["metadata", "can-play", "paused", "seeked", "play-rejected"]);

  // Same sequence where play #2 succeeds: its own playing (queued after the pause) is reported.
  driver.execute(load("A", "L2"));
  const a = elements[1]!;
  a.ready(200);
  driver.execute(deck("deck.play", "A", "L2"));
  driver.execute(deck("deck.pause", "A", "L2"));
  driver.execute(deck("deck.play", "A", "L2"));
  a.fire("playing");
  a.fire("pause");
  a.fire("playing");
  assert.deepEqual(kinds("L2"), ["metadata", "can-play", "paused", "playing"]);
});

test("pause acknowledgement: exactly one requested paused per deck.pause — from the event it causes, from a still-queued event, or at once when none is owed", async () => {
  const { driver, ctx, elements, facts } = await setup();
  const paused = (loadId: string) =>
    facts.filter((f) => f.type === "deck.media" && f.loadId === loadId && f.event.kind === "paused").map((f) => (f.event.kind === "paused" ? `${f.event.requested ? "req" : "ext"}${f.event.atEnd ? "@end" : ""}` : ""));
  driver.execute(load("A", "L1"));
  const a = elements[0]!;
  a.ready(200);

  // 1. The element plays: pause() causes the event that answers it.
  driver.execute(deck("deck.play", "A", "L1"));
  a.fire("play");
  a.fire("playing");
  driver.execute(deck("deck.pause", "A", "L1"));
  assert.deepEqual(paused("L1"), [], "answered by the event, not before");
  a.fire("pause");
  assert.deepEqual(paused("L1"), ["req"]);

  // 2. Already paused but its event still queued: a second deck.pause is answered by that same event, once each.
  driver.execute(deck("deck.play", "A", "L1"));
  driver.execute(deck("deck.pause", "A", "L1"));
  driver.execute(deck("deck.pause", "A", "L1"));
  a.fire("play");
  a.fire("pause");
  assert.deepEqual(paused("L1"), ["req", "req", "req"]);

  // play → pause → play → pause, then a third pause after the first event: it waits for the second event.
  driver.execute(deck("deck.play", "A", "L1"));
  driver.execute(deck("deck.pause", "A", "L1"));
  driver.execute(deck("deck.play", "A", "L1"));
  driver.execute(deck("deck.pause", "A", "L1"));
  a.fire("play");
  a.fire("pause");
  driver.execute(deck("deck.pause", "A", "L1"));
  assert.deepEqual(paused("L1").slice(3), ["req"], "first event answers only the first pause");
  a.fire("play");
  a.fire("pause");
  assert.deepEqual(paused("L1").slice(3), ["req", "req", "req"]);

  // 3. Nothing owed (already paused, every event dispatched): acknowledged at once from the element.
  driver.execute(deck("deck.pause", "A", "L1"));
  assert.deepEqual(paused("L1").slice(6), ["req"]);

  // A play deferred for the AudioContext and cancelled before any native play(): acknowledged at once.
  ctx.resumeAllowed = false;
  void ctx.suspend();
  driver.execute(deck("deck.play", "A", "L1"));
  driver.execute(deck("deck.pause", "A", "L1"));
  assert.deepEqual(paused("L1").slice(7), ["req"]);
  ctx.allowResume();
  await flush();
  assert.equal(a.paused, true, "the cancelled deferred play never reaches the element");

  // External and end-of-media pauses are not acknowledgements; a deck.pause between the end and its event is answered by it.
  driver.execute(deck("deck.play", "A", "L1"));
  a.fire("play");
  a.fire("playing");
  a.paused = true; // the OS pauses the element
  a.fire("pause");
  driver.execute(deck("deck.play", "A", "L1"));
  a.fire("play");
  a.fire("playing");
  a.paused = true; // natural end: paused, then `pause` and `ended` queued
  a.ended = true;
  driver.execute(deck("deck.pause", "A", "L1"));
  a.fire("pause");
  a.fire("ended");
  assert.deepEqual(paused("L1").slice(8), ["ext", "req@end"]);
});

test("play-rejected names the play request whose promise was refused; an already rolling element's play reports nothing", async () => {
  const { driver, elements, facts } = await setup();
  driver.execute(load("A", "L1"));
  const a = elements[0]!;
  a.ready(200);
  a.playMode = "pending";
  const first: DriverEffect = { type: "deck.play", deck: "A", loadId: L("L1"), playId: asId<PlayRequestId>("p1") };
  driver.execute(first);
  a.fire("play");
  a.fire("playing");
  driver.execute({ type: "deck.play", deck: "A", loadId: L("L1"), playId: asId<PlayRequestId>("p2") }); // rolling: no native play()
  assert.equal(a.plays.length, 1);
  driver.execute(deck("deck.pause", "A", "L1"));
  a.fire("pause");
  a.playMode = "not-allowed";
  driver.execute({ type: "deck.play", deck: "A", loadId: L("L1"), playId: asId<PlayRequestId>("p3") });
  await flush();
  const rejections = facts.filter((f) => f.event.kind === "play-rejected").map((f) => (f.event.kind === "play-rejected" ? [f.event.playId, f.event.reason] : []));
  assert.deepEqual(rejections, [["p3", "not-allowed"]], "p1's AbortError (own pause) is not reported; p2 never called play()");
});

const mediaOf = (facts: MediaFact[], loadId: string) =>
  facts
    .filter((f) => f.type === "deck.media" && f.loadId === loadId && ["playing", "waiting", "paused", "seeked", "ended", "play-rejected"].includes(f.event.kind))
    .map((f) => (f.event.kind === "paused" ? `paused:${f.event.requested ? "req" : "ext"}${f.event.atEnd ? "@end" : ""}` : f.event.kind));

test("external pause → seek → play: the first play's queued playing is not reported (even while seeking); the queued pause is superseded, not an interruption", async () => {
  const { driver, elements, facts } = await setup();
  driver.execute(load("A", "L1"));
  const a = elements[0]!;
  a.ready(200);
  driver.execute(deck("deck.play", "A", "L1")); // play #1: `play`, `playing` queued
  a.pause(); // another agent pauses the element synchronously; its `pause` is queued
  driver.execute({ type: "deck.seek", deck: "A", loadId: L("L1"), positionMs: 0 });
  driver.execute(deck("deck.play", "A", "L1")); // the seek's play #2 unpauses again
  a.fire("play");
  a.fire("playing"); // play #1's, dispatched with seeking=true
  a.fire("pause"); // the external pause
  assert.deepEqual(mediaOf(facts, "L1"), [], "neither the old playing nor the superseded pause");
  a.fire("play");
  a.fire("waiting");
  a.completeSeek();
  a.fire("playing");
  assert.deepEqual(mediaOf(facts, "L1"), ["waiting", "seeked", "playing"]);
});

test("external play whose play event is still queued → own pause → own play: the external playing is not reported, the pause answers the deck.pause", async () => {
  const { driver, elements, facts } = await setup();
  driver.execute(load("A", "L1"));
  const a = elements[0]!;
  a.ready(200);
  void a.play(); // another agent: element.paused=false, `play`/`playing` queued, not dispatched yet
  driver.execute(deck("deck.pause", "A", "L1"));
  assert.deepEqual(mediaOf(facts, "L1"), [], "not acknowledged before the pause event it caused");
  driver.execute(deck("deck.play", "A", "L1"));
  a.fire("play");
  a.fire("playing"); // the external play's
  a.fire("pause");
  a.fire("play");
  a.fire("playing");
  assert.deepEqual(mediaOf(facts, "L1"), ["paused:req", "playing"]);
});

test("no pause is owed for a play that never reached the element: suspended unlock → pause → play → playing is reported", async () => {
  const { driver, ctx, elements, facts } = await setup("suspended");
  driver.execute(load("A", "L1"));
  const a = elements[0]!;
  a.ready(200);
  driver.execute(deck("deck.play", "A", "L1"));
  driver.execute(deck("deck.pause", "A", "L1"));
  driver.execute(deck("deck.play", "A", "L1"));
  assert.equal(a.paused, true, "nothing reached the element yet");
  ctx.allowResume();
  await flush();
  assert.equal(a.paused, false);
  a.fire("play");
  a.fire("playing");
  assert.deepEqual(mediaOf(facts, "L1"), ["paused:req", "playing"]);
});

test("seek + play at the natural end: the end's queued pause and its obsolete ended keep the new play wanted, so an output resume reports playing", async () => {
  const { driver, ctx, elements, facts } = await setup();
  driver.execute(load("A", "L1"));
  const a = elements[0]!;
  a.ready(12);
  driver.execute(deck("deck.play", "A", "L1"));
  a.fire("play");
  a.fire("playing");
  a.advanceTo(12);
  a.paused = true; // reached the end: paused/ended set, `pause` and `ended` queued
  a.ended = true;
  // In the end's timeupdate handler the listener seeks back; the core re-asks play with the seek.
  driver.execute({ type: "deck.seek", deck: "A", loadId: L("L1"), positionMs: 150 });
  driver.execute(deck("deck.play", "A", "L1"));
  assert.deepEqual([a.ended, a.seeking, a.paused], [false, true, false]);
  a.fire("pause");
  a.fire("ended");
  assert.deepEqual(mediaOf(facts, "L1"), ["playing"], "neither the end's pause nor its obsolete ended");
  a.fire("play");
  a.completeSeek();
  a.fire("playing");
  assert.deepEqual(mediaOf(facts, "L1"), ["playing", "seeked", "playing"]);
  a.advanceTo(0.5);
  void ctx.suspend();
  assert.deepEqual(mediaOf(facts, "L1").slice(3), ["waiting"]);
  ctx.setState("running");
  assert.deepEqual(lastOf(facts, "L1"), { kind: "playing", positionMs: 500 }, "the play is still wanted after the obsolete ended");
});

test("a genuine end is still reported once; an ended dispatched while the element still is ended is never dropped", async () => {
  const { driver, elements, facts } = await setup();
  driver.execute(load("A", "L1"));
  const a = elements[0]!;
  a.ready(12);
  driver.execute(deck("deck.play", "A", "L1"));
  a.fire("play");
  a.fire("playing");
  a.paused = true;
  a.ended = true;
  a.fire("pause");
  a.fire("ended");
  assert.deepEqual(mediaOf(facts, "L1"), ["playing", "paused:ext@end", "ended"]);
});

test("a current play interrupted by someone else is reported as aborted with its playId; the start watchdog is not left waiting", async () => {
  const { driver, elements, facts, timers } = await setup();
  driver.execute(load("A", "L1"));
  const a = elements[0]!;
  a.ready(200);
  a.playMode = "pending";
  driver.execute({ type: "deck.play", deck: "A", loadId: L("L1"), playId: asId<PlayRequestId>("p-current") });
  a.pause(); // not ours: rejects the pending play() with AbortError
  await flush();
  const rejections = facts.filter((f) => f.event.kind === "play-rejected").map((f) => (f.event.kind === "play-rejected" ? [f.event.playId, f.event.reason] : []));
  assert.deepEqual(rejections, [["p-current", "aborted"]]);
  timers.advance(60_000);
  assert.equal(facts.some((f) => f.event.kind === "error"), false, "no start timeout after the refusal was reported");
});
