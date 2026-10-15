import { throwIfAborted } from "../../application/errors.js";
import { abortableDelay, raceAbort, withDeadline } from "../../application/operations.js";

export interface LocalServiceStarterDeps {
  /** User setting; when false nothing is probed or launched. */
  readonly enabled: boolean;
  /** True when the service answers. Must honour the signal. */
  readonly probe: (signal: AbortSignal) => Promise<boolean>;
  /** Launches the service detached; false when there is nothing to launch. */
  readonly launch: () => boolean;
  /** Upper bound for one start attempt: first probe, launch and readiness polling. */
  readonly bootDeadlineMs: number;
  readonly pollMs: number;
  /** After a failed attempt, further launches are refused for this long. */
  readonly retryAfterMs: number;
  readonly now?: () => number;
}

/**
 * Starts a bundled local service on demand. Concurrent callers share one
 * attempt (one launch at most); each caller may abort its own wait without
 * cancelling the attempt, and every attempt ends within `bootDeadlineMs`.
 * Constructing it has no side effects.
 */
export class LocalServiceStarter {
  private attempt: Promise<boolean> | null = null;
  private failedAt: number | null = null;
  private launched = 0;
  private started = 0;

  constructor(private readonly deps: LocalServiceStarterDeps) {}

  get enabled(): boolean {
    return this.deps.enabled;
  }

  /** Start attempts and launches so far (diagnostics and tests). */
  get attempts(): number {
    return this.started;
  }

  get launches(): number {
    return this.launched;
  }

  async ensure(signal: AbortSignal): Promise<boolean> {
    if (!this.deps.enabled) return false;
    throwIfAborted(signal);
    if (!this.attempt) {
      const now = this.now();
      if (this.failedAt !== null && now - this.failedAt < this.deps.retryAfterMs) return false;
      this.started += 1;
      this.attempt = this.start().finally(() => {
        this.attempt = null;
      });
    }
    return raceAbort(this.attempt, signal);
  }

  private async start(): Promise<boolean> {
    const scoped = withDeadline(new AbortController().signal, this.deps.bootDeadlineMs);
    try {
      if (await this.probe(scoped.signal)) return this.succeeded();
      if (scoped.signal.aborted) return this.failed();
      let launched = false;
      try {
        launched = this.deps.launch();
      } catch {
        launched = false;
      }
      if (!launched) return this.failed();
      this.launched += 1;
      while (!scoped.signal.aborted) {
        try {
          await abortableDelay(this.deps.pollMs, scoped.signal);
        } catch {
          break;
        }
        if (await this.probe(scoped.signal)) return this.succeeded();
      }
      return this.failed();
    } finally {
      scoped.dispose();
    }
  }

  private async probe(signal: AbortSignal): Promise<boolean> {
    try {
      return await raceAbort(this.deps.probe(signal), signal);
    } catch {
      return false;
    }
  }

  private succeeded(): boolean {
    this.failedAt = null;
    return true;
  }

  private failed(): boolean {
    this.failedAt = this.now();
    return false;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
