import { asId, type CandidateV1, type ErrorInfo, type PreparedItemV1, type PlaybackCommand, type PlaybackSnapshot, type PreparationId, type QueueItemId } from "@claudio/contracts";
import type { ReservableIdFactory } from "@claudio/playback-core";
import { PortError, hostTimers, silentLog, type DispatchResult, type LogPort, type Timers } from "@claudio/playback-web";
import { errorInfoFromUnknown, stageFailure, type HttpPreparePort, type PreparationClient } from "./preparation";
import { createStatusStore, type StatusStore } from "./status-store";

export interface RefillTarget {
  dispatch(command: PlaybackCommand): DispatchResult;
  getSnapshot(): PlaybackSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface RefillPolicy {
  /** Attempts per program context before giving up until the program changes or the user retries. Configuration, not a measured value. */
  readonly maxAttempts: number;
  /** Delay before attempt n+1 (last value repeats). */
  readonly backoffMs: readonly number[];
}

export const DEFAULT_REFILL_POLICY: RefillPolicy = Object.freeze({ maxAttempts: 3, backoffMs: [1500, 5000, 15_000] });

export type RefillPhase =
  /** Nothing to do: the queue has a next item, or playback is stopped. */
  | "idle"
  | "selecting"
  | "retry-wait"
  /** The server has no candidate for this context; waits for the program to change or a manual retry. */
  | "no-candidate"
  | "gave-up";

export interface RefillStatus {
  readonly phase: RefillPhase;
  /** True while serving a listener's play click on an empty queue. */
  readonly userInitiated: boolean;
  /**
   * True while that listener start will still play its candidate on arrival.
   * Any later pause/stop withdraws it (the candidate then only waits in the queue).
   */
  readonly autoplay: boolean;
  readonly attempts: number;
  readonly lastError: ErrorInfo | null;
}

const IDLE: RefillStatus = Object.freeze({ phase: "idle", userInitiated: false, autoplay: false, attempts: 0, lastError: null });

interface Context {
  readonly key: string;
  readonly afterItemId: QueueItemId | null;
}

/** One listener start from an empty queue; shared by its attempts and retries. */
interface UserStart {
  readonly seq: number;
  /** Cleared by an explicit pause/stop; never set again for this start. */
  autoplay: boolean;
}

interface InFlight {
  readonly key: string;
  readonly user: UserStart | null;
  readonly controller: AbortController;
  readonly itemId: QueueItemId;
  preparationId: PreparationId | null;
}

export interface RadioRefillOptions {
  readonly target: RefillTarget;
  readonly client: Pick<PreparationClient, "start" | "waitForStage" | "cancel">;
  readonly port: Pick<HttpPreparePort, "adopt" | "release">;
  /** The runtime's own factory: reserved item ids are claimable by the core exactly once. */
  readonly ids: ReservableIdFactory;
  /** Current user-intent sequence (see PlaybackController). */
  readonly userActionSeq: () => number;
  readonly policy?: Partial<RefillPolicy>;
  readonly timers?: Timers;
  readonly log?: LogPort;
  readonly clock?: () => number;
}

/** Items after the program; the program's own entry may still sit in the queue while it is reserved. */
export function upcomingEntries(snapshot: PlaybackSnapshot): PlaybackSnapshot["queue"] {
  const programId = snapshot.program?.item.itemId;
  return snapshot.queue.filter((entry) => entry.item.itemId !== programId);
}

/** Which radio context needs a next item, if any. Pure; drives singleflight keys. */
export function refillContext(snapshot: PlaybackSnapshot): Context | null {
  if (upcomingEntries(snapshot).length > 0) return null;
  if (snapshot.program) {
    if (!snapshot.program.started) return null;
    return { key: `after:${snapshot.program.item.itemId}`, afterItemId: snapshot.program.item.itemId };
  }
  if (snapshot.transport !== "exhausted") return null;
  // Same key as "after the program" for the item that just ended, so a refill
  // already running for it keeps going when the queue runs out.
  const last = snapshot.history.at(-1)?.item.itemId ?? null;
  return { key: `after:${last ?? "-"}`, afterItemId: last };
}

/**
 * Owner-only radio continuation. Picks a server radio candidate ahead of time
 * so the queue never runs dry: pre-allocates the queue item id, POSTs one
 * preparation for the candidate, and once the candidate is known enqueues it
 * under that id (the PreparePort adopts the preparation instead of preparing
 * again). One request at a time; a bounded number of attempts per program;
 * a candidate that arrives after its context changed is cancelled, not queued.
 *
 * A background refill never sends resume itself. Its enqueue still continues
 * playback when the queue had already run out while the listener wanted
 * playback (`exhausted`): that is the core's rule for enqueue, and the reason
 * a refill keeps running into exhaustion. After an explicit pause/stop the
 * core is no longer exhausted, so nothing starts. Only a listener's start from
 * an empty queue resumes, and only while its `autoplay` mark still stands.
 * Attempt/stop bookkeeping is kept for the current context only.
 */
export class RadioRefill {
  private readonly store: StatusStore<RefillStatus> = createStatusStore(IDLE);
  private readonly policy: RefillPolicy;
  private readonly timers: Timers;
  private readonly log: LogPort;
  private readonly clock: () => number;
  private inFlight: InFlight | null = null;
  private retryTimer: { key: string; handle: unknown; user: UserStart | null } | null = null;
  /** Bookkeeping for at most the current background context and the current listener start. */
  private attempts = new Map<string, number>();
  private stopped = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly options: RadioRefillOptions) {
    this.policy = { ...DEFAULT_REFILL_POLICY, ...options.policy };
    this.timers = options.timers ?? hostTimers;
    this.log = options.log ?? silentLog;
    this.clock = options.clock ?? (() => Date.now());
  }

  readonly getStatus = (): RefillStatus => this.store.get();
  readonly subscribeStatus = (listener: () => void): (() => void) => this.store.subscribe(listener);

  start(): void {
    if (this.unsubscribe || this.disposed) return;
    this.unsubscribe = this.options.target.subscribe(() => this.evaluate());
    this.evaluate();
  }

  /**
   * Listener pressed play with nothing queued. Call inside the gesture after
   * unlocking audio. The candidate is played only if no other playback intent
   * happened meanwhile; after a pause/stop it is queued silently.
   */
  startFromEmpty(): void {
    if (this.disposed) return;
    this.cancelInFlight("superseded-by-user");
    this.clearRetry();
    const snapshot = this.options.target.getSnapshot();
    const last = snapshot.history.at(-1)?.item.itemId ?? null;
    const seq = this.options.userActionSeq();
    const key = `user:${seq}`;
    this.forgetExcept(null);
    void this.run({ key, afterItemId: last }, { seq, autoplay: true });
  }

  /**
   * The listener paused or stopped: a start still selecting will not play its
   * candidate (it may still be queued silently) and is not retried.
   */
  cancelStartPlayback(): void {
    const user = this.inFlight?.user ?? this.retryTimer?.user ?? null;
    if (!user || !user.autoplay) return;
    user.autoplay = false;
    const current = this.store.get();
    if (this.retryTimer?.user === user) {
      this.clearRetry();
      return this.publish(IDLE);
    }
    this.publish({ ...current, autoplay: false });
  }

  /** Manual retry after no-candidate/gave-up. */
  retry(): void {
    this.stopped.clear();
    this.attempts.clear();
    this.clearRetry();
    this.evaluate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearRetry();
    this.cancelInFlight("disposed");
  }

  private evaluate(): void {
    if (this.disposed) return;
    const snapshot = this.options.target.getSnapshot();
    const context = refillContext(snapshot);
    const flight = this.inFlight;
    if (flight && !flight.user && flight.key !== context?.key) this.cancelInFlight("context-changed");
    if (this.retryTimer && this.retryTimer.key !== context?.key && !this.retryTimer.key.startsWith("user:")) this.clearRetry();
    if (!context) {
      if (!this.inFlight && !this.retryTimer) this.publish(IDLE);
      return;
    }
    if (this.inFlight || this.retryTimer) return;
    // A new context: earlier contexts can never come back, so their counts go.
    this.forgetExcept(context.key);
    if (this.stopped.has(context.key)) return;
    void this.run(context, null);
  }

  /** Drops attempt/stop records of every context but `key` (personal radio sessions run for hours). */
  private forgetExcept(key: string | null): void {
    for (const known of [...this.attempts.keys()]) if (known !== key) this.attempts.delete(known);
    for (const known of [...this.stopped]) if (known !== key) this.stopped.delete(known);
  }

  /** Bookkeeping size, for tests and diagnostics. */
  get trackedContexts(): number {
    return new Set([...this.attempts.keys(), ...this.stopped]).size;
  }

  private async run(context: Context, user: UserStart | null): Promise<void> {
    const itemId = asId<QueueItemId>(this.options.ids.reserve("item"));
    const flight: InFlight = { key: context.key, user, controller: new AbortController(), itemId, preparationId: null };
    this.inFlight = flight;
    const attempt = (this.attempts.get(context.key) ?? 0) + 1;
    this.attempts.set(context.key, attempt);
    this.publish({ phase: "selecting", userInitiated: user !== null, autoplay: user?.autoplay === true, attempts: attempt, lastError: null });
    const { signal } = flight.controller;
    try {
      const started = await this.options.client.start(
        { itemId, purpose: user ? "program" : "standby", target: { kind: "radio-candidate", afterItemId: context.afterItemId }, narration: null, wantLyrics: false },
        signal
      );
      flight.preparationId = started.preparationId;
      if (signal.aborted) {
        this.options.ids.release(itemId);
        return void this.options.client.cancel(started.preparationId);
      }
      const settled = await this.options.client.waitForStage(started, "candidate", signal);
      const candidate = settled.stages.candidate;
      if (candidate.status !== "ready") throw stageFailure(candidate, "candidate") ?? new PortError({ class: "unavailable", code: "candidate_unavailable" });
      if (signal.aborted || this.inFlight !== flight) {
        this.options.ids.release(itemId);
        return void this.options.client.cancel(settled.preparationId);
      }
      this.inFlight = null;
      this.deliver(flight, settled, candidate.value);
    } catch (error) {
      if (this.inFlight === flight) this.inFlight = null;
      this.options.ids.release(flight.itemId);
      if (signal.aborted || this.disposed) return;
      if (flight.preparationId) void this.options.client.cancel(flight.preparationId);
      this.onFailure(context, user, errorInfoFromUnknown(error), attempt);
    }
  }

  private deliver(flight: InFlight, prepared: PreparedItemV1, candidate: CandidateV1): void {
    const { target } = this.options;
    const snapshot = target.getSnapshot();
    let play = false;
    if (flight.user) {
      const untouched = this.options.userActionSeq() === flight.user.seq;
      const somethingElse = snapshot.program !== null || upcomingEntries(snapshot).length > 0;
      if (!untouched && somethingElse) return this.discard(flight, "user-chose-other");
      play = untouched && flight.user.autoplay;
      // Enqueue into an exhausted queue starts by itself; a start the listener
      // paused or overtook must not sound that way either.
      if (!play && snapshot.transport === "exhausted") return this.discard(flight, "start-withdrawn");
    } else if (refillContext(snapshot)?.key !== flight.key) {
      return this.discard(flight, "context-changed");
    }
    this.options.port.adopt(flight.itemId, prepared);
    target.dispatch({ type: "enqueue", position: "end", entries: [{ track: candidate.track, display: candidate.display, origin: "radio", itemId: flight.itemId }] });
    const after = target.getSnapshot();
    const queued = after.queue.some((entry) => entry.item.itemId === flight.itemId) || after.program?.item.itemId === flight.itemId;
    if (!queued) {
      this.options.ids.release(flight.itemId);
      this.options.port.release(flight.itemId);
      this.log({ level: "warn", event: "refill.enqueue-ignored", at: this.clock(), data: { itemId: flight.itemId } });
    } else if (play) {
      target.dispatch({ type: "resume" });
    }
    this.attempts.delete(flight.key);
    this.publish(IDLE);
    this.evaluate();
  }

  private discard(flight: InFlight, reason: string): void {
    this.options.ids.release(flight.itemId);
    if (flight.preparationId) void this.options.client.cancel(flight.preparationId);
    this.log({ level: "info", event: "refill.discarded", at: this.clock(), data: { reason, itemId: flight.itemId } });
    this.publish(IDLE);
    this.evaluate();
  }

  private onFailure(context: Context, user: UserStart | null, error: ErrorInfo, attempt: number): void {
    this.log({ level: "warn", event: "refill.failed", at: this.clock(), data: { key: context.key, attempt, error } });
    const userInitiated = user !== null;
    if (error.code === "no_candidate") {
      this.stopped.add(context.key);
      return this.publish({ phase: "no-candidate", userInitiated, autoplay: false, attempts: attempt, lastError: error });
    }
    if (attempt >= this.policy.maxAttempts || error.class === "invalid" || error.class === "auth-required") {
      this.stopped.add(context.key);
      return this.publish({ phase: "gave-up", userInitiated, autoplay: false, attempts: attempt, lastError: error });
    }
    // A listener start that was paused/stopped meanwhile is not retried.
    if (user && !user.autoplay) return this.publish(IDLE);
    const wait = this.policy.backoffMs[Math.min(attempt - 1, this.policy.backoffMs.length - 1)] ?? 5000;
    this.publish({ phase: "retry-wait", userInitiated, autoplay: user?.autoplay === true, attempts: attempt, lastError: error });
    const handle = this.timers.setTimeout(() => {
      if (this.retryTimer?.handle !== handle) return;
      this.retryTimer = null;
      if (this.disposed) return;
      if (user) {
        // A user start is retried only while nothing else was asked for and it still wants to play.
        if (this.options.userActionSeq() !== user.seq || !user.autoplay) return this.publish(IDLE);
        void this.run(context, user);
        return;
      }
      this.evaluate();
    }, wait);
    this.retryTimer = { key: context.key, handle, user };
  }

  private cancelInFlight(reason: string): void {
    const flight = this.inFlight;
    if (!flight) return;
    this.inFlight = null;
    flight.controller.abort();
    this.options.ids.release(flight.itemId);
    if (flight.preparationId) void this.options.client.cancel(flight.preparationId);
    this.log({ level: "info", event: "refill.cancelled", at: this.clock(), data: { reason, itemId: flight.itemId } });
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    this.timers.clearTimeout(this.retryTimer.handle);
    this.retryTimer = null;
  }

  private publish(status: RefillStatus): void {
    if (!this.disposed) this.store.set(status);
  }
}
