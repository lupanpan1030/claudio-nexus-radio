import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState, type CoreConfig } from "../src/index.js";
import { cueAsset, Sim } from "./harness.js";

function crossfade(config: Partial<CoreConfig> = {}) {
  const sim = new Sim({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000, ...config });
  const [a, b, c] = sim.enqueue("a", "b", "c");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  return { sim, a: a!, b: b!, c: c! };
}

test("A's end is the preroll deadline: with a playable cue it talks at once, B held until the voice ends", () => {
  const { sim, a, b } = crossfade();
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 195_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  const bLoad = sim.loadOf(b);

  const mark = sim.mark();
  sim.naturalEnd(a);
  assert.equal(sim.snap.transition?.phase, "talking", "not waiting on B any longer");
  assert.equal(sim.snap.transition?.mode, "sequential-talk");
  assert.equal(sim.effects("voice.play", mark).length, 1);
  assert.deepEqual(sim.effects("deck.pause", mark).map((e) => e.loadId), [bLoad.loadId], "B stops waiting to play");
  assert.ok(sim.effects("deck.seek", mark).some((e) => e.loadId === bLoad.loadId && e.positionMs === 0));
  assert.equal(sim.snap.decks[bLoad.deck].gain, 0);
  assert.equal(sim.snap.program?.item.itemId, a, "B is not program while the DJ talks");

  // B's earlier play lands after the hold, before the hold's pause acknowledgement: it predates the hold.
  const late = sim.deck(b, { kind: "playing", positionMs: 120 });
  assert.equal(late.notes[0]?.kind, "stale");
  assert.equal(sim.snap.transition?.phase, "talking");
  assert.equal(sim.snap.decks[bLoad.deck].status, "ready", "never seen as playing");
  sim.deck(b, { kind: "paused", positionMs: 130, atEnd: false, requested: true });
  sim.deck(b, { kind: "seeked", positionMs: 0 });
  assert.equal(sim.receipts().length, 1);

  sim.voice({ kind: "playing", positionMs: 0 });
  const promote = sim.mark();
  sim.voiceNaturalEnd();
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.deepEqual(sim.effects("deck.play", promote).map((e) => e.loadId), [bLoad.loadId]);
  sim.deck(b, { kind: "playing", positionMs: 0 });
  const receipts = sim.receipts();
  assert.deepEqual(receipts.map((e) => e.receipt.itemId), [a, b]);
  assert.equal(receipts[1]!.receipt.positionMs, 0);
});

test("A's end without a playable cue commits the already requested B as is: no hold, no second ack race", () => {
  const { sim, a, b } = crossfade();
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 195_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  sim.voice({ kind: "error", error: { class: "unavailable", code: "decode" } });
  assert.equal(sim.snap.voice, null);
  const bLoad = sim.loadOf(b);

  const mark = sim.mark();
  sim.naturalEnd(a);
  assert.equal(sim.snap.program?.item.itemId, b, "direct commit at the deadline");
  assert.equal(sim.snap.decks[bLoad.deck].role, "program");
  assert.equal(sim.effects("deck.pause", mark).filter((e) => e.loadId === bLoad.loadId).length, 0, "B is not paused");
  assert.equal(sim.effects("deck.seek", mark).filter((e) => e.loadId === bLoad.loadId).length, 0, "nor rewound");
  assert.equal(sim.effects("deck.load", mark).length, 0, "promoted, not reloaded");
  assert.equal(sim.snap.decks[bLoad.deck].gain, 1);
  assert.equal(sim.snap.transport, "loading", "honest: B asked to play, not confirmed");
  assert.equal(sim.receipts().length, 1);

  sim.deck(b, { kind: "playing", positionMs: 40 });
  assert.equal(sim.snap.transport, "playing");
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b], "committed first, playing later: exactly once");
  sim.deck(b, { kind: "playing", positionMs: 60 });
  assert.equal(sim.receipts().length, 2);
});

test("after a deadline commit, B's real start timeout goes through the normal refresh path", () => {
  const { sim, a, b } = crossfade();
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 195_000, rate: 1 });
  sim.voice({ kind: "error", error: { class: "unavailable", code: "decode" } });
  sim.naturalEnd(a);
  assert.equal(sim.snap.program?.item.itemId, b);
  sim.deck(b, { kind: "error", error: { class: "retryable", code: "media_start_timeout" } });
  const refresh = sim.lastEffect("prepare.start", (e) => e.itemId === b);
  assert.equal(refresh.purpose, "refresh");
  assert.equal(sim.snap.transport, "requested");
  sim.resolve(b);
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
});

test("skipping to the prerolling B promotes it without pause/seek; it records on its own playing", () => {
  const { sim, a, b } = crossfade();
  sim.cueReady();
  sim.deck(a, { kind: "time", positionMs: 195_000, rate: 1 });
  const bLoad = sim.loadOf(b);
  const mark = sim.mark();
  sim.cmd({ type: "next" });
  assert.equal(sim.snap.program?.item.itemId, b);
  assert.equal(sim.effects("deck.pause", mark).filter((e) => e.loadId === bLoad.loadId).length, 0);
  assert.equal(sim.effects("deck.seek", mark).filter((e) => e.loadId === bLoad.loadId).length, 0);
  assert.equal(sim.effects("voice.play", mark).length, 0);
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transport, "playing");
  assert.deepEqual(sim.receipts().map((e) => e.receipt.itemId), [a, b]);
});

test("too little of A left for a fade: no preroll, the hand-over waits for A's end", () => {
  const short = crossfade();
  assert.equal(short.sim.state.config.minCrossfadeTailMs, 1500, "defaults to fadeMs");
  short.sim.deck(short.a, { kind: "time", positionMs: 198_600, rate: 1 });
  short.sim.cueReady(); // cue arrives with 1.4 s of A left
  assert.equal(short.sim.snap.transition?.phase, "planned");
  assert.equal(short.sim.effects("deck.play").filter((e) => e.loadId === short.sim.loadOf(short.b).loadId).length, 0);
  short.sim.naturalEnd(short.a);
  assert.equal(short.sim.snap.transition?.phase, "talking", "sequential talk at A's end");

  const exact = crossfade();
  exact.sim.deck(exact.a, { kind: "time", positionMs: 198_500, rate: 1 });
  exact.sim.cueReady();
  assert.equal(exact.sim.snap.transition?.phase, "prerolling", "exactly the minimum tail is enough");
});

test("minCrossfadeTailMs follows a configured fadeMs unless set explicitly", () => {
  const follows = crossfade({ fadeMs: 3000 });
  assert.equal(follows.sim.state.config.minCrossfadeTailMs, 3000);
  follows.sim.deck(follows.a, { kind: "time", positionMs: 197_500, rate: 1 });
  follows.sim.cueReady();
  assert.equal(follows.sim.snap.transition?.phase, "planned");

  const explicit = crossfade({ fadeMs: 3000, minCrossfadeTailMs: 500 });
  explicit.sim.deck(explicit.a, { kind: "time", positionMs: 197_500, rate: 1 });
  explicit.sim.cueReady();
  assert.equal(explicit.sim.snap.transition?.phase, "prerolling");
});

test("invalid numeric configuration is rejected at creation", () => {
  for (const config of [
    { minCrossfadeTailMs: -1 },
    { fadeMs: Number.NaN },
    { crossfadeLeadMs: Number.POSITIVE_INFINITY },
    { duckGain: 1.5 },
    { maxConsecutiveFailures: 0 },
    { maxRefreshAttempts: 0.5 },
    { preferredTalkMode: "talk-over-intro" as never }
  ] satisfies Partial<CoreConfig>[]) {
    assert.throws(() => createInitialState({ config }), RangeError, JSON.stringify(config));
  }
});

test("the voice need not fit into A: it runs on over B after A's end", () => {
  const { sim, a, b, c } = crossfade();
  sim.cueReady(cueAsset("比 A 剩下的还长", 10_000));
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  sim.deck(b, { kind: "playing", positionMs: 0 });
  sim.voice({ kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transition?.phase, "overlapping");

  const aDeck = sim.loadOf(a).deck;
  sim.naturalEnd(a);
  assert.equal(sim.snap.decks[aDeck].role, "idle", "A's tail is over");
  assert.equal(sim.snap.transition?.phase, "overlapping", "voice still speaking over B");
  assert.equal(sim.snap.display.kind, "voice");
  sim.voiceNaturalEnd(10_000);
  assert.equal(sim.snap.decks[sim.loadOf(b).deck].gain, 1);
  assert.equal(sim.snap.transition?.fromItemId, b);
  assert.equal(sim.snap.transition?.toItemId, c);
});

test("an unknown voice duration still allows the crossfade", () => {
  const { sim, a, b } = crossfade();
  sim.cueReady(cueAsset("长度未知", null));
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  sim.deck(b, { kind: "playing", positionMs: 0 });
  assert.equal(sim.snap.transition?.phase, "overlapping");
  assert.equal(sim.effects("voice.play").length, 1);
});
