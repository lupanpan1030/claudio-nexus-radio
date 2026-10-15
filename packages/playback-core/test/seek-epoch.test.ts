import assert from "node:assert/strict";
import test from "node:test";
import { Sim } from "./harness.js";

test("seekEpoch: 0 at load, +1 per accepted seek (also tiny or backward), unchanged by ignored seeks and media facts", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.deck(a!, { kind: "metadata", duration: { kind: "known", ms: 200_000, source: "media-element" } });
  const deckOf = () => sim.snap.decks[sim.loadOf(a!).deck];
  assert.equal(deckOf().seekEpoch, 0);
  sim.deck(a!, { kind: "time", positionMs: 30_000, rate: 1 });
  sim.cmd({ type: "seek", positionMs: 29_900 }); // 100 ms backwards
  assert.equal(deckOf().seekEpoch, 1);
  assert.equal(deckOf().clock?.positionMs, 29_900, "the clock already holds the target");
  sim.deck(a!, { kind: "seeked", positionMs: 29_900 });
  sim.deck(a!, { kind: "playing", positionMs: 29_900 });
  assert.equal(deckOf().seekEpoch, 1, "facts never bump it");
  sim.cmd({ type: "seek", positionMs: 29_900 }); // same target again is still a jump the clock follower must honour
  assert.equal(deckOf().seekEpoch, 2);
  sim.cmd({ type: "seek", positionMs: -5 });
  assert.equal(deckOf().seekEpoch, 2, "an ignored seek is no discontinuity");
});

test("seekEpoch restarts with every load; the standby hold-back seek counts on the standby's own load", () => {
  const sim = new Sim({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  sim.deck(a!, { kind: "metadata", duration: { kind: "known", ms: 200_000, source: "media-element" } });
  sim.cmd({ type: "seek", positionMs: 10_000 });
  sim.deck(a!, { kind: "seeked", positionMs: 10_000 });
  sim.resolve(b!);
  const bLoad = sim.loadOf(b!);
  sim.deck(b!, { kind: "metadata", duration: { kind: "known", ms: 200_000, source: "media-element" } });
  sim.deck(b!, { kind: "can-play", through: true });
  assert.equal(sim.snap.decks[bLoad.deck].seekEpoch, 0);
  sim.cueReady();
  sim.deck(a!, { kind: "time", positionMs: 194_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
  sim.cmd({ type: "seek", positionMs: 100_000 }); // cancels the preroll: B is held back to its start
  assert.equal(sim.snap.decks[bLoad.deck].seekEpoch, 1);
  assert.equal(sim.snap.decks[sim.loadOf(a!).deck].seekEpoch, 2);

  sim.cmd({ type: "next" });
  assert.equal(sim.snap.program?.item.itemId, b);
  const programDeck = sim.snap.decks[sim.snap.program!.deck!];
  assert.equal(programDeck.loadId, sim.loadOf(b!).loadId);
  const aDeck = sim.snap.decks[bLoad.deck === "A" ? "B" : "A"];
  assert.notEqual(aDeck.loadId, sim.loadOf(a!).loadId, "A's load is gone");
  assert.equal(aDeck.seekEpoch, 0, "a released deck carries no epoch over");
});
