export type IdKind = "item" | "load" | "transition" | "cue" | "voice-load" | "op" | "play";

/**
 * Injected identity source. Implementations must never repeat a value within
 * one executor instance; prefixing with the instance id keeps ids unique
 * across reloads.
 */
export interface IdFactory {
  next(kind: IdKind): string;
}

/**
 * An IdFactory that can also hand out ids ahead of use, e.g. a radio
 * candidate whose server preparation is requested under its future
 * QueueItemId. The owner passes the same instance to the runtime (core) and
 * to the service that reserves.
 *
 * Only reservations that are in flight are remembered: claim/release forget
 * them, so memory is bounded by `maxReserved`, not by session length. An id
 * from `next()` is never reserved and therefore never claimable.
 */
export interface ReservableIdFactory extends IdFactory {
  /** A fresh id held for a later claim. Throws RangeError when `maxReserved` are already held. */
  reserve(kind: IdKind): string;
  /** True while `id` is reserved and neither claimed nor released. */
  isReserved(id: string): boolean;
  /** Consume a reservation. True exactly once per reserved id; false for unknown/claimed/released ids. */
  claim(id: string): boolean;
  /** Give up an unclaimed reservation (candidate failed or abandoned). True if it was held. */
  release(id: string): boolean;
  /** Reservations currently held. */
  readonly reservedCount: number;
  readonly maxReserved: number;
}

export function isReservableIdFactory(ids: IdFactory): ids is ReservableIdFactory {
  const candidate = ids as Partial<ReservableIdFactory>;
  return typeof candidate.reserve === "function" && typeof candidate.isReserved === "function" && typeof candidate.claim === "function";
}

/** Default bound on in-flight reservations; a leak surfaces as a RangeError instead of growing forever. */
export const DEFAULT_MAX_RESERVED_IDS = 64;

/**
 * Adds reservations to an existing id source. Reserved ids come from the
 * same `next()` stream, so they never collide with ids the core generates.
 */
export function withReservations(base: IdFactory, options: { maxReserved?: number } = {}): ReservableIdFactory {
  const maxReserved = options.maxReserved ?? DEFAULT_MAX_RESERVED_IDS;
  if (!Number.isSafeInteger(maxReserved) || maxReserved < 1) throw new RangeError(`invalid maxReserved: ${String(maxReserved)}`);
  const reserved = new Set<string>();
  return {
    maxReserved,
    get reservedCount() {
      return reserved.size;
    },
    next(kind) {
      return base.next(kind);
    },
    reserve(kind) {
      if (reserved.size >= maxReserved) throw new RangeError(`more than ${maxReserved} ids reserved; release abandoned reservations`);
      const id = base.next(kind);
      reserved.add(id);
      return id;
    },
    isReserved(id) {
      return reserved.has(id);
    },
    claim(id) {
      return reserved.delete(id);
    },
    release(id) {
      return reserved.delete(id);
    }
  };
}

/** Deterministic counter-based ids, e.g. "exec1:item:3", with reservations. */
export function createSequentialIds(prefix: string, options: { maxReserved?: number } = {}): ReservableIdFactory {
  let counter = 0;
  return withReservations(
    {
      next(kind) {
        counter += 1;
        return `${prefix}:${kind}:${counter}`;
      }
    },
    options
  );
}
