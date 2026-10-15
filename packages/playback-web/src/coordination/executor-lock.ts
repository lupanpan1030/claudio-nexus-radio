import { silentLog, type LogPort, type RuntimeClock, performanceClock } from "../ports.js";

/**
 * Roles of one page in the same-origin executor election.
 *  pending:     asking for the lock
 *  executor:    holds the Web Lock; the only page allowed to create a driver
 *  observer:    another page holds the lock; read-only
 *  unsupported: no Web Locks in this browser; nothing is claimed
 *  disposed:    released
 */
export type ExecutorRole = "pending" | "executor" | "observer" | "unsupported" | "disposed";

/** Structural subset of the Web Locks API so tests and non-DOM hosts can inject one. */
export interface LockManagerLike {
  request(name: string, options: { signal?: AbortSignal; ifAvailable?: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>;
}

export interface ExecutorLockOptions {
  readonly name: string;
  /** Defaults to `navigator.locks`; pass null to model a browser without Web Locks. */
  readonly locks?: LockManagerLike | null;
  /** Runs when this page becomes the executor (create the runtime/driver here). */
  readonly onAcquire: () => Promise<void> | void;
  /** Runs before the lock is released (dispose the runtime here) so two pages never sound together. */
  readonly onRelease: () => Promise<void> | void;
  readonly onRoleChange?: (role: ExecutorRole) => void;
  readonly log?: LogPort;
  readonly clock?: RuntimeClock;
}

export interface ExecutorLock {
  readonly role: ExecutorRole;
  /** Releases or abandons the lock; resolves once nothing of this page holds or awaits it. */
  dispose(): Promise<void>;
}

function defaultLocks(): LockManagerLike | null {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks ?? null;
}

/**
 * Same-origin single executor via Web Locks. The lock is held for as long as
 * this page executes; the browser releases it when the page goes away, which
 * lets the next waiting page take over. Without Web Locks the role is
 * "unsupported": no localStorage heuristic pretends to be an atomic lock.
 * Exclusivity covers one browser profile/origin, not other browsers or devices.
 */
export function createExecutorLock(options: ExecutorLockOptions): ExecutorLock {
  const locks = options.locks === undefined ? defaultLocks() : options.locks;
  const log = options.log ?? silentLog;
  const clock = options.clock ?? performanceClock;
  let role: ExecutorRole = "pending";
  let disposed = false;
  let release: (() => void) | null = null;
  const abort = new AbortController();

  const setRole = (next: ExecutorRole) => {
    if (role === next) return;
    role = next;
    log({ level: "info", event: "executor.role", at: clock(), data: { name: options.name, role } });
    options.onRoleChange?.(next);
  };

  const hold = async (): Promise<void> => {
    if (disposed) return;
    setRole("executor");
    const held = new Promise<void>((resolve) => (release = resolve));
    try {
      await options.onAcquire();
    } catch (error) {
      log({ level: "error", event: "executor.acquire-failed", at: clock(), data: String(error) });
    }
    await held;
    try {
      await options.onRelease();
    } catch (error) {
      log({ level: "error", event: "executor.release-failed", at: clock(), data: String(error) });
    }
  };

  let settled: Promise<void>;
  if (!locks) {
    setRole("unsupported");
    settled = Promise.resolve();
  } else {
    // First a non-blocking probe so a second page can show "observer" at once,
    // then a queued request that takes over when the holder goes away.
    settled = locks
      .request(options.name, { ifAvailable: true }, async (lock) => {
        if (lock) return hold();
        if (disposed) return;
        setRole("observer");
        await locks.request(options.name, { signal: abort.signal }, () => hold());
      })
      .then(
        () => undefined,
        (error: unknown) => {
          if (!(disposed && isAbort(error))) log({ level: "warn", event: "executor.lock-error", at: clock(), data: String(error) });
        }
      );
  }

  return {
    get role() {
      return role;
    },
    async dispose() {
      if (disposed) return settled;
      disposed = true;
      abort.abort();
      release?.();
      await settled;
      setRole("disposed");
    }
  };
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}
