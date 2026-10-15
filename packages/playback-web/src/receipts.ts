import type { IdempotencyKey, PlaybackFact, PlaybackReceipt, ReceiptOutcome } from "@claudio/contracts";
import { errorInfoOf, hostTimers, silentLog, type LogPort, type ReceiptPort, type RuntimeClock, type Timers } from "./ports.js";

export interface ReceiptPolicy {
  /** Total attempts including the first. */
  readonly maxAttempts: number;
  /** Deadline for one attempt (a hung sink cannot hold a retry slot). */
  readonly attemptTimeoutMs: number;
  /** Delay before attempt n+1 (last value repeats). */
  readonly backoffMs: readonly number[];
}

export const DEFAULT_RECEIPT_POLICY: ReceiptPolicy = Object.freeze({
  maxAttempts: 4,
  attemptTimeoutMs: 10_000,
  backoffMs: Object.freeze([1_000, 4_000, 15_000])
});

export interface ReceiptReporterOptions {
  readonly port: ReceiptPort;
  readonly emit: (fact: PlaybackFact) => void;
  readonly clock: RuntimeClock;
  readonly policy?: Partial<ReceiptPolicy>;
  readonly timers?: Timers;
  readonly log?: LogPort;
}

/**
 * Fire-and-forget started receipts. Every attempt sends the identical receipt
 * (same idempotency key); retries are bounded; failure is reported as a fact
 * and never touches audio. Nothing is persisted, so a reload or crash during
 * retry can lose a receipt: delivery is at-most-bounded-retries, not exactly-once.
 */
export class ReceiptReporter {
  private readonly policy: ReceiptPolicy;
  private readonly timers: Timers;
  private readonly log: LogPort;
  private readonly inFlight = new Map<IdempotencyKey, Slot>();
  private disposed = false;

  constructor(private readonly options: ReceiptReporterOptions) {
    this.policy = { ...DEFAULT_RECEIPT_POLICY, ...options.policy };
    this.timers = options.timers ?? hostTimers;
    this.log = options.log ?? silentLog;
  }

  get activeCount(): number {
    return this.inFlight.size;
  }

  /** Resolves with the final outcome; a second report of the same key joins the first. */
  report(receipt: PlaybackReceipt): Promise<ReceiptOutcome> {
    const existing = this.inFlight.get(receipt.idempotencyKey);
    if (existing) return existing.done;
    if (this.disposed) return Promise.resolve("failed");
    let finish!: (outcome: ReceiptOutcome) => void;
    const done = new Promise<ReceiptOutcome>((resolve) => (finish = resolve));
    const slot: Slot = { controller: null, timer: null, done, finish };
    this.inFlight.set(receipt.idempotencyKey, slot);

    const settle = (outcome: ReceiptOutcome, attempt: number) => {
      if (this.inFlight.get(receipt.idempotencyKey) !== slot) return;
      this.inFlight.delete(receipt.idempotencyKey);
      slot.finish(outcome);
      this.log({ level: outcome === "failed" ? "warn" : "debug", event: "receipt.settled", at: this.options.clock(), data: { key: receipt.idempotencyKey, outcome, attempts: attempt } });
      if (!this.disposed) {
        this.options.emit({ type: "receipt.settled", idempotencyKey: receipt.idempotencyKey, itemId: receipt.itemId, outcome });
      }
    };

    const attempt = (n: number) => {
      if (this.disposed || this.inFlight.get(receipt.idempotencyKey) !== slot) return;
      const controller = new AbortController();
      slot.controller = controller;
      let answered = false;
      // A late answer after dispose (or after the slot was replaced) must not schedule anything:
      // dispose's abort makes a fetch-like port reject in a later microtask.
      const live = () => !this.disposed && this.inFlight.get(receipt.idempotencyKey) === slot;
      const onFailure = (retryable: boolean, reason: unknown) => {
        if (answered) return;
        answered = true;
        if (!live()) return;
        this.timers.clearTimeout(slot.timer);
        slot.controller = null;
        this.log({ level: "debug", event: "receipt.attempt-failed", at: this.options.clock(), data: { key: receipt.idempotencyKey, attempt: n, reason } });
        if (!retryable || n >= this.policy.maxAttempts) return settle("failed", n);
        const delay = this.policy.backoffMs[Math.min(n - 1, this.policy.backoffMs.length - 1)] ?? 0;
        slot.timer = this.timers.setTimeout(() => attempt(n + 1), delay);
      };
      slot.timer = this.timers.setTimeout(() => {
        controller.abort(new DOMException("receipt attempt deadline", "TimeoutError"));
        onFailure(true, "timeout");
      }, this.policy.attemptTimeoutMs);
      let pending: Promise<"recorded" | "duplicate">;
      try {
        pending = Promise.resolve(this.options.port.report(receipt, controller.signal));
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending.then(
        (status) => {
          if (answered) return;
          answered = true;
          if (!live()) return;
          this.timers.clearTimeout(slot.timer);
          slot.controller = null;
          settle(status, n);
        },
        (error: unknown) => {
          const info = errorInfoOf(error, "receipt_failed");
          onFailure(info.class === "retryable", info.code);
        }
      );
    };
    attempt(1);
    return done;
  }

  /** Stops retrying; pending receipts are reported to their awaiters as failed (no fact is emitted). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [key, slot] of [...this.inFlight]) {
      this.timers.clearTimeout(slot.timer);
      slot.controller?.abort(new DOMException("runtime disposed", "AbortError"));
      this.inFlight.delete(key);
      slot.finish("failed");
    }
  }
}

interface Slot {
  controller: AbortController | null;
  timer: unknown;
  readonly done: Promise<ReceiptOutcome>;
  readonly finish: (outcome: ReceiptOutcome) => void;
}
