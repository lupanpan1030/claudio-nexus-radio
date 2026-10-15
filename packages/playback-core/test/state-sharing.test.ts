import assert from "node:assert/strict";
import test from "node:test";
import { asId, type LyricsAsset } from "@claudio/contracts";
import { Sim } from "./harness.js";
import type { PlaybackState } from "../src/index.js";

function bigLyrics(recordingId: string, sourceRevision: string): LyricsAsset {
  return {
    assetId: asId("lyrics-big"),
    recordingId: asId(recordingId),
    sourceRevision: asId(sourceRevision),
    timing: "native-line",
    offsetMs: 0,
    lines: Array.from({ length: 5000 }, (_, index) => ({ startMs: index * 40, text: `line ${index}` }))
  };
}

function playingWithLyricsAndCue() {
  const sim = new Sim();
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  const request = sim.lastEffect("lyrics.request");
  sim.fact({
    type: "lyrics.result",
    opId: request.opId,
    itemId: a!,
    sourceRevision: request.sourceRevision,
    result: { status: "available", asset: bigLyrics(request.recordingId, request.sourceRevision) }
  });
  sim.resolve(b!);
  sim.cueReady();
  return { sim, a: a!, b: b! };
}

function assertDeepFrozen(value: unknown, path = "state"): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value), `${path} is frozen`);
  for (const [key, entry] of Object.entries(value)) assertDeepFrozen(entry, `${path}.${key}`);
}

test("a time fact copies only the touched partitions and shares immutable payloads", () => {
  const { sim, a } = playingWithLyricsAndCue();
  const before = sim.state;
  const deckId = sim.loadOf(a).deck;
  sim.tick(250);
  sim.deck(a, { kind: "time", positionMs: 250, rate: 1 });
  const after = sim.state;

  assert.notEqual(after, before);
  assert.notEqual(after.decks[deckId], before.decks[deckId], "edited deck is a new object");
  assert.equal(after.decks[deckId].clock?.positionMs, 250);
  assert.equal(before.decks[deckId].clock?.positionMs, 0, "previous state keeps its clock");
  assert.equal(after.lyrics[a]!.view, before.lyrics[a]!.view, "5000-line lyrics view shared, not copied");
  assert.equal(after.cue!.asset, before.cue!.asset, "cue asset shared");
  assert.equal(after.cue!.binding, before.cue!.binding);
  assert.equal(after.decks[deckId].media, before.decks[deckId].media, "resolved media shared");
  assert.equal(after.queue[0]!.item, before.queue[0]!.item, "queue item shared");
  assert.equal(after.history[0], before.history[0]);
  assert.equal(after.config, before.config);
});

test("inputs are never changed and every returned state is deeply frozen", () => {
  const { sim, a } = playingWithLyricsAndCue();
  const states: PlaybackState[] = [sim.state];
  const copies = [structuredClone(sim.state)];
  const record = () => {
    states.push(sim.state);
    copies.push(structuredClone(sim.state));
  };
  sim.deck(a, { kind: "time", positionMs: 1000, rate: 1 });
  record();
  sim.cmd({ type: "pause" });
  record();
  sim.cmd({ type: "resume" });
  record();
  sim.naturalEnd(a);
  record();
  sim.voice({ kind: "playing", positionMs: 0 });
  record();
  sim.cmd({ type: "next" });
  record();

  states.forEach((state, index) => {
    assert.deepEqual(structuredClone(state), copies[index], `state ${index} unchanged by later steps`);
    assertDeepFrozen(state, `state[${index}]`);
  });
  const latest = sim.state as unknown as { queue: unknown[]; decks: { A: { status: string } } };
  assert.throws(() => latest.queue.push({}), TypeError);
  assert.throws(() => {
    latest.decks.A.status = "playing";
  }, TypeError);
});
