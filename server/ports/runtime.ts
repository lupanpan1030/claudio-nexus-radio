/** Wall clock in epoch milliseconds. Injected so expiry/GC tests do not sleep. */
export interface Clock {
  now(): number;
}

/** Opaque identity source for server-side preparation/asset/handle ids. */
export interface IdSource {
  next(prefix: string): string;
}

export const systemClock: Clock = { now: () => Date.now() };
