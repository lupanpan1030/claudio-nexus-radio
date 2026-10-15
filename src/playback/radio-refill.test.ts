import assert from "node:assert/strict";
import { test } from "node:test";
import { asId, type CueAsset, type LyricsAvailability, type PlaybackSnapshot, type QueueItemId } from "@claudio/contracts";
import { createSequentialIds, withReservations } from "@claudio/playback-core";
import { createPlaybackRuntime, type PlaybackRuntime } from "@claudio/playback-web";
import { FakeDriver } from "@claudio/playback-web/testing";
import { registerMediaSessionActions } from "../features/media-controls";
import { PlaybackController, type OwnerServices } from "./controller";
import { HttpPreparePort, PreparationClient } from "./preparation";
import { RadioRefill, refillContext } from "./radio-refill";
import { FakePlaybackServer, ManualTimers, TEST_PATHS, flush, mediaWire, ref } from "./test-support";

/** Real runtime + real core + fake driver, wired like the app's owner page, over a fake v1 server. */
function ownerRig(options: { autoReady?: boolean } = {}) {
  const server = new FakePlaybackServer();
  server.autoReady = options.autoReady ?? true;
  const client = new PreparationClient(server.fetch, TEST_PATHS, { waitMs: 50, requestTimeoutMs: 2000, cancelTimeoutMs: 200 });
  const prepare = new HttpPreparePort(client);
  const driver = new FakeDriver(() => 1000);
  const ids = withReservations(createSequentialIds("exec-test"));
  const never = <T,>() => new Promise<T>(() => {});
  const runtime: PlaybackRuntime = createPlaybackRuntime({
    driver,
    instanceId: "exec-test",
    ids,
    clock: () => 1000,
    ports: {
      prepare,
      cue: { request: () => never<CueAsset>() },
      lyrics: { lookup: async (): Promise<LyricsAvailability> => ({ status: "missing", reason: "not-found" }) },
      receipts: { report: async () => "recorded" as const }
    }
  });
  const timers = new ManualTimers();
  let owner: OwnerServices | null = null;
  const host = {
    getView: () => ({ role: "executor" as const, executorInstanceId: runtime.instanceId, snapshot: runtime.getSnapshot(), canControl: true, exclusive: true }),
    dispatch: runtime.dispatch.bind(runtime),
    unlockAudio: () => runtime.unlockAudio()
  };
  const controller = new PlaybackController(host, () => owner);
  const refill = new RadioRefill({ target: runtime, client, port: prepare, ids, userActionSeq: controller.getUserActionSeq, timers, policy: { maxAttempts: 3, backoffMs: [100] } });
  owner = { refill, ids };
  return { server, runtime, driver, refill, controller, timers, snapshot: (): PlaybackSnapshot => runtime.getSnapshot() };
}

const loadOf = (driver: FakeDriver) => driver.executed.filter((effect) => effect.type === "deck.load");

test("play on an empty queue: one radio preparation, enqueued under the pre-allocated id, then played", async () => {
  const rig = ownerRig();
  rig.controller.togglePlay();
  await flush();
  const prepares = rig.server.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/playback/prepare");
  assert.equal(prepares.length, 1, "the runtime's PreparePort adopted the refill preparation instead of POSTing again");
  const radioItemId = (prepares[0]?.body as { itemId: QueueItemId }).itemId;
  assert.equal((prepares[0]?.body as { purpose: string }).purpose, "program");
  const snapshot = rig.snapshot();
  assert.equal(snapshot.program?.item.itemId ?? snapshot.queue[0]?.item.itemId, radioItemId);
  assert.equal(loadOf(rig.driver).length, 1, "resume loaded the candidate");
  assert.equal(rig.driver.unlocked > 0, true, "audio unlocked inside the gesture");
});

test("a pause during candidate selection keeps the candidate queued but silent", async () => {
  const rig = ownerRig({ autoReady: false });
  rig.controller.togglePlay();
  await flush();
  rig.controller.togglePlay(); // listener changes their mind: a pause intent (chat seq unchanged)
  rig.server.publish("prep-1", { candidate: { status: "ready", value: { track: ref("R1"), display: null } }, source: { status: "ready", value: mediaWire(ref("R1")) } });
  await flush();
  const snapshot = rig.snapshot();
  assert.equal(snapshot.queue.length + (snapshot.program ? 1 : 0), 1);
  assert.equal(loadOf(rig.driver).length, 0, "no deck.load: nothing plays after the listener's later intent");
});

test("background refill: singleflight per program, never resumes, and a stale candidate is cancelled", async () => {
  const rig = ownerRig({ autoReady: false });
  const stale = refillContext(rig.snapshot());
  assert.equal(stale, null, "nothing to refill while stopped and empty");
  rig.refill.start();
  // Start a user track so a program exists and has started.
  rig.controller.playTrack({ track: ref("A"), display: { title: "A", artist: "x" }, origin: "user" });
  await flush();
  const prepA = [...rig.server.preparations.values()].find((record) => record.item.stages.candidate.status !== "failed");
  assert.ok(prepA);
  rig.server.publish(prepA.item.preparationId, { candidate: { status: "ready", value: { track: ref("A"), display: null } }, source: { status: "ready", value: mediaWire(ref("A")) } });
  await flush();
  const load = loadOf(rig.driver)[0];
  assert.ok(load && load.type === "deck.load");
  rig.driver.deckEvent(load.deck, { kind: "can-play", through: true }, load.loadId);
  rig.driver.deckEvent(load.deck, { kind: "playing", positionMs: 0 }, load.loadId);
  await flush();
  assert.equal(rig.snapshot().program?.started, true);
  const radioPosts = () => rig.server.requests.filter((request) => request.method === "POST" && (request.body as { target?: { kind: string } }).target?.kind === "radio-candidate");
  assert.equal(radioPosts().length, 1, "one refill for the started program");
  // Another snapshot change must not start a second request.
  rig.controller.setVolume(0.3);
  await flush();
  assert.equal(radioPosts().length, 1);
  // The listener queues something before the candidate arrives: context changes → refill cancelled.
  rig.controller.apply([{ type: "enqueue", entries: [{ track: ref("Q"), display: null, origin: "user" }], position: "next" }], { gesture: true });
  await flush();
  const radioPrep = [...rig.server.preparations.values()].find((record) => record.item.itemId === (radioPosts()[0]?.body as { itemId: string }).itemId);
  assert.ok(radioPrep);
  assert.equal(rig.server.count("DELETE", `/api/v1/playback/preparations/${radioPrep.item.preparationId}`), 1);
  assert.equal(rig.snapshot().transport, "playing");
  assert.ok(!rig.snapshot().queue.some((entry) => entry.item.origin === "radio"), "stale candidate not queued");
});

test("no_candidate stops retrying for that program; other failures retry a bounded number of times", async () => {
  const rig = ownerRig();
  rig.server.radioPick = null;
  rig.controller.togglePlay();
  await flush();
  assert.equal(rig.refill.getStatus().phase, "no-candidate");
  rig.timers.advance(10_000);
  await flush();
  assert.equal(rig.server.count("POST", "/api/v1/playback/prepare"), 1);

  const flaky = ownerRig();
  flaky.server.failNextPrepare = { status: 503, code: "upstream_busy", class: "retryable" };
  flaky.controller.togglePlay();
  await flush();
  assert.equal(flaky.refill.getStatus().phase, "retry-wait");
  flaky.timers.advance(100);
  await flush();
  assert.equal(flaky.server.count("POST", "/api/v1/playback/prepare"), 2);
  assert.ok(loadOf(flaky.driver).length === 1, "second attempt delivered and played (seq unchanged)");
});

test("Previous replays the last started track as a new occurrence and does not bounce A/B", async () => {
  const rig = ownerRig();
  const startCurrent = async () => {
    await flush();
    const load = loadOf(rig.driver).at(-1);
    assert.ok(load && load.type === "deck.load");
    rig.driver.deckEvent(load.deck, { kind: "can-play", through: true }, load.loadId);
    rig.driver.deckEvent(load.deck, { kind: "playing", positionMs: 0 }, load.loadId);
    await flush();
  };
  rig.controller.playTrack({ track: ref("A"), display: null, origin: "user" });
  await startCurrent();
  rig.controller.playTrack({ track: ref("B"), display: null, origin: "user" });
  await startCurrent();
  rig.controller.playTrack({ track: ref("C"), display: null, origin: "user" });
  await startCurrent();
  assert.equal(rig.controller.canPrevious(rig.snapshot()), true);
  rig.controller.previous();
  await startCurrent();
  assert.equal(rig.snapshot().program?.item.track.mediaId, "B");
  rig.controller.previous();
  await startCurrent();
  assert.equal(rig.snapshot().program?.item.track.mediaId, "A", "second press goes further back instead of returning to C");
  const ids = new Set([...rig.snapshot().history.map((entry) => entry.item.itemId), rig.snapshot().program?.item.itemId]);
  assert.equal(ids.size, rig.snapshot().history.length + 1, "every occurrence has its own item id");
});

test("refill context key is shared by 'after program' and the exhausted queue that follows it", () => {
  const base = { queue: [], history: [], program: null } as unknown as PlaybackSnapshot;
  const exhausted = { ...base, transport: "exhausted", history: [{ item: { itemId: asId<QueueItemId>("i1") }, outcome: "played", started: true }] } as unknown as PlaybackSnapshot;
  const playing = { ...base, transport: "playing", program: { item: { itemId: asId<QueueItemId>("i1") }, started: true } } as unknown as PlaybackSnapshot;
  assert.equal(refillContext(exhausted)?.key, refillContext(playing)?.key);
});

/** A recording stand-in for navigator.mediaSession: keeps exactly what the app registered. */
function fakeMediaSession() {
  const handlers = new Map<string, MediaSessionActionHandler | null>();
  return {
    handlers,
    setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
      handlers.set(action, handler);
    },
    invoke(action: MediaSessionAction) {
      const handler = handlers.get(action);
      assert.ok(handler, `${action} registered`);
      handler({ action } as MediaSessionActionDetails);
    }
  };
}

async function startPlaying(rig: ReturnType<typeof ownerRig>) {
  await flush();
  const load = loadOf(rig.driver).at(-1);
  assert.ok(load && load.type === "deck.load");
  rig.driver.deckEvent(load.deck, { kind: "can-play", through: true }, load.loadId);
  rig.driver.deckEvent(load.deck, { kind: "playing", positionMs: 0 }, load.loadId);
  await flush();
  return load;
}

test("media session: registered play/pause are idempotent; only the main button toggles", async () => {
  const rig = ownerRig();
  const session = fakeMediaSession();
  const cleanup = registerMediaSessionActions(session, rig.controller);
  rig.controller.playTrack({ track: ref("A"), display: null, origin: "user" });
  const load = await startPlaying(rig);
  assert.equal(rig.snapshot().transport, "playing");
  const pauses = () => rig.driver.effects("deck.pause").length;
  const plays = () => rig.driver.effects("deck.play").length;

  const playsBefore = plays();
  session.invoke("play");
  await flush();
  assert.equal(rig.snapshot().transport, "playing", "play while playing keeps playing");
  assert.equal(pauses(), 0);

  session.invoke("pause");
  await flush();
  rig.driver.deckEvent(load.deck, { kind: "paused", positionMs: 500, atEnd: false } as never, load.loadId);
  await flush();
  assert.equal(rig.snapshot().transport, "paused");
  const pausesAfterFirst = pauses();
  assert.equal(pausesAfterFirst, 1);
  session.invoke("pause");
  await flush();
  assert.equal(rig.snapshot().transport, "paused", "pause while paused stays paused (never resumes)");
  assert.equal(plays(), playsBefore, "no deck.play from a repeated pause");
  assert.equal(pauses(), pausesAfterFirst);

  session.invoke("play");
  await flush();
  assert.equal(plays(), playsBefore + 1, "play while paused resumes once");
  assert.notEqual(rig.snapshot().transport, "paused");

  rig.controller.togglePlay();
  await flush();
  assert.equal(rig.snapshot().transport, "paused", "the main button still toggles");
  assert.equal(rig.controller.getUserActionSeq(), 1, "pause/resume never advanced the chat seq (only the select did)");

  cleanup();
  assert.deepEqual([...session.handlers.values()], [null, null, null, null], "cleanup unregisters every action");
});

test("explicit pause through controller.apply during an empty-queue start: the late candidate never plays", async () => {
  const rig = ownerRig({ autoReady: false });
  rig.controller.togglePlay();
  await flush();
  assert.equal(rig.refill.getStatus().autoplay, true);
  const seq = rig.controller.getUserActionSeq();
  rig.controller.apply([{ type: "pause" }], { gesture: false });
  assert.equal(rig.controller.getUserActionSeq(), seq, "pause does not make chat answers stale");
  assert.equal(rig.refill.getStatus().autoplay, false);
  rig.server.publish("prep-1", { candidate: { status: "ready", value: { track: ref("R1"), display: null } }, source: { status: "ready", value: mediaWire(ref("R1")) } });
  await flush();
  const snapshot = rig.snapshot();
  assert.equal(snapshot.queue.length, 1, "candidate kept, silently queued");
  assert.equal(snapshot.program, null);
  assert.equal(snapshot.transport, "idle");
  assert.equal(loadOf(rig.driver).length, 0, "nothing loaded or played");
});

test("media-key pause during an empty-queue start withdraws autoplay; a later play starts again", async () => {
  const rig = ownerRig({ autoReady: false });
  const session = fakeMediaSession();
  registerMediaSessionActions(session, rig.controller);
  session.invoke("play");
  await flush();
  session.invoke("play"); // repeated play: no second start
  await flush();
  assert.equal(rig.server.count("POST", "/api/v1/playback/prepare"), 1);
  session.invoke("pause");
  assert.equal(rig.refill.getStatus().autoplay, false);
  rig.server.publish("prep-1", { candidate: { status: "ready", value: { track: ref("R1"), display: null } }, source: { status: "ready", value: mediaWire(ref("R1")) } });
  await flush();
  assert.equal(loadOf(rig.driver).length, 0, "paused start stays silent");
  session.invoke("play");
  await flush();
  assert.equal(loadOf(rig.driver).length, 1, "play after that resumes the silently queued candidate");
});

test("main button: second press cancels the start, a third press starts again", async () => {
  const rig = ownerRig({ autoReady: false });
  rig.controller.togglePlay();
  await flush();
  rig.controller.togglePlay();
  assert.equal(rig.refill.getStatus().autoplay, false);
  rig.controller.togglePlay();
  await flush();
  assert.equal(rig.refill.getStatus().autoplay, true, "a new start that will play");
  const prepares = rig.server.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/playback/prepare");
  assert.equal(prepares.length, 2);
  assert.equal(rig.server.count("DELETE", /\/preparations\/prep-1$/), 1, "the withdrawn start's preparation is cancelled");
  const second = (prepares[1]?.body as { itemId: string }).itemId;
  rig.server.publish("prep-2", { candidate: { status: "ready", value: { track: ref("R1"), display: null } }, source: { status: "ready", value: mediaWire(ref("R1")) } });
  await flush();
  assert.equal(loadOf(rig.driver).length, 1);
  assert.equal(rig.snapshot().program?.item.itemId, second);
});

test("a retry timer of a paused start does not start playback or retry again", async () => {
  const rig = ownerRig();
  rig.server.failNextPrepare = { status: 503, code: "upstream_busy", class: "retryable" };
  rig.controller.togglePlay();
  await flush();
  assert.equal(rig.refill.getStatus().phase, "retry-wait");
  rig.controller.pause();
  assert.equal(rig.refill.getStatus().phase, "idle");
  rig.timers.advance(10_000);
  await flush();
  assert.equal(rig.server.count("POST", "/api/v1/playback/prepare"), 1, "no retry after the pause");
  assert.equal(loadOf(rig.driver).length, 0);
});

test("exhausted queue: Next starts the radio, a media-key pause keeps the late candidate silent", async () => {
  const rig = ownerRig();
  rig.controller.playTrack({ track: ref("A"), display: null, origin: "user" });
  const load = await startPlaying(rig);
  rig.server.autoReady = false;
  rig.refill.start();
  await flush();
  rig.driver.deckEvent(load.deck, { kind: "ended" } as never, load.loadId);
  await flush();
  assert.equal(rig.snapshot().transport, "exhausted");
  rig.controller.next();
  await flush();
  assert.equal(rig.refill.getStatus().userInitiated, true);
  rig.controller.pause();
  await flush();
  assert.notEqual(rig.snapshot().transport, "exhausted", "the pause ended the exhausted wait");
  const userPrep = [...rig.server.preparations.values()].at(-1);
  assert.ok(userPrep);
  rig.server.publish(userPrep.item.preparationId, { candidate: { status: "ready", value: { track: ref("R1"), display: null } }, source: { status: "ready", value: mediaWire(ref("R1")) } });
  await flush();
  assert.equal(loadOf(rig.driver).length, 1, "only A was ever loaded");
});

test("refill bookkeeping stays bounded over a long radio session", async () => {
  const rig = ownerRig();
  rig.server.radioPick = null; // every background context ends in no_candidate
  rig.refill.start();
  for (let index = 0; index < 30; index += 1) {
    rig.controller.playTrack({ track: ref(`T${index}`), display: null, origin: "user" });
    await startPlaying(rig);
  }
  assert.ok(rig.refill.trackedContexts <= 2, `tracked ${rig.refill.trackedContexts} contexts`);
});
