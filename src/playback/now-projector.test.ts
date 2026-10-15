import assert from "node:assert/strict";
import { test } from "node:test";
import { asId, isNewerProjection, nowConflictFor, type ExecutorInstanceId, type NowProjectionV1, type PlaybackSnapshot } from "@claudio/contracts";
import { NowProjector } from "./now-projector";
import { safeStorage } from "./persistence";
import { GENERATION_KEY, nextExecutorGeneration, raiseExecutorGeneration } from "./session";
import { ManualTimers, flush, json } from "./test-support";

/** PUT /api/v1/now arbiter using the shared ordering/conflict rules the server applies. */
function nowServer(initial: NowProjectionV1 | null = null) {
  let current = initial;
  const puts: NowProjectionV1[] = [];
  const signals: AbortSignal[] = [];
  let hold: Promise<void> | null = null;
  const fetchFn = async (_path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as NowProjectionV1;
    puts.push(body);
    if (init.signal) signals.push(init.signal);
    if (hold) {
      await Promise.race([hold, new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))]);
    }
    if (current && !isNewerProjection(current, body)) return json(409, nowConflictFor(current, body));
    current = body;
    return json(200, body);
  };
  return {
    fetchFn,
    puts,
    signals,
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
    holdRequests(gate: Promise<void> | null) {
      hold = gate;
    }
  };
}

function memory() {
  const map = new Map<string, string>();
  return { map, storage: safeStorage(() => ({ getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) })) };
}

function source() {
  let snapshot = { transport: "idle", program: null, queue: [], voice: null } as unknown as PlaybackSnapshot;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
    clock: { read: () => ({ at: 0, source: "media-element", decks: { A: null, B: null }, voice: null }) } as never,
    change(transport: string) {
      snapshot = { ...snapshot, transport } as PlaybackSnapshot;
      for (const listener of listeners) listener();
    }
  };
}

const OTHER = asId<ExecutorInstanceId>("web-older-owner");
const SELF = asId<ExecutorInstanceId>("web-self");
const olderOwner = (generation: number): NowProjectionV1 => ({ protocolVersion: 1, executorInstanceId: OTHER, generation, seq: 40, observedAt: "2026-10-16T00:00:00.000Z", transport: "paused", item: null, positionMs: null, nextItemId: null, speaking: false });

function rig(options: { serverGeneration?: number; owner?: () => boolean } = {}) {
  const server = nowServer(options.serverGeneration === undefined ? null : olderOwner(options.serverGeneration));
  const { map, storage } = memory();
  const timers = new ManualTimers();
  const src = source();
  const generation = nextExecutorGeneration(storage);
  const projector = new NowProjector({
    source: src,
    fetchFn: server.fetchFn,
    path: "/api/v1/now",
    executorInstanceId: SELF,
    generation,
    isCurrentOwner: options.owner ?? (() => true),
    raiseGeneration: (atLeast) => raiseExecutorGeneration(storage, atLeast),
    clock: () => Date.parse("2026-10-16T00:00:01.000Z"),
    timers
  });
  return { server, map, storage, timers, src, projector, generation };
}

test("storage cleared while the server kept an older owner's higher generation: one raise, persisted, accepted", async () => {
  const r = rig({ serverGeneration: 7 });
  assert.equal(r.generation, 1, "missing stored generation starts at 1");
  r.projector.start();
  await flush();
  assert.deepEqual(r.server.puts.map((put) => put.generation), [1, 8]);
  assert.equal(r.server.current?.executorInstanceId, SELF);
  assert.equal(r.map.get(GENERATION_KEY), "8", "the raised generation is stored for the next owner");
  r.src.change("playing");
  await flush();
  assert.equal(r.server.puts.at(-1)?.generation, 8);
  assert.equal(r.server.current?.transport, "playing");
});

test("no endless contention: a second conflict after the one raise stops reporting for good", async () => {
  const r = rig({ serverGeneration: 7 });
  const original = r.server.fetchFn;
  // Another device keeps outbidding: the server's generation is always ours + 1.
  let bump = 0;
  const contested = async (path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as NowProjectionV1;
    r.server.current = olderOwner(body.generation + 1 + bump++);
    return original(path, init);
  };
  (r.projector as unknown as { options: { fetchFn: typeof contested } }).options.fetchFn = contested;
  r.projector.start();
  await flush();
  assert.equal(r.server.puts.length, 2, "first put + exactly one retry");
  assert.equal(r.projector.stopped, true);
  r.src.change("playing");
  await flush();
  assert.equal(r.server.puts.length, 2);
});

test("a page that lost the lock never retries to take the projection back", async () => {
  let owner = true;
  const r = rig({ serverGeneration: 7, owner: () => owner });
  r.server.holdRequests(new Promise((resolve) => setTimeout(resolve, 5)));
  r.projector.start();
  owner = false; // the lock moved on while the first PUT was in flight
  r.server.holdRequests(null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await flush();
  assert.equal(r.server.puts.length, 1);
  assert.equal(r.map.get(GENERATION_KEY), "1", "storage not raised");
  assert.equal(r.projector.stopped, true);
});

test("an unreadable 409 stops reporting; a stale duplicate of our own seq moves past it once", async () => {
  const r = rig();
  (r.projector as unknown as { options: { fetchFn: unknown } }).options.fetchFn = async () => json(409, { error: "conflict" });
  r.projector.start();
  await flush();
  assert.equal(r.projector.stopped, true);

  const s = rig();
  const self = { ...olderOwner(1), executorInstanceId: SELF, seq: 25 };
  s.server.current = self;
  s.projector.start();
  await flush();
  assert.deepEqual(s.server.puts.map((put) => put.seq), [1, 26]);
  assert.equal(s.server.current?.seq, 26);
});

test("dispose aborts the PUT in flight and leaves no timer behind", async () => {
  const r = rig();
  let release: () => void = () => {};
  r.server.holdRequests(new Promise<void>((resolve) => (release = resolve)));
  r.projector.start();
  await flush(2);
  assert.equal(r.server.signals.length, 1);
  r.projector.dispose();
  assert.equal(r.server.signals[0]?.aborted, true);
  release();
  await flush();
  assert.equal(r.timers.size, 0);
  r.src.change("playing");
  await flush();
  assert.equal(r.server.puts.length, 1);
});

test("stored generation parsing: only decimal safe integers; raise is monotonic", () => {
  const { map, storage } = memory();
  assert.equal(nextExecutorGeneration(storage), 1);
  assert.equal(nextExecutorGeneration(storage), 2);
  for (const bad of ["", " ", "1e3", "-4", "0x10", "abc", "99999999999999999999"]) {
    map.set(GENERATION_KEY, bad);
    assert.equal(nextExecutorGeneration(storage, () => 1_760_000_000_000), 1_760_000_000_000, `unreadable ${JSON.stringify(bad)}`);
  }
  map.set(GENERATION_KEY, String(Number.MAX_SAFE_INTEGER));
  assert.equal(nextExecutorGeneration(storage), Number.MAX_SAFE_INTEGER, "never past the safe range");
  map.set(GENERATION_KEY, "10");
  assert.equal(raiseExecutorGeneration(storage, 3), 10);
  assert.equal(raiseExecutorGeneration(storage, 12), 12);
  assert.equal(map.get(GENERATION_KEY), "12");
  assert.equal(raiseExecutorGeneration(storage, Number.MAX_SAFE_INTEGER + 2), null);
});
