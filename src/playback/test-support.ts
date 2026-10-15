// Test-only helpers (never imported by the app): a fake v1 playback server
// speaking the shared wire contracts, and deterministic timers.
import { API_V1_PATHS, PROTOCOL_VERSION, asId, type CandidateV1, type MediaId, type PreparedItemV1, type ProviderId, type QueueItemId, type ResolvedMediaWire, type Stage, type TrackRef } from "@claudio/contracts";
import type { Timers } from "@claudio/playback-web";
import type { FetchLike } from "./http";
import { SHARED_PATHS, type ProtocolPaths } from "./protocol";

export const TEST_PATHS: ProtocolPaths = SHARED_PATHS;

export function ref(mediaId: string, providerId = "fixture"): TrackRef {
  return { providerId: asId<ProviderId>(providerId), mediaId: asId<MediaId>(mediaId) };
}

export function mediaWire(track: TrackRef, revision = `rev-${track.mediaId}`): ResolvedMediaWire {
  return {
    track,
    recording: { recordingId: asId(`rec-${track.mediaId}`), confidence: "provider-asserted" },
    sourceRevision: asId(revision),
    stream: { handle: asId(`/api/v1/playback/streams/${track.mediaId}-${revision}`), expiresAt: null },
    duration: { kind: "known", ms: 180_000, source: "provider-metadata" },
    capabilities: { seekable: true, rangeRequests: true }
  };
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface FakePreparation {
  item: PreparedItemV1;
  /** Resolvers of long-polls waiting for a newer version. */
  waiters: ((item: PreparedItemV1) => void)[];
}

/**
 * In-memory v1 preparation server. Tests decide when stages settle
 * (`publish`). Requests are recorded so tests can assert, e.g., that an
 * adopted preparation is never POSTed twice.
 */
export class FakePlaybackServer {
  readonly requests: RecordedRequest[] = [];
  readonly preparations = new Map<string, FakePreparation>();
  private counter = 0;
  /** What a radio-candidate preparation picks; null → no_candidate. */
  radioPick: TrackRef | null = ref("R1");
  /** When false, new preparations keep candidate/source pending until `publish`. */
  autoReady = true;
  failNextPrepare: { status: number; code: string; class: string } | null = null;

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input, "http://claudio.test");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path: url.pathname, body });
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (method === "POST" && url.pathname === API_V1_PATHS.prepare) return this.prepare(body);
    const match = /^\/api\/v1\/playback\/preparations\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const record = this.preparations.get(decodeURIComponent(match[1] ?? ""));
      if (!record) return json(404, { protocolVersion: 1, error: { class: "unavailable", code: "preparation_not_found" } });
      if (method === "DELETE") {
        this.publish(record.item.preparationId, { status: "cancelled" });
        return json(200, record.item);
      }
      const after = Number(url.searchParams.get("afterVersion") ?? -1);
      if (record.item.version > after) return json(200, record.item);
      const next = await new Promise<PreparedItemV1 | null>((resolve) => {
        record.waiters.push(resolve);
        signal?.addEventListener("abort", () => resolve(null), { once: true });
      });
      if (!next) throw new DOMException("aborted", "AbortError");
      return json(200, next);
    }
    if (method === "POST" && url.pathname === API_V1_PATHS.resolve) {
      return json(200, { protocolVersion: 1, itemId: body.itemId, media: mediaWire(body.track, `rev-${body.track.mediaId}-r`) });
    }
    return json(404, { protocolVersion: 1, error: { class: "unavailable", code: "not_found" } });
  };

  count(method: string, path: string | RegExp): number {
    return this.requests.filter((request) => request.method === method && (typeof path === "string" ? request.path === path : path.test(request.path))).length;
  }

  /** Publishes a new version of a preparation with some stages changed. */
  publish(preparationId: string, change: { status?: PreparedItemV1["status"]; candidate?: Stage<CandidateV1>; source?: Stage<ResolvedMediaWire> }): void {
    const record = this.preparations.get(preparationId);
    if (!record) throw new Error(`no preparation ${preparationId}`);
    const item: PreparedItemV1 = {
      ...record.item,
      version: record.item.version + 1,
      status: change.status ?? record.item.status,
      stages: { ...record.item.stages, ...(change.candidate ? { candidate: change.candidate } : {}), ...(change.source ? { source: change.source } : {}) }
    };
    record.item = item;
    const waiters = record.waiters.splice(0);
    for (const resolve of waiters) resolve(item);
  }

  private prepare(body: { itemId: QueueItemId; purpose: string; target: { kind: string; track?: TrackRef } }): Response {
    if (this.failNextPrepare) {
      const failure = this.failNextPrepare;
      this.failNextPrepare = null;
      return json(failure.status, { protocolVersion: 1, error: { class: failure.class, code: failure.code } });
    }
    const preparationId = `prep-${++this.counter}`;
    const track = body.target.kind === "track" ? body.target.track ?? null : this.radioPick;
    const pending = { status: "pending" } as const;
    const candidate: Stage<CandidateV1> =
      track === null
        ? { status: "failed", error: { class: "unavailable", code: "no_candidate" } }
        : this.autoReady
          ? { status: "ready", value: { track, display: { title: `Song ${track.mediaId}`, artist: "Fixture" } } }
          : pending;
    const source: Stage<ResolvedMediaWire> = track === null ? { status: "cancelled" } : this.autoReady ? { status: "ready", value: mediaWire(track) } : pending;
    const item: PreparedItemV1 = {
      protocolVersion: PROTOCOL_VERSION,
      preparationId: asId(preparationId),
      version: 0,
      itemId: body.itemId,
      status: track === null ? "failed" : "active",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      stages: { candidate, source, lyrics: { status: "skipped", reason: "not requested" }, script: { status: "skipped", reason: "none" }, voice: { status: "skipped", reason: "none" } }
    };
    this.preparations.set(preparationId, { item, waiters: [] });
    return json(200, item);
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Deterministic timers: nothing fires until `advance`. */
export class ManualTimers implements Timers {
  private seq = 0;
  now = 0;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { at: this.now + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, entry] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (entry.at > this.now) continue;
      this.pending.delete(id);
      entry.callback();
    }
  }

  get size(): number {
    return this.pending.size;
  }
}

/** Lets pending promise chains (fetch → json → decode) run. */
export async function flush(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
