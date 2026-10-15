/** Minimal external store for small service status values (useSyncExternalStore-compatible). */
export interface StatusStore<T> {
  get(): T;
  set(next: T): void;
  subscribe(listener: () => void): () => void;
}

export function createStatusStore<T>(initial: T, equals: (a: T, b: T) => boolean = shallowEqual): StatusStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (equals(value, next)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((key) => Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
