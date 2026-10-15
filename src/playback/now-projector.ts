import { NOW_CONFLICT_HTTP_STATUS, PROTOCOL_VERSION, decode, nowConflictV1Decoder, type ExecutorInstanceId, type NowConflictV1, type NowProjectionV1, type PlaybackSnapshot } from "@claudio/contracts";
import { hostTimers, type ClockReader, type Timers } from "@claudio/playback-web";
import { programMusicSample, positionAt } from "./clock";
import type { FetchLike } from "./http";
import { upcomingEntries } from "./radio-refill";

export interface NowSource {
  getSnapshot(): PlaybackSnapshot;
  subscribe(listener: () => void): () => void;
  readonly clock: ClockReader;
}

export interface NowProjectorOptions {
  readonly source: NowSource;
  readonly fetchFn: FetchLike;
  readonly path: string;
  readonly executorInstanceId: ExecutorInstanceId;
  /** Same-origin executor generation (see NowProjectionV1). */
  readonly generation: number;
  /** True while this page still holds the executor lock with this runtime. */
  readonly isCurrentOwner: () => boolean;
  /**
   * Persists a same-origin generation of at least `atLeast` (monotonic) and
   * returns the value now in force, or null when none can be used.
   */
  readonly raiseGeneration: (atLeast: number) => number | null;
  readonly clock: () => number;
  /** Position refresh while something plays; identity changes are sent at once. */
  readonly refreshMs?: number;
  readonly timeoutMs?: number;
  readonly timers?: Timers;
}

/** Pure projection of one executor snapshot (no position: the caller samples the live clock). */
export function projectNow(snapshot: PlaybackSnapshot, executorInstanceId: ExecutorInstanceId, generation: number, seq: number, observedAtIso: string, positionMs: number | null): NowProjectionV1 {
  const program = snapshot.program;
  return {
    protocolVersion: PROTOCOL_VERSION,
    executorInstanceId,
    generation,
    seq,
    observedAt: observedAtIso,
    transport: snapshot.transport,
    item: program ? { itemId: program.item.itemId, track: program.item.track, display: program.item.display } : null,
    positionMs: positionMs === null ? null : Math.max(0, Math.round(positionMs)),
    nextItemId: upcomingEntries(snapshot)[0]?.item.itemId ?? null,
    speaking: snapshot.voice?.status === "speaking"
  };
}

function identityKey(snapshot: PlaybackSnapshot): string {
  return [snapshot.transport, snapshot.program?.item.itemId ?? "-", upcomingEntries(snapshot)[0]?.item.itemId ?? "-", snapshot.voice?.status === "speaking"].join("|");
}

type PutOutcome = { readonly kind: "ok" | "failed" | "aborted" } | { readonly kind: "conflict"; readonly conflict: NowConflictV1 | null };

/**
 * Owner-only, low-frequency observation feed for PUT /api/v1/now. Strictly
 * increasing seq per executor instance; at most one request in flight, the
 * newest state wins. It never drives playback and failures are ignored.
 *
 * A 409 carries the server's NowConflictV1. While this page is still the
 * current lock owner it recovers once: a newer stored generation elsewhere
 * (storage cleared, server kept an older owner's higher generation) is
 * overtaken by persisting `current.generation + 1`; a late duplicate of its
 * own seq moves seq past the server's. A second conflict, an unreadable 409,
 * or a page that lost the lock or was disposed stops reporting for good, so
 * two pages can never keep outbidding each other.
 */
export class NowProjector {
  private seq = 0;
  private generation: number;
  private recovered = false;
  private lastKey = "";
  private sending = false;
  private dirty = false;
  private timer: unknown = null;
  private inFlight: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private readonly timers: Timers;

  constructor(private readonly options: NowProjectorOptions) {
    this.timers = options.timers ?? hostTimers;
    this.generation = options.generation;
  }

  /** Generation currently reported (diagnostics/tests). */
  get currentGeneration(): number {
    return this.generation;
  }

  get stopped(): boolean {
    return this.disposed;
  }

  start(): void {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = this.options.source.subscribe(() => this.onChange());
    this.onChange();
  }

  /** Stops for good: no new request, the one in flight is aborted, the refresh timer cleared. */
  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  private onChange(): void {
    const key = identityKey(this.options.source.getSnapshot());
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.send();
  }

  private send(): void {
    if (this.disposed) return;
    if (!this.options.isCurrentOwner()) return this.dispose();
    if (this.sending) {
      this.dirty = true;
      return;
    }
    const snapshot = this.options.source.getSnapshot();
    const now = this.options.clock();
    const sample = programMusicSample(snapshot, this.options.source.clock);
    const projection = projectNow(snapshot, this.options.executorInstanceId, this.generation, ++this.seq, new Date(now).toISOString(), sample ? positionAt(sample, now) : null);
    this.sending = true;
    void this.put(projection).then((outcome) => {
      this.sending = false;
      if (this.disposed) return;
      if (outcome.kind === "conflict") {
        if (!this.recoverFrom(outcome.conflict)) return this.dispose();
        this.dirty = false;
        return this.send();
      }
      if (this.dirty) {
        this.dirty = false;
        this.send();
        return;
      }
      this.schedule(snapshot);
    });
  }

  /** At most once per executor, and only for the current lock owner. */
  private recoverFrom(conflict: NowConflictV1 | null): boolean {
    if (!conflict || this.recovered || !this.options.isCurrentOwner()) return false;
    this.recovered = true;
    if (conflict.reason === "stale_projection") {
      if (conflict.current.executorInstanceId !== this.options.executorInstanceId || conflict.current.generation !== this.generation) return false;
      this.seq = Math.max(this.seq, conflict.current.seq);
      return Number.isSafeInteger(this.seq + 1);
    }
    const wanted = conflict.current.generation + 1;
    if (!Number.isSafeInteger(wanted) || wanted <= this.generation) return false;
    const raised = this.options.raiseGeneration(wanted);
    if (raised === null || raised < wanted) return false;
    this.generation = raised;
    return true;
  }

  private async put(projection: NowProjectionV1): Promise<PutOutcome> {
    const controller = new AbortController();
    this.inFlight = controller;
    const timer = this.timers.setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await this.options.fetchFn(this.options.path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projection),
        signal: controller.signal
      });
      if (response.status === NOW_CONFLICT_HTTP_STATUS) {
        const body: unknown = await response.json().catch(() => null);
        const decoded = decode(nowConflictV1Decoder, body);
        return { kind: "conflict", conflict: decoded.ok ? decoded.value : null };
      }
      return { kind: response.ok ? "ok" : "failed" };
    } catch {
      return { kind: controller.signal.aborted ? "aborted" : "failed" };
    } finally {
      this.timers.clearTimeout(timer);
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  private schedule(snapshot: PlaybackSnapshot): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (snapshot.transport !== "playing") return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.send();
    }, this.options.refreshMs ?? 10_000);
  }
}
