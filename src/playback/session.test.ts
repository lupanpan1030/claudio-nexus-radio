import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogEntry } from "@claudio/playback-web";
import { CatalogIndex } from "./catalog";
import { safeStorage } from "./persistence";
import { createPlaybackSession } from "./session";
import { TEST_PATHS, flush } from "./test-support";

function harness(loadCatalog: (signal: AbortSignal) => Promise<CatalogIndex>, catalogTimeoutMs?: number) {
  const requests: string[] = [];
  const drivers: number[] = [];
  const logs: LogEntry[] = [];
  const map = new Map<string, string>();
  const session = createPlaybackSession({
    fetchFn: async (input, init) => {
      requests.push(`${init.method ?? "GET"} ${input}`);
      return new Response("{}", { status: 500 });
    },
    paths: TEST_PATHS,
    origin: "http://claudio.test",
    storage: safeStorage(() => ({ getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) })),
    settings: () => ({ theme: "dark", stageEnabled: false, musicVolume: 0.5, djEnabled: true }),
    loadCatalog,
    catalogTimeoutMs,
    createDriver: async () => {
      drivers.push(1);
      throw new Error("no browser driver in this test");
    },
    log: (entry) => void logs.push(entry)
  });
  return { session, requests, logs, map, drivers };
}

test("a session disposed while the library load is pending builds nothing further and sends nothing", async () => {
  let release: (catalog: CatalogIndex) => void = () => {};
  let seenSignal: AbortSignal | null = null;
  const h = harness((signal) => {
    seenSignal = signal;
    return new Promise((resolve) => (release = resolve));
  });
  await flush();
  assert.equal(h.session.startup.get().status, "starting", "executor start is waiting for the library");
  await h.session.dispose();
  assert.equal((seenSignal as AbortSignal | null)?.aborted, true, "the library request is aborted");
  release(CatalogIndex.EMPTY);
  await flush();
  assert.equal(h.session.owner.get(), null, "no refill/ids published");
  assert.notEqual(h.session.startup.get().status, "ready");
  assert.ok(h.logs.some((entry) => entry.event === "executor.start-abandoned"), JSON.stringify(h.logs.map((entry) => entry.event)));
  assert.ok(!h.logs.some((entry) => entry.event === "executor.start-failed"), "not reported as a failure");
  assert.deepEqual(h.requests, [], "no prepare, now or any other request");
  assert.equal(h.drivers.length, 0, "no driver (AudioContext) created");
  assert.equal(h.map.get("claudio.executor.generation.v1"), undefined, "no executor generation taken");
});

test("a library that never answers does not hold the executor start past its deadline", async () => {
  const h = harness(() => new Promise(() => {}), 30);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await flush();
  const imported = h.logs.find((entry) => entry.event === "legacy.import");
  assert.ok(imported, "the import step finished (as failed) instead of waiting forever");
  assert.equal((imported.data as { status: string }).status, "failed");
  assert.equal(h.drivers.length, 1, "the start went on to the driver");
  await h.session.dispose();
});
