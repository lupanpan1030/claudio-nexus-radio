import assert from "node:assert/strict";
import test from "node:test";
import { clockFromSnapshot, createPlaybackHost, createPlaybackRuntime, createStorageQueueStore, projectClock, type HostView, type LockManagerLike, type PlaybackHost } from "../src/index.js";
import { FakeDriver } from "../src/testing/index.js";
import { Ports, entry, media, memoryStorage } from "./helpers.js";

// Node ships the same Web Locks and BroadcastChannel APIs; within one process
// two hosts behave like two same-origin tabs.
const locks = (globalThis as unknown as { navigator: { locks: LockManagerLike & { query(): Promise<{ held: { name: string }[]; pending: { name: string }[] }> } } }).navigator.locks;

const openHosts = new Set<PlaybackHost>();
test.afterEach(async () => {
  // A failed assertion must not leave a BroadcastChannel/lock keeping the process alive.
  await Promise.all([...openHosts].map((host) => host.dispose()));
  openHosts.clear();
});

let counter = 0;
const uniqueName = () => `claudio-test-${process.pid}-${++counter}`;

async function until(predicate: () => boolean, label: string, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeTab(name: string, storage: ReturnType<typeof memoryStorage>, label: string) {
  const created: { label: string; driver: FakeDriver; ports: Ports }[] = [];
  const host = createPlaybackHost({
    name,
    createRuntime: () => {
      const driver = new FakeDriver();
      const ports = new Ports();
      ports.prepare.auto = (request) => media(request.track);
      created.push({ label, driver, ports });
      return createPlaybackRuntime({ driver, ports: ports.bound, instanceId: `${label}-${created.length}`, queueStore: createStorageQueueStore(storage, `${name}.queue`), initialSettings: { djEnabled: false } });
    }
  });
  openHosts.add(host);
  return { host, created, view: (): HostView => host.getView() };
}

test("two tabs: one executor creates a runtime; the other observes snapshots read-only without a driver", async () => {
  const name = uniqueName();
  const storage = memoryStorage();
  const one = makeTab(name, storage, "one");
  await until(() => one.view().canControl, "first tab executor");
  const two = makeTab(name, storage, "two");
  await until(() => two.view().role === "observer", "second tab observer");
  assert.equal(two.created.length, 0, "observer never creates a driver/runtime");
  assert.deepEqual(two.host.dispatch({ type: "resume" }), { accepted: false, reason: "observer" });

  one.host.dispatch({ type: "enqueue", position: "end", entries: [entry("a"), entry("b")] });
  one.host.dispatch({ type: "resume" });
  await until(() => one.created[0]!.driver.effects("deck.load").length === 1, "deck load");
  one.created[0]!.driver.deckEvent("A", { kind: "playing", positionMs: 0 });
  await until(() => two.view().snapshot?.transport === "playing", "observer sees playing");
  assert.equal(two.view().executorInstanceId, "one-1");
  const observed = two.view().snapshot!;
  assert.ok(Object.isFrozen(observed));
  assert.equal(two.host.clock.read().source, "snapshot");
  assert.equal(two.created.length, 0);
  assert.equal(one.created[0]!.ports.prepare.calls.length + two.created.length, 0, "auto-answered; second tab made no calls");

  await one.host.dispose();
  await two.host.dispose();
});

test("owner leaves: the waiting tab takes over with a fresh runtime, queue restored stopped, no old cue or receipt replay", async () => {
  const name = uniqueName();
  const storage = memoryStorage();
  const one = makeTab(name, storage, "one");
  await until(() => one.view().canControl, "first executor");
  const two = makeTab(name, storage, "two");
  await until(() => two.view().role === "observer", "observer");
  one.host.dispatch({ type: "enqueue", position: "end", entries: [entry("a"), entry("b")] });
  one.host.dispatch({ type: "resume" });
  await until(() => one.created[0]!.driver.effects("deck.load").length === 1, "load");
  one.created[0]!.driver.deckEvent("A", { kind: "playing", positionMs: 0 });

  await one.host.dispose();
  assert.equal(one.created[0]!.driver.disposed, true, "old executor released its media before the lock");
  await until(() => two.view().canControl, "second tab takes over");
  assert.equal(two.created.length, 1);
  const snapshot = two.view().snapshot!;
  assert.equal(snapshot.transport, "idle", "takes over stopped, not playing");
  assert.deepEqual(snapshot.queue.map((e) => e.item.track.mediaId), ["a", "b"]);
  assert.equal(snapshot.voice, null);
  assert.equal(two.created[0]!.driver.executed.filter((e) => e.type !== "output.volume").length, 0, "nothing loads until the user resumes");
  await two.host.dispose();
  const state = await locks.query();
  assert.equal(state.held.some((l) => l.name === name) || state.pending.some((l) => l.name === name), false, "no lock held or pending after dispose");
});

test("StrictMode-style mount → unmount → mount in one page ends with exactly one live runtime", async () => {
  const name = uniqueName();
  const storage = memoryStorage();
  const first = makeTab(name, storage, "mount1");
  const disposing = first.host.dispose(); // immediate unmount, as StrictMode does
  const second = makeTab(name, storage, "mount2");
  await disposing;
  await until(() => second.view().canControl, "remount becomes executor");
  // Whether the first mount got as far as a runtime depends on lock timing; either way it is gone.
  assert.ok(first.created.every((c) => c.driver.disposed), "the unmounted host left no live driver");
  assert.equal(first.host.getView().canControl, false);
  assert.equal(second.created.length, 1);
  const third = makeTab(name, storage, "mount3");
  await until(() => third.view().role === "observer", "third observes");
  await second.host.dispose();
  await until(() => third.view().canControl, "third takes over");
  assert.equal(second.created[0]!.driver.disposed, true);
  await third.host.dispose();
});

test("without Web Locks the page refuses to execute by default and says so; run-unguarded is explicit and non-exclusive", async () => {
  const name = uniqueName();
  let made = 0;
  const refuse: PlaybackHost = createPlaybackHost({
    name,
    locks: null,
    channels: null,
    createRuntime: () => {
      made++;
      return createPlaybackRuntime({ driver: new FakeDriver(), ports: new Ports().bound, instanceId: "x" });
    }
  });
  assert.equal(refuse.getView().role, "unsupported");
  assert.equal(refuse.getView().canControl, false);
  assert.equal(made, 0);
  await refuse.dispose();

  const unguarded = createPlaybackHost({
    name,
    locks: null,
    channels: null,
    unsupportedPolicy: "run-unguarded",
    createRuntime: () => {
      made++;
      return createPlaybackRuntime({ driver: new FakeDriver(), ports: new Ports().bound, instanceId: "y" });
    }
  });
  await until(() => unguarded.getView().canControl, "unguarded runtime");
  assert.equal(unguarded.getView().exclusive, false);
  await unguarded.dispose();
  assert.equal(made, 1);
});

test("an observer rejects older snapshots of the same executor and anything from an ended executor", async () => {
  const name = uniqueName();
  const sent: ((data: unknown) => void)[] = [];
  const listeners = new Set<(event: { data: unknown }) => void>();
  const fakeChannel = {
    postMessage: () => {},
    addEventListener: (_: "message", l: (event: { data: unknown }) => void) => listeners.add(l),
    removeEventListener: (_: "message", l: (event: { data: unknown }) => void) => listeners.delete(l),
    close: () => listeners.clear()
  };
  const deliver = (data: unknown) => listeners.forEach((l) => l({ data }));
  sent.push(deliver);
  const holder = new AbortController();
  let releaseHolder!: () => void;
  const held = locks.request(name, { signal: holder.signal }, () => new Promise<void>((resolve) => (releaseHolder = resolve)));
  const host = createPlaybackHost({ name, channels: () => fakeChannel, createRuntime: () => createPlaybackRuntime({ driver: new FakeDriver(), ports: new Ports().bound, instanceId: "late" }) });
  openHosts.add(host);
  await until(() => host.getView().role === "observer", "observer");
  const snap = (version: number) => ({ version, transport: "playing" }) as unknown;
  const version = () => (host.getView().snapshot as unknown as { version: number } | null)?.version ?? null;
  const protocol = "claudio.playback-snapshot/2";
  deliver({ protocol, type: "snapshot", instanceId: "exec-1", epoch: 100, seq: 5, snapshot: snap(5) });
  deliver({ protocol, type: "snapshot", instanceId: "exec-1", epoch: 100, seq: 4, snapshot: snap(4) });
  assert.equal(version(), 5);
  deliver({ protocol, type: "snapshot", instanceId: "exec-1", seq: 6, snapshot: snap(6) });
  assert.equal(version(), 5, "a message without an executor epoch is malformed");
  deliver({ protocol, type: "ended", instanceId: "exec-1", epoch: 100, seq: 6 });
  assert.equal(host.getView().snapshot, null);
  deliver({ protocol, type: "snapshot", instanceId: "exec-1", epoch: 100, seq: 7, snapshot: snap(7) });
  assert.equal(host.getView().snapshot, null, "an ended executor cannot come back through a late message");

  // A successor restarts its core: a lower version from a newer epoch is shown.
  deliver({ protocol, type: "snapshot", instanceId: "exec-2", epoch: 200, seq: 1, snapshot: snap(1) });
  assert.deepEqual([host.getView().executorInstanceId, version()], ["exec-2", 1]);
  // Its predecessor crashed without "ended": its reordered late message must not take over again.
  deliver({ protocol, type: "snapshot", instanceId: "exec-0", epoch: 50, seq: 99, snapshot: snap(99) });
  assert.deepEqual([host.getView().executorInstanceId, version()], ["exec-2", 1]);
  // A newer executor (exec-2 died silently) replaces it; exec-2 cannot return afterwards.
  deliver({ protocol, type: "snapshot", instanceId: "exec-3", epoch: 300, seq: 1, snapshot: snap(2) });
  deliver({ protocol, type: "snapshot", instanceId: "exec-2", epoch: 200, seq: 2, snapshot: snap(50) });
  assert.deepEqual([host.getView().executorInstanceId, version()], ["exec-3", 2]);
  deliver({ protocol: "other", type: "snapshot" });
  await host.dispose();
  releaseHolder();
  await held;
});

test("a runtime that fails to start releases the lock at once: the page reports failed and the next tab takes over", async () => {
  const name = uniqueName();
  const storage = memoryStorage();
  let attempts = 0;
  const broken = createPlaybackHost({
    name,
    createRuntime: async () => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("AudioContext construction failed");
    }
  });
  openHosts.add(broken);
  await until(() => broken.getView().role === "failed", "first tab failed");
  const tab2 = makeTab(name, storage, "tab2");
  await until(() => tab2.view().canControl, "second tab takes over without the first tab closing");
  const failed = broken.getView();
  assert.equal(failed.canControl, false);
  assert.equal(failed.failure?.code, "executor_start_failed");
  assert.match(failed.failure?.message ?? "", /AudioContext construction failed/);
  assert.deepEqual(broken.dispatch({ type: "resume" }), { accepted: false, reason: "observer" });
  assert.equal(attempts, 1, "a failed page does not queue for the lock again (no fail loop)");
  const state = await locks.query();
  assert.equal(state.held.filter((l) => l.name === name).length, 1, "exactly one holder: the healthy tab");
  assert.equal(state.pending.filter((l) => l.name === name).length, 0, "nobody left waiting");
  await broken.dispose();
});

test("a runtime created after dispose is released, with Web Locks and in run-unguarded mode", async () => {
  for (const mode of ["locked", "unguarded"] as const) {
    let finish!: (runtime: ReturnType<typeof createPlaybackRuntime>) => void;
    const driver = new FakeDriver();
    const host = createPlaybackHost({
      name: uniqueName(),
      locks: mode === "locked" ? undefined : null,
      unsupportedPolicy: "run-unguarded",
      createRuntime: () => new Promise((resolve) => (finish = resolve))
    });
    openHosts.add(host);
    await until(() => typeof finish === "function", `${mode}: factory running`);
    const disposal = host.dispose(); // while the factory is still pending
    const runtime = createPlaybackRuntime({ driver, ports: new Ports().bound, instanceId: `late-${mode}` });
    finish(runtime);
    await disposal;
    assert.equal(runtime.disposed, true, `${mode}: late runtime disposed`);
    assert.equal(driver.disposed, true, `${mode}: its driver released`);
    assert.deepEqual(host.dispatch({ type: "resume" }), { accepted: false, reason: "disposed" });
  }
  const state = await locks.query();
  assert.equal(state.held.filter((l) => l.name.startsWith(`claudio-test-${process.pid}`)).length, 0);
});

test("observer clock: broadcast samples keep their observedAt; a bounded projection stops instead of re-stamping old data", () => {
  const snapshot = {
    decks: {
      A: { loadId: "L1", status: "playing", clock: { positionMs: 1_000, observedAt: 1_000, rate: 1 } },
      B: { loadId: null, status: "idle", clock: null }
    },
    voice: { cueId: "c1", voiceLoadId: "v1", status: "speaking", clock: { positionMs: 400, observedAt: 20_500, rate: 1 } }
  } as unknown as Parameters<typeof clockFromSnapshot>[0];
  const reading = clockFromSnapshot(snapshot, 21_000);
  assert.equal(reading.source, "snapshot");
  assert.deepEqual([reading.decks.A?.positionMs, reading.decks.A?.observedAt, reading.decks.A?.rate], [1_000, 1_000, 1]);
  assert.deepEqual(projectClock(reading.decks.A!, 21_000), { positionMs: 2_500, stale: true }, "20 s old: at most 1.5 s ahead, flagged stale");
  assert.deepEqual(projectClock(reading.voice!, 21_000), { positionMs: 900, stale: false }, "a fresh voice sample extrapolates normally");
  assert.deepEqual(projectClock({ ...reading.decks.A!, rate: 0 }, 21_000), { positionMs: 1_000, stale: false }, "a frozen clock is not stale");
});
