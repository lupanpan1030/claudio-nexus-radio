/**
 * Stable external store: `getSnapshot` returns the same object until a new
 * value is published, so React's useSyncExternalStore does not loop.
 */
export class SnapshotStore<T> {
  private value: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T, private readonly onListenerError: (error: unknown) => void = () => {}) {
    this.value = deepFreeze(initial);
  }

  readonly getSnapshot = (): T => this.value;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Replaces the value and notifies once. No-op when the same reference is passed. */
  publish(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = deepFreeze(next);
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
