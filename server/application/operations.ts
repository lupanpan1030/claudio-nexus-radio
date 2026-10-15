import { OperationAbort, abortKind } from "./errors.js";

export interface ScopedSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * Child signal that aborts when the parent aborts (same reason) or when
 * `deadlineMs` elapses (timed-out). Callers pass it to fetch AND to body
 * reads, so the deadline also covers response bodies and retries.
 */
export function withDeadline(parent: AbortSignal, deadlineMs: number): ScopedSignal {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  const onParent = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => controller.abort(new OperationAbort("timed-out")), Math.max(0, deadlineMs));
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParent);
    }
  };
}

/** Rejects as soon as the signal aborts, even if `promise` cannot be interrupted. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(new OperationAbort(abortKind(signal) ?? "cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      void promise.catch(() => undefined);
      reject(new OperationAbort(abortKind(signal) ?? "cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return raceAbort(
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    }),
    signal
  );
}

/**
 * One in-flight job per key shared by independent subscribers. Each
 * subscriber may abort on its own; the job itself is aborted only when every
 * subscriber has left before it settled.
 */
export class SharedFlight<V> {
  private readonly flights = new Map<string, { promise: Promise<V>; controller: AbortController; subscribers: number }>();

  run(key: string, start: (signal: AbortSignal) => Promise<V>, signal: AbortSignal): Promise<V> {
    if (signal.aborted) return Promise.reject(new OperationAbort(abortKind(signal) ?? "cancelled"));
    let flight = this.flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => start(controller.signal));
      const created = { promise, controller, subscribers: 0 };
      this.flights.set(key, created);
      const cleanup = () => {
        if (this.flights.get(key) === created) this.flights.delete(key);
      };
      promise.then(cleanup, cleanup);
      flight = created;
    }
    const current = flight;
    current.subscribers += 1;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      current.subscribers -= 1;
      if (current.subscribers === 0 && this.flights.get(key) === current) {
        this.flights.delete(key);
        current.controller.abort(new OperationAbort("cancelled", "all subscribers left"));
      }
    };
    signal.addEventListener("abort", leave, { once: true });
    const settled = current.promise.finally(() => {
      signal.removeEventListener("abort", leave);
      if (!left) {
        left = true;
        current.subscribers -= 1;
      }
    });
    return raceAbort(settled, signal);
  }

  /** Number of jobs currently running (for tests and diagnostics). */
  get size(): number {
    return this.flights.size;
  }
}
