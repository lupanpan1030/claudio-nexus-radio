import type { ExecutorInstanceId, NowProjectionV1 } from "@claudio/contracts";
import { appError } from "../errors.js";

/**
 * Observation-only projection of the single executor. Keeps the highest seq
 * of the current executor instance; a superseded instance cannot write
 * again. Accepting a projection never starts or advances playback.
 */
export class NowService {
  private current: NowProjectionV1 | null = null;
  private readonly superseded = new Set<ExecutorInstanceId>();
  private readonly listeners = new Set<(projection: NowProjectionV1) => void>();

  get(): NowProjectionV1 | null {
    return this.current;
  }

  accept(projection: NowProjectionV1): NowProjectionV1 {
    const current = this.current;
    if (this.superseded.has(projection.executorInstanceId)) {
      throw appError("invalid", "superseded_executor", "a newer executor instance owns the projection");
    }
    if (current && current.executorInstanceId === projection.executorInstanceId && projection.seq <= current.seq) {
      throw appError("invalid", "stale_projection", `seq ${projection.seq} is not newer than ${current.seq}`);
    }
    if (current && current.executorInstanceId !== projection.executorInstanceId) {
      this.superseded.add(current.executorInstanceId);
      // Bounded memory: only recent instances matter for rejecting late writes.
      if (this.superseded.size > 64) this.superseded.delete(this.superseded.values().next().value as ExecutorInstanceId);
    }
    this.current = projection;
    for (const listener of this.listeners) listener(projection);
    return projection;
  }

  subscribe(listener: (projection: NowProjectionV1) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Items the executor reports as current/next; their preparations are protected from GC. */
  referencedItemIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    if (this.current?.item) ids.add(this.current.item.itemId);
    if (this.current?.nextItemId) ids.add(this.current.nextItemId);
    return ids;
  }
}
