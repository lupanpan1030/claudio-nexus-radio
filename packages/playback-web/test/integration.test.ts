import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserDriver, createPlaybackRuntime, type LogEntry } from "../src/index.js";
import { FakeAudioContext, FakeMediaElement } from "./fake-dom.js";
import { ManualTimers, Ports, cueAsset, entry, flush, media } from "./helpers.js";

/**
 * The real core and the real BrowserDriver over the fake DOM: media events
 * are dispatched in the order the element's task queue would deliver them.
 */
async function setup() {
  const timers = new ManualTimers();
  const ctx = new FakeAudioContext("running");
  const elements: FakeMediaElement[] = [];
  const log: LogEntry[] = [];
  const ports = new Ports();
  ports.prepare.auto = (request) => media(request.track);
  ports.cue.auto = () => cueAsset();
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
    timeFactIntervalMs: 0
  });
  const runtime = createPlaybackRuntime({
    driver,
    ports: ports.bound,
    instanceId: "it",
    clock: () => timers.now,
    timers,
    log: (e) => log.push(e),
    coreConfig: { preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 8_000 },
    initialSettings: { djEnabled: true }
  });
  const effects = (type: string) => log.filter((e) => e.event === "effect" && (e.data as { type: string }).type === type).map((e) => e.data as Record<string, unknown>);
  return { runtime, driver, ctx, elements, timers, ports, log, effects };
}

test("hold → promote on the same load: play #1's late playing does not record B as started when play #2 is refused", async () => {
  const { runtime, elements, effects } = await setup();
  runtime.dispatch({ type: "enqueue", position: "end", entries: [entry("a"), entry("b")] });
  runtime.dispatch({ type: "resume" });
  await flush();
  const a = elements[0]!;
  a.ready(200);
  a.fire("playing");
  await flush();
  const bySrc = (src: string) => {
    const found = elements.find((el) => el.src === src);
    assert.ok(found, `element for ${src}`);
    return found;
  };
  const b = bySrc("/m/fixture/b");
  b.ready(200);
  bySrc("/v/voice/1").ready(3); // narration ready for the crossfade
  await flush();
  assert.equal(runtime.getSnapshot().transport, "playing");

  b.playMode = "pending"; // B's play() promises stay open until the test answers them
  a.advanceTo(194);
  a.fire("timeupdate"); // inside the 8 s lead: B preroll play #1
  assert.equal(effects("deck.play").filter((e) => e.deck === "B").length, 1, "preroll play #1");
  runtime.dispatch({ type: "seek", positionMs: 199_900 }); // cancels the preroll: B pause + seek(0)
  a.completeSeek();
  a.advanceTo(200);
  a.paused = true;
  a.ended = true;
  a.fire("pause");
  a.fire("ended");
  await flush();
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.program?.item.track.mediaId, "b", "B promoted at A's end");
  assert.equal(snapshot.program?.started, false);
  assert.equal(effects("deck.play").filter((e) => e.deck === "B").length, 2, "promotion issued play #2 on the same load");

  // B's element task queue: play #1's playing, the own pause's answer, the seek's seeked; then play #2 is refused.
  b.fire("playing");
  b.fire("pause");
  b.completeSeek();
  for (const pending of b.plays.splice(0)) pending.reject(new DOMException("denied", "NotAllowedError"));
  await flush();
  const after = runtime.getSnapshot();
  assert.equal(after.transport, "blocked");
  assert.equal(after.program?.started, false, "B never became program output");
  const receipts = effects("receipt.report").map((e) => (e.receipt as { itemId: string }).itemId);
  assert.deepEqual(receipts, [snapshot.history[0]?.item.itemId], "only A's receipt; none for B");
  assert.equal(after.program?.item.track.mediaId, "b", "B stays the program, waiting for a gesture");
});

test("external pause → seek → play before A started: the old playing is no start; a refused play #2 leaves A unstarted; the retry records once", async () => {
  const { runtime, elements, effects } = await setup();
  runtime.dispatch({ type: "set-dj-enabled", enabled: false });
  runtime.dispatch({ type: "enqueue", position: "end", entries: [entry("a")] });
  runtime.dispatch({ type: "resume" });
  await flush();
  const a = elements[0]!;
  a.playMode = "pending";
  a.ready(200);
  await flush();
  assert.equal(effects("deck.play").length, 1, "play #1 issued");
  a.pause(); // another agent pauses before any event of play #1 was dispatched
  runtime.dispatch({ type: "seek", positionMs: 0 });
  assert.equal(effects("deck.play").length, 2, "the seek re-asks play");
  a.fire("play");
  a.fire("playing"); // play #1's, queued before the external pause
  await flush();
  let snap = runtime.getSnapshot();
  assert.equal(snap.program?.started, false, "the stale playing is no start");
  assert.equal(effects("receipt.report").length, 0);
  assert.ok(snap.queue.some((e) => e.item.track.mediaId === "a") || snap.program?.item.track.mediaId === "a");
  a.fire("pause"); // superseded by the seek's play
  a.completeSeek();
  await flush();
  snap = runtime.getSnapshot();
  assert.equal(snap.transport, "loading", "not paused: the pause predates the listener's seek");
  for (const pending of a.plays.splice(0)) pending.reject(new DOMException("denied", "NotAllowedError"));
  await flush();
  snap = runtime.getSnapshot();
  assert.equal(snap.transport, "blocked");
  assert.equal(snap.program?.started, false);
  assert.equal(effects("receipt.report").length, 0);

  a.playMode = "resolve";
  runtime.dispatch({ type: "resume" });
  await flush();
  a.fire("play");
  a.fire("playing");
  await flush();
  snap = runtime.getSnapshot();
  assert.equal(snap.transport, "playing");
  assert.equal(snap.program?.started, true);
  assert.equal(effects("receipt.report").length, 1, "exactly one receipt, after the retry played");
});

test("seek back at the natural end, then an output suspend/resume: the snapshot returns to playing (no stuck waiting)", async () => {
  const { runtime, elements, ctx, effects } = await setup();
  runtime.dispatch({ type: "set-dj-enabled", enabled: false });
  runtime.dispatch({ type: "enqueue", position: "end", entries: [entry("a"), entry("b")] });
  runtime.dispatch({ type: "resume" });
  await flush();
  const a = elements[0]!;
  a.ready(12);
  await flush();
  a.fire("play");
  a.fire("playing");
  await flush();
  assert.equal(runtime.getSnapshot().transport, "playing");
  const programDeck = runtime.getSnapshot().program!.deck!;
  const epoch = runtime.getSnapshot().decks[programDeck].seekEpoch;
  a.advanceTo(12);
  a.paused = true;
  a.ended = true;
  runtime.dispatch({ type: "seek", positionMs: 150 }); // inside the end's task window
  assert.equal(runtime.getSnapshot().decks[programDeck].seekEpoch, epoch + 1, "the seek is a discontinuity for clock followers");
  a.fire("pause");
  a.fire("ended");
  await flush();
  let snap = runtime.getSnapshot();
  assert.equal(snap.program?.item.track.mediaId, "a", "the obsolete end did not advance");
  assert.notEqual(snap.transport, "paused");
  a.fire("play");
  a.completeSeek();
  a.fire("playing");
  await flush();
  assert.equal(runtime.getSnapshot().transport, "playing");
  a.advanceTo(0.5);
  void ctx.suspend();
  await flush();
  assert.equal(runtime.getSnapshot().transport, "waiting");
  ctx.setState("running");
  await flush();
  snap = runtime.getSnapshot();
  assert.equal(snap.transport, "playing", "the output resume reports playing again");
  assert.equal(snap.program?.item.track.mediaId, "a");
  assert.equal(effects("receipt.report").length, 1);
});

test("a current play aborted by someone else ends bounded in both orders: the transport pauses, resume plays and records once", async () => {
  for (const order of ["rejection-first", "pause-event-first"] as const) {
    const { runtime, elements, effects } = await setup();
    runtime.dispatch({ type: "set-dj-enabled", enabled: false });
    runtime.dispatch({ type: "enqueue", position: "end", entries: [entry("a")] });
    runtime.dispatch({ type: "resume" });
    await flush();
    const a = elements[0]!;
    a.playMode = "pending";
    a.ready(200);
    await flush();
    a.pause(); // rejects play #1 with AbortError; its `pause` event is queued
    if (order === "pause-event-first") a.fire("pause");
    await flush();
    if (order === "rejection-first") a.fire("pause");
    await flush();
    let snap = runtime.getSnapshot();
    assert.equal(snap.transport, "paused", `${order}: bounded, not an endless loading`);
    assert.equal(snap.program?.started, false);
    a.playMode = "resolve";
    runtime.dispatch({ type: "resume" });
    await flush();
    a.fire("play");
    a.fire("playing");
    await flush();
    snap = runtime.getSnapshot();
    assert.equal(snap.transport, "playing", order);
    assert.equal(effects("receipt.report").length, 1, order);
  }
});
