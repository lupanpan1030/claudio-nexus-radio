import assert from "node:assert/strict";
import test from "node:test";
import { asId, PLAYBACK_BUDGETS, PLAYBACK_HTTP_TIMEOUTS, PLAYBACK_OPERATION_BUDGETS, type LoadId, type PlaybackReceipt, type ResolvedMedia } from "@claudio/contracts";
import { PortError, ReceiptReporter, createPlaybackRuntime, createStorageQueueStore, type PreparePort, type ReceiptPort } from "../src/index.js";
import { FakeDriver } from "../src/testing/index.js";
import { ControlledPort, ManualTimers, Ports, confirmPlaying, paused, createHarness, cueAsset, entry, flush, media, memoryStorage, resolvePrepare, type Harness } from "./helpers.js";

function itemIds(h: Harness): string[] {
  return h.runtime.getSnapshot().queue.map((e) => e.item.itemId);
}

async function startA(h: Harness, names = ["a", "b"]): Promise<void> {
  h.runtime.dispatch({ type: "enqueue", position: "end", entries: names.map((name) => entry(name)) });
  h.runtime.dispatch({ type: "resume" });
  await resolvePrepare(h, names[0]!);
  confirmPlaying(h, "A");
  await flush();
}

test("select → prepare port → driver load/play → confirmed playing → one started receipt with a stable key", async () => {
  const h = createHarness();
  await startA(h);
  const snapshot = h.runtime.getSnapshot();
  assert.equal(snapshot.transport, "playing");
  assert.equal(snapshot.program?.item.track.mediaId, "a");
  assert.deepEqual(
    h.driver.executed.filter((e) => "deck" in e && e.deck === "A").map((e) => e.type),
    ["deck.load", "deck.gain", "deck.play"]
  );
  const receipts = h.ports.receipts;
  assert.equal(h.log.filter((e) => e.event === "receipt.settled").length, 1);
  assert.deepEqual(snapshot.receipts, [{ itemId: snapshot.program!.item.itemId, status: "recorded" }]);
  // Pause/resume of the same item never produces another receipt.
  h.runtime.dispatch({ type: "pause" });
  h.driver.deckEvent("A", paused(1000, { requested: true }));
  h.runtime.dispatch({ type: "resume" });
  h.driver.deckEvent("A", { kind: "playing", positionMs: 1000 });
  await flush();
  assert.equal(h.log.filter((e) => e.event === "receipt.settled").length, 1);
  assert.equal(receipts.calls.length, 0, "auto-answered port, no manual calls");
});

test("getSnapshot is referentially stable, deeply frozen, and untouched by stale facts", async () => {
  const h = createHarness();
  await startA(h);
  const first = h.runtime.getSnapshot();
  assert.equal(h.runtime.getSnapshot(), first);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.decks.A) && Object.isFrozen(first.queue));
  let notified = 0;
  const unsubscribe = h.runtime.subscribe(() => notified++);
  h.driver.deckEvent("A", { kind: "playing", positionMs: 0 }, asId<LoadId>("test:load:old"));
  assert.equal(h.runtime.getSnapshot(), first, "a stale fact is rejected without a new snapshot");
  assert.equal(notified, 0);
  h.driver.deckEvent("A", { kind: "time", positionMs: 2500, rate: 1 });
  assert.notEqual(h.runtime.getSnapshot(), first);
  assert.equal(notified, 1, "one notification per processed input batch");
  unsubscribe();
});

test("pause and stop execute on the driver synchronously while prepare and narration ports never answer", async () => {
  const h = createHarness({ djEnabled: true });
  await startA(h, ["a", "b"]);
  const prepareB = h.ports.prepare.last((r) => r.track.mediaId === "b");
  const cue = h.ports.cue.last();
  const before = h.driver.executed.length;
  h.runtime.dispatch({ type: "pause" });
  // No await: the driver already paused the program deck.
  assert.deepEqual(h.driver.executed.slice(before).map((e) => e.type), ["deck.pause"]);
  h.runtime.dispatch({ type: "stop" });
  assert.ok(h.driver.executed.slice(before).some((e) => e.type === "deck.unload"));
  assert.equal(prepareB.signal.aborted, true, "cancelled prepare is aborted best-effort");
  assert.equal(cue.signal.aborted, true, "cancelled narration is aborted best-effort");
  assert.deepEqual(h.runtime.getSnapshot().pending, []);
  assert.equal(h.timers.size, 0, "no deadline timers left for cancelled operations");
});

test("rapid A→B→C: B's late source answer is dropped by identity; only C loads", async () => {
  const h = createHarness();
  await startA(h, ["a", "b", "c"]);
  const prepareB = h.ports.prepare.last((r) => r.track.mediaId === "b");
  h.runtime.dispatch({ type: "next" }); // → B (still resolving)
  h.runtime.dispatch({ type: "next" }); // → C
  assert.equal(prepareB.signal.aborted, true);
  await resolvePrepare(h, "c");
  const programDeck = h.runtime.getSnapshot().program!.deck!;
  confirmPlaying(h, programDeck);
  prepareB.resolve(media(prepareB.request.track));
  await flush();
  const loads = h.driver.effects("deck.load").map((e) => e.media.track.mediaId);
  assert.deepEqual(loads, ["a", "c"], "B never reaches the driver");
  assert.equal(h.runtime.getSnapshot().program?.item.track.mediaId, "c");
  assert.ok(h.log.some((e) => e.event === "operation.late"));
});

test("a narration port that never settles is closed by its deadline; the hand-over goes direct and the late cue is ignored", async () => {
  const h = createHarness({ djEnabled: true });
  await startA(h, ["a", "b"]);
  await resolvePrepare(h, "b");
  h.driver.deckEvent("B", { kind: "can-play", through: true });
  const cue = h.ports.cue.last();
  assert.equal(h.runtime.getSnapshot().transition?.mode, "sequential-talk");
  h.timers.advance(8_000);
  assert.equal(cue.signal.aborted, true);
  assert.equal(h.runtime.getSnapshot().transition?.mode, "direct");
  assert.ok(h.log.some((e) => e.event === "note" && JSON.stringify(e.data).includes("timed-out")));
  h.driver.deckEvent("A", { kind: "ended" });
  assert.equal(h.runtime.getSnapshot().program?.item.track.mediaId, "b");
  cue.resolve(cueAsset());
  await flush();
  assert.equal(h.driver.effects("voice.load").length, 0);
  assert.equal(h.driver.effects("voice.play").length, 0);
});

test("sequential talk through the runtime: A ends → voice → B, with cue/voice identities from the port answer", async () => {
  const h = createHarness({ djEnabled: true });
  await startA(h, ["a", "b"]);
  await resolvePrepare(h, "b");
  h.driver.deckEvent("B", { kind: "can-play", through: true });
  const cue = h.ports.cue.last();
  cue.resolve(cueAsset("下一首"));
  await flush();
  const load = h.driver.effects("voice.load")[0]!;
  assert.equal(load.cueId, cue.request.binding.cueId);
  h.driver.voiceEvent({ kind: "can-play", through: true });
  h.driver.deckEvent("A", { kind: "ended" });
  assert.equal(h.driver.effects("voice.play").length, 1);
  h.driver.voiceEvent({ kind: "playing", positionMs: 0 });
  assert.equal(h.runtime.getSnapshot().display.kind, "voice");
  h.driver.voiceEvent({ kind: "ended" });
  assert.equal(h.runtime.getSnapshot().program?.item.track.mediaId, "b");
  assert.ok(h.driver.effects("deck.play").some((e) => e.deck === "B"));
});

test("natural end reported as the browser does (pause with atEnd → ended) still hands over", async () => {
  const h = createHarness({ djEnabled: false });
  await startA(h, ["a", "b"]);
  await resolvePrepare(h, "b");
  h.driver.deckEvent("B", { kind: "can-play", through: true });
  h.driver.deckEvent("A", paused(200_000, { atEnd: true }));
  assert.notEqual(h.runtime.getSnapshot().transport, "paused", "the end-of-media pause is not an interruption");
  h.driver.deckEvent("A", { kind: "ended" });
  assert.notEqual(h.runtime.getSnapshot().transport, "paused", "end of media is not a user pause");
  assert.ok(h.driver.effects("deck.play").some((e) => e.deck === "B"));
  assert.equal(h.runtime.getSnapshot().program?.item.track.mediaId, "b");
});

test("started receipt: bounded retries with the identical idempotency key; final failure is observable and never touches audio", async () => {
  const ports = new Ports();
  ports.receipts.auto = null;
  const h = createHarness({ ports, receiptPolicy: { maxAttempts: 3, backoffMs: [1_000, 2_000] } });
  await startA(h);
  const failRetryable = () => h.ports.receipts.calls.at(-1)!.reject(new PortError({ class: "retryable", code: "http_503" }));
  failRetryable();
  await flush();
  h.timers.advance(1_000);
  failRetryable();
  await flush();
  h.timers.advance(2_000);
  failRetryable();
  await flush();
  const calls = h.ports.receipts.calls;
  assert.equal(calls.length, 3);
  const keys = new Set(calls.map((c) => c.request.idempotencyKey));
  assert.equal(keys.size, 1);
  assert.deepEqual(calls[2]!.request, calls[0]!.request satisfies PlaybackReceipt);
  const snapshot = h.runtime.getSnapshot();
  assert.equal(snapshot.receipts[0]?.status, "failed");
  assert.equal(snapshot.transport, "playing");
  assert.equal(h.driver.effects("deck.pause").length, 0);
});

test("a non-retryable receipt rejection stops after one attempt; a hung receipt sink is bounded per attempt", async () => {
  const ports = new Ports();
  ports.receipts.auto = null;
  const h = createHarness({ ports, receiptPolicy: { maxAttempts: 2, attemptTimeoutMs: 3_000, backoffMs: [500] } });
  await startA(h, ["a", "b", "c"]);
  h.ports.receipts.calls[0]!.reject(new PortError({ class: "invalid", code: "bad_receipt" }));
  await flush();
  assert.equal(h.ports.receipts.calls.length, 1);
  assert.equal(h.runtime.getSnapshot().receipts[0]?.status, "failed");
  h.runtime.dispatch({ type: "next" });
  await resolvePrepare(h, "b");
  confirmPlaying(h, h.runtime.getSnapshot().program!.deck!);
  await flush();
  assert.equal(h.ports.receipts.calls.length, 2);
  h.timers.advance(3_000); // attempt 1 hangs → deadline
  assert.equal(h.ports.receipts.calls[1]!.signal.aborted, true);
  h.timers.advance(500);
  assert.equal(h.ports.receipts.calls.length, 3, "retried once");
  h.timers.advance(3_000);
  await flush();
  assert.equal(h.runtime.getSnapshot().receipts.find((r) => r.status !== "failed"), undefined);
});

test("dispose aborts in-flight ports, releases the driver, ignores late answers and leaves no timers or listeners", async () => {
  const h = createHarness({ djEnabled: true });
  await startA(h, ["a", "b"]);
  const prepareB = h.ports.prepare.last((r) => r.track.mediaId === "b");
  const cue = h.ports.cue.last();
  let calls = 0;
  h.runtime.subscribe(() => calls++);
  const last = h.runtime.getSnapshot();
  await h.runtime.dispose();
  assert.equal(h.runtime.disposed, true);
  assert.equal(h.driver.disposed, true);
  assert.equal(prepareB.signal.aborted, true);
  assert.equal(cue.signal.aborted, true);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.runtime.dispatch({ type: "resume" }), { accepted: false, reason: "disposed" });
  const executed = h.driver.executed.length;
  prepareB.resolve(media(prepareB.request.track));
  cue.resolve(cueAsset());
  await flush();
  assert.equal(h.driver.executed.length, executed);
  assert.equal(h.runtime.getSnapshot(), last);
  assert.equal(calls, 0);
  await h.runtime.dispose(); // idempotent
});

test("a second source and a second TTS plug in through ports only; the same runtime and core play them", async () => {
  const local = new ControlledPort<Parameters<PreparePort["resolve"]>[0], ResolvedMedia>();
  const alt = new ControlledPort<Parameters<PreparePort["resolve"]>[0], ResolvedMedia>();
  local.auto = (request) => media(request.track);
  alt.auto = (request) => ({ ...media(request.track), recording: { recordingId: asId(`alt-rec-${request.track.mediaId}`), confidence: "content-hash" } });
  const bySource: Record<string, ControlledPort<Parameters<PreparePort["resolve"]>[0], ResolvedMedia>> = { local, "alt-source": alt };
  const ttsCalls: string[] = [];
  const h = createHarness({
    djEnabled: true,
    portsOverride: {
      // Composition-level routing; neither runtime nor core knows the names.
      prepare: { resolve: (request, signal) => bySource[request.track.providerId]!.invoke(request, signal) },
      cue: {
        request: async (request) => {
          ttsCalls.push(`fake-tts-2:${request.binding.cueId}`);
          return cueAsset("换了一个声音", "tts2/voice");
        }
      }
    }
  });
  h.runtime.dispatch({ type: "enqueue", position: "end", entries: [entry("x", "local"), entry("y", "alt-source")] });
  h.runtime.dispatch({ type: "resume" });
  await flush();
  confirmPlaying(h, "A");
  await flush();
  h.driver.deckEvent("B", { kind: "can-play", through: true });
  await flush();
  h.driver.voiceEvent({ kind: "can-play", through: true });
  h.driver.deckEvent("A", { kind: "ended" });
  h.driver.voiceEvent({ kind: "playing", positionMs: 0 });
  h.driver.voiceEvent({ kind: "ended" });
  confirmPlaying(h, "B");
  await flush();
  assert.equal(ttsCalls.length, 1);
  assert.equal(h.driver.effects("voice.load")[0]?.asset.voice.stream.handle, "tts2/voice");
  const receipts = h.log.filter((e) => e.event === "effect" && (e.data as { type: string }).type === "receipt.report").map((e) => (e.data as { receipt: PlaybackReceipt }).receipt);
  assert.deepEqual(
    receipts.map((r) => [r.track.providerId, r.recordingId]),
    [
      ["local", "rec-local-x"],
      ["alt-source", "alt-rec-y"]
    ]
  );
});

test("a driver exception becomes a media error for that identity instead of wedging the serial loop", async () => {
  class ThrowingDriver extends FakeDriver {
    override execute(effect: Parameters<FakeDriver["execute"]>[0]): void {
      super.execute(effect);
      if (effect.type === "deck.play") throw new Error("boom");
    }
  }
  const ports = new Ports();
  ports.prepare.auto = (request) => media(request.track);
  const driver = new ThrowingDriver();
  const runtime = createPlaybackRuntime({ driver, ports: ports.bound, instanceId: "throw", initialSettings: { djEnabled: false } });
  runtime.dispatch({ type: "enqueue", position: "end", entries: [entry("a")] });
  runtime.dispatch({ type: "resume" });
  await flush();
  const snapshot = runtime.getSnapshot();
  // One failed item below the failure bound with nothing else queued: still wants to play, waiting for more.
  assert.equal(snapshot.transport, "exhausted");
  assert.equal(snapshot.history[0]?.outcome, "failed");
  assert.equal(snapshot.history[0]?.started, false);
  assert.equal(runtime.dispatch({ type: "pause" }).accepted, true, "still accepting input");
  await runtime.dispose();
});

test("queue intent is persisted by the executor and restored stopped: nothing prepares or plays until resume", async () => {
  const storage = memoryStorage();
  const store = createStorageQueueStore(storage, "claudio.queue");
  const first = createHarness({ queueStore: store });
  await startA(first, ["a", "b", "c"]);
  await first.runtime.dispose();
  const saved = JSON.parse(storage.data.get("claudio.queue")!);
  assert.deepEqual(saved.entries.map((e: { track: { mediaId: string } }) => e.track.mediaId), ["a", "b", "c"]);

  const second = createHarness({ queueStore: store });
  const snapshot = second.runtime.getSnapshot();
  assert.equal(snapshot.transport, "idle");
  assert.deepEqual(snapshot.queue.map((e) => [e.item.track.mediaId, e.item.origin]), [
    ["a", "restore"],
    ["b", "restore"],
    ["c", "restore"]
  ]);
  assert.equal(second.ports.prepare.calls.length, 0);
  assert.equal(second.driver.executed.filter((e) => e.type !== "output.volume").length, 0);
  assert.notDeepEqual(itemIds(second), [], "new item identities");

  storage.setItem("claudio.queue", "{not json");
  const third = createHarness({ queueStore: store });
  assert.deepEqual(third.runtime.getSnapshot().queue, [], "malformed storage is ignored, not half-applied");
});

test("a reload while the DJ talks after A's natural end resumes from B: A is not replayed, nothing restarts by itself", async () => {
  const savedIds = (storage: ReturnType<typeof memoryStorage>) =>
    JSON.parse(storage.data.get("claudio.queue")!).entries.map((e: { track: { mediaId: string } }) => e.track.mediaId);
  for (const voice of ["starting", "speaking", "paused"] as const) {
    const storage = memoryStorage();
    const store = createStorageQueueStore(storage, "claudio.queue");
    const first = createHarness({ djEnabled: true, queueStore: store });
    await startA(first, ["a", "b", "c"]);
    await resolvePrepare(first, "b");
    first.driver.deckEvent("B", { kind: "can-play", through: true });
    first.ports.cue.last().resolve(cueAsset("下一首"));
    await flush();
    first.driver.voiceEvent({ kind: "can-play", through: true });
    assert.deepEqual(savedIds(storage), ["a", "b", "c"]);
    first.driver.deckEvent("A", paused(200_000, { atEnd: true }));
    first.driver.deckEvent("A", { kind: "ended" });
    if (voice !== "starting") first.driver.voiceEvent({ kind: "playing", positionMs: 0 });
    if (voice === "paused") {
      first.runtime.dispatch({ type: "voice.pause" });
      first.driver.voiceEvent(paused(1_000, { requested: true }));
    }
    const before = first.runtime.getSnapshot();
    assert.equal(before.program?.item.track.mediaId, "a", voice);
    assert.equal(before.voice?.status, voice);
    assert.deepEqual(savedIds(storage), ["b", "c"], `${voice}: saved as soon as A ended`);
    await first.runtime.dispose();
    assert.deepEqual(savedIds(storage), ["b", "c"], voice);

    const second = createHarness({ djEnabled: true, queueStore: store });
    const restored = second.runtime.getSnapshot();
    assert.equal(restored.transport, "idle");
    assert.equal(restored.voice, null);
    assert.equal(restored.program, null);
    assert.deepEqual(restored.queue.map((e) => [e.item.track.mediaId, e.item.origin]), [
      ["b", "restore"],
      ["c", "restore"]
    ]);
    assert.equal(second.ports.prepare.calls.length, 0);
    assert.equal(second.ports.cue.calls.length, 0);
    assert.equal(second.driver.executed.filter((e) => e.type !== "output.volume").length, 0, "no automatic play");

    second.runtime.dispatch({ type: "resume" });
    assert.equal(second.ports.prepare.calls[0]?.request.track.mediaId, "b", "explicit play starts B");
    await second.runtime.dispose();
  }
});

test("a reload while A is paused in the middle still resumes A first", async () => {
  const storage = memoryStorage();
  const store = createStorageQueueStore(storage, "claudio.queue");
  const first = createHarness({ djEnabled: true, queueStore: store });
  await startA(first, ["a", "b", "c"]);
  await resolvePrepare(first, "b");
  first.runtime.dispatch({ type: "pause" });
  first.driver.deckEvent("A", paused(90_000, { requested: true }));
  assert.equal(first.runtime.getSnapshot().transport, "paused");
  await first.runtime.dispose();
  const saved = JSON.parse(storage.data.get("claudio.queue")!);
  assert.deepEqual(saved.entries.map((e: { track: { mediaId: string } }) => e.track.mediaId), ["a", "b", "c"]);
});

test("dispose during an in-flight receipt: a fetch-like port rejecting on abort schedules no retry timer and emits nothing", async () => {
  const timers = new ManualTimers();
  const facts: unknown[] = [];
  let calls = 0;
  const port: ReceiptPort = {
    report: (_receipt, signal) => {
      calls += 1;
      // Like fetch: rejects with the abort reason once the signal aborts.
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
  };
  const reporter = new ReceiptReporter({ port, emit: (fact) => facts.push(fact), clock: () => timers.now, timers, policy: { maxAttempts: 4, backoffMs: [1_000] } });
  const receipt = { idempotencyKey: asId("k1"), itemId: asId("i1"), loadId: asId("L1") } as unknown as PlaybackReceipt;
  const done = reporter.report(receipt);
  assert.equal(timers.size, 1, "attempt deadline armed");
  reporter.dispose();
  assert.equal(await done, "failed");
  await flush(); // the abort rejection settles in a later microtask
  assert.equal(timers.size, 0, "no backoff timer created after dispose");
  assert.equal(reporter.activeCount, 0);
  timers.advance(60_000);
  assert.equal(calls, 1, "no retry");
  assert.deepEqual(facts, []);
});

test("without configured guards the runtime uses the shared budget: a slow but healthy cue is delivered, a hung source ends at the prepare guard", async () => {
  const h = createHarness({ djEnabled: true, deadlines: {} });
  await startA(h, ["a", "b"]);
  await resolvePrepare(h, "b");
  const cue = h.ports.cue.last();
  // Script and voice both run to their full server budget; the long-poll in flight then answers.
  h.timers.advance(PLAYBACK_BUDGETS.scriptMs + PLAYBACK_BUDGETS.voiceMs + PLAYBACK_HTTP_TIMEOUTS.longPollRequestMs);
  assert.equal(cue.signal.aborted, false, "the old 30 s guard would have cancelled this cue long ago");
  cue.resolve(cueAsset());
  await flush();
  const load = h.driver.executed.find((e) => e.type === "voice.load");
  assert.ok(load && load.type === "voice.load" && load.cueId === cue.request.binding.cueId, "the cue's voice is loaded");

  const hung = createHarness({ deadlines: {} });
  hung.runtime.dispatch({ type: "enqueue", position: "end", entries: [entry("x")] });
  hung.runtime.dispatch({ type: "resume" });
  const prepare = hung.ports.prepare.last();
  hung.timers.advance(PLAYBACK_OPERATION_BUDGETS.prepare - 1);
  assert.equal(prepare.signal.aborted, false);
  assert.deepEqual(hung.runtime.getSnapshot().pending.map((op) => op.kind), ["prepare"]);
  hung.timers.advance(1);
  await flush();
  assert.equal(prepare.signal.aborted, true);
  assert.deepEqual(hung.runtime.getSnapshot().pending, []);
  assert.equal(hung.runtime.getSnapshot().history.at(-1)?.outcome, "failed");
});

test("selecting an existing queue row through the runtime reuses B's preheated deck and preparation, keeps the queue and drops the old cue", async () => {
  const h = createHarness({ djEnabled: true });
  await startA(h, ["a", "b", "c"]);
  await resolvePrepare(h, "b");
  h.driver.deckEvent("B", { kind: "can-play", through: true });
  const [b, c] = itemIds(h);
  const cue = h.ports.cue.last();
  const prepares = h.ports.prepare.calls.length;
  const executed = h.driver.executed.length;

  h.runtime.dispatch({ type: "select", target: { kind: "item", itemId: asId(b!) } });
  const after = h.driver.executed.slice(executed);
  assert.equal(after.some((e) => e.type === "deck.load"), false, "B is not reloaded");
  assert.deepEqual(after.filter((e) => e.type === "deck.play").map((e) => "deck" in e && e.deck), ["B"]);
  assert.equal(h.ports.prepare.calls.length, prepares, "no new preparation");
  assert.equal(cue.signal.aborted, true, "the A→B narration request is aborted");
  assert.deepEqual(itemIds(h), [b, c]);
  assert.equal(h.runtime.getSnapshot().program?.item.itemId, b);

  h.driver.deckEvent("B", { kind: "playing", positionMs: 0 });
  await flush();
  assert.deepEqual(h.runtime.getSnapshot().receipts.map((r) => r.itemId).at(-1), b);
  assert.equal(h.log.filter((e) => e.event === "receipt.settled").length, 2, "A and B, once each");
});
