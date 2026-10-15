import assert from "node:assert/strict";
import test from "node:test";
import { asId, type LyricsAsset } from "@claudio/contracts";
import { Sim } from "./harness.js";

function crossfadeWithProviderDuration(providerMs: number) {
  const sim = new Sim({ preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8000 });
  const [a, b] = sim.enqueue("a", "b");
  sim.cmd({ type: "resume" });
  sim.resolve(a!, { durationMs: providerMs });
  sim.deck(a!, { kind: "playing", positionMs: 0 });
  sim.resolve(b!);
  sim.deck(b!, { kind: "can-play", through: true });
  sim.cueReady();
  return { sim, a: a!, b: b! };
}

const element = (ms: number) => ({ kind: "metadata" as const, duration: { kind: "known" as const, ms, source: "media-element" as const } });

test("provider duration too short: the element's measurement keeps the window from opening early", () => {
  const { sim, a } = crossfadeWithProviderDuration(120_000);
  sim.deck(a, element(200_000));
  sim.deck(a, { kind: "time", positionMs: 113_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "planned", "provider anchor 112 s would have been too early");
  assert.equal(sim.snap.transition?.anchorMs, 192_000);
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
});

test("provider duration too long: the element's measurement keeps the window from being missed", () => {
  const { sim, a } = crossfadeWithProviderDuration(300_000);
  sim.deck(a, element(200_000));
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling", "provider anchor 292 s would only be reached after A ended");
});

test("weaker or unknown durations never overwrite a measured one; a later element durationchange does", () => {
  const { sim, a } = crossfadeWithProviderDuration(120_000);
  const deckId = sim.loadOf(a).deck;
  sim.deck(a, element(200_000));
  sim.deck(a, { kind: "metadata", duration: { kind: "known", ms: 120_000, source: "provider-metadata" } });
  sim.deck(a, { kind: "metadata", duration: { kind: "unknown" } });
  assert.deepEqual(sim.snap.decks[deckId].duration, { kind: "known", ms: 200_000, source: "media-element" });

  sim.deck(a, element(210_000));
  assert.equal(sim.snap.decks[deckId].duration.kind === "known" && sim.snap.decks[deckId].duration.ms, 210_000);
  sim.deck(a, { kind: "time", positionMs: 195_000, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "planned");
  assert.equal(sim.snap.transition?.anchorMs, 202_000);
  sim.deck(a, { kind: "time", positionMs: 202_500, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
});

test("an unknown element duration keeps the provider value instead of inventing one", () => {
  const { sim, a } = crossfadeWithProviderDuration(200_000);
  sim.deck(a, { kind: "metadata", duration: { kind: "unknown" } });
  sim.deck(a, { kind: "time", positionMs: 192_500, rate: 1 });
  assert.equal(sim.snap.transition?.phase, "prerolling");
});

function lyrics(recordingId: string, sourceRevision: string): LyricsAsset {
  return { assetId: asId("l"), recordingId: asId(recordingId), sourceRevision: asId(sourceRevision), timing: "native-line", offsetMs: 0, lines: [{ startMs: 0, text: "la" }] };
}

test("lyrics of another recording under the same revision are unmatched and never displayed", () => {
  const sim = new Sim({}, { djEnabled: false });
  const [a] = sim.enqueue("a");
  sim.cmd({ type: "resume" });
  sim.startProgram(a!);
  const request = sim.lastEffect("lyrics.request");
  assert.equal(request.recordingId, "rec-a");
  const result = sim.fact({
    type: "lyrics.result",
    opId: request.opId,
    itemId: a!,
    sourceRevision: request.sourceRevision,
    result: { status: "available", asset: lyrics("rec-someone-else", request.sourceRevision) }
  });
  assert.ok(result.notes.some((n) => n.reason.includes("mismatch")));
  const display = sim.snap.display;
  assert.ok(display.kind === "music" && display.lyrics.status === "unmatched");
});

test("lyrics bound to the requested recording and revision are displayed", () => {
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
    result: { status: "available", asset: lyrics(request.recordingId, request.sourceRevision) }
  });
  const display = sim.snap.display;
  assert.ok(display.kind === "music" && display.lyrics.status === "available");
});
