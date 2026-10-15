import { nowConflictFor, type NowConflictV1, type NowProjectionV1 } from "@claudio/contracts";
import { AppError } from "../errors.js";

/** A refused projection; carries the shared 409 body naming the accepted owner. */
export class NowConflictError extends AppError {
  constructor(readonly conflict: NowConflictV1) {
    super(conflict.error.class, conflict.error.code, `${conflict.reason}: current generation ${conflict.current.generation}`);
  }
}

/**
 * Observation-only projection of the single executor, ordered by the shared
 * contract rule: a larger same-origin generation takes over; within one
 * generation only the same instance with a larger seq is newer; anything
 * else is refused with the current owner's generation/instance/seq so a
 * page whose stored counter was lost can step past it once. Generations are
 * only as good as the executor's same-origin counter: two devices or
 * browser profiles count separately and are not arbitrated here.
 *
 * Memory only: after a server restart the first valid projection sets the
 * state again. Accepting a projection never starts or advances playback.
 */
export class NowService {
  private current: NowProjectionV1 | null = null;
  private readonly listeners = new Set<(projection: NowProjectionV1) => void>();

  get(): NowProjectionV1 | null {
    return this.current;
  }

  accept(projection: NowProjectionV1): NowProjectionV1 {
    const conflict = this.current ? nowConflictFor(this.current, projection) : null;
    if (conflict) throw new NowConflictError(conflict);
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
