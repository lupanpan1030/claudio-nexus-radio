import type { ErrorInfo, FailureOutcome, OperationId, OperationKind, OperationOutcome, PlaybackFact } from "@claudio/contracts";
import { errorInfoOf, hostTimers, silentLog, type LogPort, type RuntimeClock, type Timers } from "./ports.js";

export interface OperationDeadlines {
  readonly prepare: number;
  readonly cue: number;
  readonly lyrics: number;
}

/** Upper bounds, not measured optima: generous enough for TTS, small enough that a hung port cannot pin a cue forever. */
export const DEFAULT_OPERATION_DEADLINES: OperationDeadlines = Object.freeze({ prepare: 20_000, cue: 30_000, lyrics: 15_000 });

export interface OperationSpec<T> {
  readonly kind: OperationKind;
  readonly opId: OperationId;
  run(signal: AbortSignal): Promise<T>;
  /** Fact for a successful answer; carries the identities of the effect that asked. */
  completed(value: T): PlaybackFact;
  /** Fact for failure/timeout; `cancelled` never produces a fact (the core already settled it). */
  failed(outcome: Exclude<FailureOutcome, "cancelled">, error: ErrorInfo): PlaybackFact;
}

interface Running {
  readonly kind: OperationKind;
  readonly controller: AbortController;
  timer: unknown;
  settle(outcome: OperationOutcome): void;
}

export interface OperationRunnerOptions {
  readonly emit: (fact: PlaybackFact) => void;
  readonly deadlines?: Partial<OperationDeadlines>;
  readonly timers?: Timers;
  readonly clock: RuntimeClock;
  readonly log?: LogPort;
}

/**
 * Runs the core's asynchronous operations. Every operation ends in exactly
 * one outcome; cancel settles immediately and aborts best-effort; a port that
 * never answers is closed by its deadline. Answers after settlement are
 * dropped and logged, never fed to the core.
 */
export class OperationRunner {
  private readonly running = new Map<OperationId, Running>();
  private readonly outcomes = new Map<OperationId, Promise<OperationOutcome>>();
  private readonly deadlines: OperationDeadlines;
  private readonly timers: Timers;
  private readonly log: LogPort;
  private disposed = false;

  constructor(private readonly options: OperationRunnerOptions) {
    this.deadlines = { ...DEFAULT_OPERATION_DEADLINES, ...options.deadlines };
    this.timers = options.timers ?? hostTimers;
    this.log = options.log ?? silentLog;
  }

  get activeCount(): number {
    return this.running.size;
  }

  /** Outcome of an operation started by this runner (kept for the last 200 operations). */
  outcome(opId: OperationId): Promise<OperationOutcome> | undefined {
    return this.outcomes.get(opId);
  }

  start<T>(spec: OperationSpec<T>): void {
    if (this.disposed) return;
    if (this.running.has(spec.opId)) {
      this.log({ level: "warn", event: "operation.duplicate-start", at: this.options.clock(), data: { opId: spec.opId } });
      return;
    }
    const controller = new AbortController();
    let settleOutcome!: (outcome: OperationOutcome) => void;
    this.outcomes.set(spec.opId, new Promise<OperationOutcome>((resolve) => (settleOutcome = resolve)));
    this.trimOutcomes();
    const entry: Running = {
      kind: spec.kind,
      controller,
      timer: null,
      settle: (outcome) => {
        this.timers.clearTimeout(entry.timer);
        this.running.delete(spec.opId);
        settleOutcome(outcome);
      }
    };
    this.running.set(spec.opId, entry);

    entry.timer = this.timers.setTimeout(() => {
      if (this.running.get(spec.opId) !== entry) return;
      entry.settle("timed-out");
      controller.abort(new DOMException(`${spec.kind} deadline exceeded`, "TimeoutError"));
      this.options.emit(spec.failed("timed-out", { class: "retryable", code: `${spec.kind}_timeout` }));
    }, this.deadlines[spec.kind]);

    let pending: Promise<T>;
    try {
      pending = Promise.resolve(spec.run(controller.signal));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (value) => {
        if (this.running.get(spec.opId) !== entry) return this.late(spec, "completed");
        entry.settle("completed");
        this.options.emit(spec.completed(value));
      },
      (error: unknown) => {
        if (this.running.get(spec.opId) !== entry) return this.late(spec, "failed");
        entry.settle("failed");
        this.options.emit(spec.failed("failed", errorInfoOf(error, `${spec.kind}_failed`)));
      }
    );
  }

  /** The core already stopped waiting: settle now, abort the port, emit nothing. */
  cancel(opId: OperationId): void {
    const entry = this.running.get(opId);
    if (!entry) return;
    entry.settle("cancelled");
    entry.controller.abort(new DOMException("operation cancelled", "AbortError"));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const opId of [...this.running.keys()]) this.cancel(opId);
  }

  private late(spec: OperationSpec<unknown>, answer: string): void {
    this.log({ level: "debug", event: "operation.late", at: this.options.clock(), data: { opId: spec.opId, kind: spec.kind, answer } });
  }

  private trimOutcomes(): void {
    while (this.outcomes.size > 200) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined || this.running.has(oldest)) break;
      this.outcomes.delete(oldest);
    }
  }
}
