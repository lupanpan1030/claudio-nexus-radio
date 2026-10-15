/** Keyed one-shot notifications used for long-polling versioned records. */
export class Watchers<T> {
  private readonly listeners = new Map<string, Set<(value: T) => void>>();

  notify(key: string, value: T): void {
    const set = this.listeners.get(key);
    if (!set) return;
    this.listeners.delete(key);
    for (const listener of set) listener(value);
  }

  /** Resolves with the next published value, or null on timeout/abort. */
  next(key: string, timeoutMs: number, signal: AbortSignal): Promise<T | null> {
    if (signal.aborted || timeoutMs <= 0) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => {
      let set = this.listeners.get(key);
      if (!set) {
        set = new Set();
        this.listeners.set(key, set);
      }
      const listeners = set;
      const finish = (value: T | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        listeners.delete(listener);
        if (listeners.size === 0 && this.listeners.get(key) === listeners) this.listeners.delete(key);
        resolve(value);
      };
      const listener = (value: T) => finish(value);
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
      listeners.add(listener);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  get pendingKeys(): number {
    return this.listeners.size;
  }
}
