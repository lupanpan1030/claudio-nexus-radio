// The client's HTTP deadlines against the shared playback budget, driven on
// mocked timers (node:test) so a slow-but-legal server and a hung one can be
// played out at real lengths without waiting for them.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  PLAYBACK_BUDGETS,
  PLAYBACK_HTTP_TIMEOUTS,
  PROTOCOL_VERSION,
  asId,
  type LyricsResponseV1,
  type OperationId,
  type PreparedItemV1,
  type QueueItemId,
  type RecordingId,
  type SourceRevision
} from "@claudio/contracts";
import { PortError } from "@claudio/playback-web";
import { requestJson } from "./http";
import { HttpLyricsPort } from "./ports";
import { DEFAULT_PREPARATION_TIMINGS, HttpPreparePort, PreparationClient } from "./preparation";
import { checkProtocol } from "./protocol";
import { TEST_PATHS, json, mediaWire, ref } from "./test-support";

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

/** Mocked time now (ms since enable). */
let now = 0;
beforeEach(() => {
  now = 0;
});

/** A server answer that becomes available after `ms` of mocked time, or rejects when the request is aborted. */
function after<T>(ms: number, signal: AbortSignal | null | undefined, value: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    // Infinity: a server that never answers (only the client's abort ends it).
    const timer = ms === Infinity ? undefined : setTimeout(() => resolve(value()), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

/** Advances mocked time in steps, letting promise chains run in between, until `done()` or `limitMs`. */
async function run(limitMs: number, done: () => boolean, stepMs = 50): Promise<void> {
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 5; index += 1) await turn();
  while (!done() && now < limitMs) {
    mock.timers.tick(stepMs);
    now += stepMs;
    for (let index = 0; index < 5; index += 1) await turn();
  }
}

function settled<T>(promise: Promise<T>) {
  const state: { done: boolean; value?: T; error?: unknown; at?: number } = { done: false };
  promise.then(
    (value) => Object.assign(state, { done: true, value, at: now }),
    (error: unknown) => Object.assign(state, { done: true, error, at: now })
  );
  return state;
}

const op = asId<OperationId>("op-1");
const itemId = asId<QueueItemId>("item-1");

test("the client's defaults are the shared budget: every exchange waits the server's own deadline plus a margin", () => {
  assert.equal(DEFAULT_PREPARATION_TIMINGS.waitMs, PLAYBACK_BUDGETS.longPollMs);
  assert.equal(DEFAULT_PREPARATION_TIMINGS.requestTimeoutMs, PLAYBACK_HTTP_TIMEOUTS.longPollRequestMs);
  assert.equal(DEFAULT_PREPARATION_TIMINGS.resolveTimeoutMs, PLAYBACK_HTTP_TIMEOUTS.resolveRequestMs);
  assert.ok(DEFAULT_PREPARATION_TIMINGS.requestTimeoutMs > PLAYBACK_BUDGETS.longPollMs);
  assert.ok(DEFAULT_PREPARATION_TIMINGS.resolveTimeoutMs > PLAYBACK_BUDGETS.sourceMs);
  assert.ok(PLAYBACK_HTTP_TIMEOUTS.lyricsRequestMs > PLAYBACK_BUDGETS.lyricsMs);
});

/**
 * POST prepare held for the server's long-poll window, answered "active";
 * GETs long-poll until the source settles at `sourceReadyMs` (or never).
 */
function slowPreparationServer(sourceReadyMs: number | null) {
  const requests: string[] = [];
  let version = 0;
  const item = (ready: boolean): PreparedItemV1 => ({
    protocolVersion: PROTOCOL_VERSION,
    preparationId: asId("prep-1"),
    itemId,
    version: ++version,
    status: ready ? "ready" : "active",
    expiresAt: "2030-01-01T00:00:00.000Z",
    stages: {
      candidate: { status: "ready", value: { track: ref("S"), display: null } },
      source: ready ? { status: "ready", value: mediaWire(ref("S")) } : { status: "in-progress" },
      lyrics: { status: "skipped", reason: "not requested" },
      script: { status: "skipped", reason: "none" },
      voice: { status: "skipped", reason: "none" }
    }
  });
  const readyAt = sourceReadyMs ?? Infinity;
  const fetchFn = async (input: string, init: RequestInit) => {
    const url = new URL(input, "http://claudio.test");
    requests.push(`${init.method} ${url.pathname}`);
    const hold = Math.min(PLAYBACK_BUDGETS.longPollMs, Math.max(0, readyAt - now));
    return after(hold, init.signal, () => json(200, item(now >= readyAt)));
  };
  return { fetchFn, requests };
}

test("a slow but legal source (ready at 19 s): POST answers active at 8 s, polling continues, nothing is cancelled", async () => {
  const server = slowPreparationServer(19_000);
  const port = new HttpPreparePort(new PreparationClient(server.fetchFn, TEST_PATHS));
  const result = settled(port.resolve({ opId: op, itemId, track: ref("S"), purpose: "program", previousRevision: null }, new AbortController().signal));
  await run(60_000, () => result.done);
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.value?.track.mediaId, "S");
  assert.ok(result.at! >= 19_000 && result.at! < 20_000, `ready at ${result.at}`);
  assert.equal(server.requests[0], "POST /api/v1/playback/prepare");
  assert.ok(server.requests.slice(1).every((request) => request.startsWith("GET /api/v1/playback/preparations/")), server.requests.join(", "));
  assert.equal(server.requests.filter((request) => request.startsWith("DELETE")).length, 0);
});

test("a server that never answers: every exchange still ends at its own deadline", async () => {
  const hung = async (_input: string, init: RequestInit) => after(Infinity, init.signal, () => json(200, {}));
  const post = settled(new PreparationClient(hung, TEST_PATHS).start({ itemId, purpose: "program", target: { kind: "track", track: ref("S") }, narration: null, wantLyrics: false }, new AbortController().signal));
  await run(60_000, () => post.done);
  assert.ok(post.error instanceof PortError && post.error.info.code === "timeout");
  assert.equal(post.at, PLAYBACK_HTTP_TIMEOUTS.longPollRequestMs);

  now = 0;
  const resolve = settled(new PreparationClient(hung, TEST_PATHS).resolve({ itemId, track: ref("S"), preparationId: null, reason: "retry", previousRevision: asId<SourceRevision>("r") }, new AbortController().signal));
  await run(60_000, () => resolve.done);
  assert.ok(resolve.error instanceof PortError && resolve.error.info.code === "timeout");
  assert.equal(resolve.at, PLAYBACK_HTTP_TIMEOUTS.resolveRequestMs, "resolve waits the source budget plus margin");

  now = 0;
  const lyrics = settled(new HttpLyricsPort(hung, TEST_PATHS).lookup({ opId: op, itemId, track: ref("S"), recordingId: asId<RecordingId>("rec-S"), sourceRevision: asId<SourceRevision>("rev-S") } as never, new AbortController().signal));
  await run(60_000, () => lyrics.done);
  assert.ok(lyrics.error instanceof PortError && lyrics.error.info.code === "timeout");
  assert.equal(lyrics.at, PLAYBACK_HTTP_TIMEOUTS.lyricsRequestMs);
});

test("legal answers at the server's own deadlines are waited for: resolve at 20 s, lyrics at 15 s", async () => {
  const resolveAt = async (_input: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { itemId: string; track: ReturnType<typeof ref> };
    return after(PLAYBACK_BUDGETS.sourceMs, init.signal, () => json(200, { protocolVersion: 1, itemId: body.itemId, media: mediaWire(body.track) }));
  };
  const resolved = settled(new PreparationClient(resolveAt, TEST_PATHS).resolve({ itemId, track: ref("S"), preparationId: null, reason: "retry", previousRevision: asId<SourceRevision>("r") }, new AbortController().signal));
  await run(60_000, () => resolved.done);
  assert.equal(resolved.error, undefined, String(resolved.error));
  assert.equal(resolved.at, PLAYBACK_BUDGETS.sourceMs);

  now = 0;
  const lyricsAt = async (_input: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { itemId: string; track: unknown; recordingId: string; sourceRevision: string };
    const response: LyricsResponseV1 = { protocolVersion: 1, itemId: body.itemId, track: body.track, recordingId: body.recordingId, sourceRevision: body.sourceRevision, result: { status: "missing", reason: "not-found" } } as unknown as LyricsResponseV1;
    return after(PLAYBACK_BUDGETS.lyricsMs, init.signal, () => json(200, response));
  };
  const lyrics = settled(new HttpLyricsPort(lyricsAt, TEST_PATHS).lookup({ opId: op, itemId, track: ref("S"), recordingId: asId<RecordingId>("rec-S"), sourceRevision: asId<SourceRevision>("rev-S") } as never, new AbortController().signal));
  await run(60_000, () => lyrics.done);
  assert.equal(lyrics.error, undefined, String(lyrics.error));
  assert.equal(lyrics.at, PLAYBACK_BUDGETS.lyricsMs, "the old 12 s client deadline would have cut this legal answer");
});

test("a signal aborted before the call sends nothing (requestJson and the protocol handshake)", async () => {
  let fetches = 0;
  const fetchFn = async () => {
    fetches += 1;
    return json(200, { protocolVersion: 1, playbackProtocol: "v1" });
  };
  const aborted = AbortSignal.abort();
  await assert.rejects(requestJson(fetchFn, { method: "GET", path: "/x", signal: aborted, timeoutMs: 1000 }, (value) => value), (error: unknown) => error instanceof PortError && error.info.code === "aborted");
  await assert.rejects(checkProtocol(fetchFn, aborted));
  assert.equal(fetches, 0);

  // Aborted while the body was still arriving: no verdict either.
  const controller = new AbortController();
  const late = async () => ({ status: 200, json: async () => (controller.abort(), {}) }) as unknown as Response;
  await assert.rejects(checkProtocol(late, controller.signal));
});
