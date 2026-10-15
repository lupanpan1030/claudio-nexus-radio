import { PROTOCOL_VERSION, type ExecutorInstanceId, type NowProjectionV1, type PlaybackSnapshot } from "@claudio/contracts";
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

/**
 * Owner-only, low-frequency observation feed for PUT /api/v1/now. Strictly
 * increasing seq per executor instance; at most one request in flight, the
 * newest state wins. It never drives playback and failures are ignored.
 */
export class NowProjector {
  private seq = 0;
  private lastKey = "";
  private sending = false;
  private dirty = false;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private readonly timers: Timers;

  constructor(private readonly options: NowProjectorOptions) {
    this.timers = options.timers ?? hostTimers;
  }

  start(): void {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = this.options.source.subscribe(() => this.onChange());
    this.onChange();
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private onChange(): void {
    const key = identityKey(this.options.source.getSnapshot());
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.send();
  }

  private send(): void {
    if (this.disposed) return;
    if (this.sending) {
      this.dirty = true;
      return;
    }
    const snapshot = this.options.source.getSnapshot();
    const now = this.options.clock();
    const sample = programMusicSample(snapshot, this.options.source.clock);
    const projection = projectNow(snapshot, this.options.executorInstanceId, this.options.generation, ++this.seq, new Date(now).toISOString(), sample ? positionAt(sample, now) : null);
    this.sending = true;
    void this.put(projection).then((outcome) => {
      this.sending = false;
      if (outcome === "conflict") {
        // A newer executor generation owns the projection; this page stops reporting.
        this.dispose();
        return;
      }
      if (this.disposed) return;
      if (this.dirty) {
        this.dirty = false;
        this.send();
        return;
      }
      this.schedule(snapshot);
    });
  }

  private async put(projection: NowProjectionV1): Promise<"ok" | "conflict" | "failed"> {
    const controller = new AbortController();
    const timer = this.timers.setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await this.options.fetchFn(this.options.path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(projection),
        signal: controller.signal
      });
      return response.status === 409 ? "conflict" : response.ok ? "ok" : "failed";
    } catch {
      return "failed";
    } finally {
      this.timers.clearTimeout(timer);
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
