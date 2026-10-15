import assert from "node:assert/strict";
import test from "node:test";
import { asId, type CueId, type DeckId, type LoadId, type VoiceLoadId } from "@claudio/contracts";
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
const deck = (type: "deck.play" | "deck.pause" | "deck.unload", d: DeckId, loadId: string): DriverEffect => ({ type, deck: d, loadId: L(loadId) });

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
  el.currentTime = 3.5;
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
