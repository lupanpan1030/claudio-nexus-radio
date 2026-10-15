import { extrapolatePosition, type PlaybackCommand, type PlaybackSnapshot } from "@claudio/contracts";
import { SILENT_SPECTRUM, type ClockReader, type ClockReading, type DeckClock, type SpectrumReader } from "../driver/types.js";
import { performanceClock, silentLog, type LogPort, type RuntimeClock } from "../ports.js";
import type { DispatchResult, PlaybackRuntime } from "../runtime.js";
import { SnapshotStore } from "../snapshot-store.js";
import { createExecutorLock, type ExecutorLock, type ExecutorRole, type LockManagerLike } from "./executor-lock.js";
import { defaultChannelFactory, parseChannelMessage, PROTOCOL, type BroadcastChannelLike, type ChannelFactory, type ChannelMessage } from "./snapshot-channel.js";

export interface HostView {
  readonly role: ExecutorRole;
  /** Instance whose snapshot is shown (this page's runtime or the observed executor). */
  readonly executorInstanceId: string | null;
  readonly snapshot: PlaybackSnapshot | null;
  /** True only while this page holds the Web Lock (or runs unguarded by explicit policy). */
  readonly canControl: boolean;
  /** False when no Web Locks were available and the page runs without a same-origin guarantee. */
  readonly exclusive: boolean;
}

export interface PlaybackHost {
  getView(): HostView;
  subscribe(listener: () => void): () => void;
  dispatch(command: PlaybackCommand): DispatchResult;
  readonly clock: ClockReader;
  readonly spectrum: SpectrumReader;
  unlockAudio(): void;
  dispose(): Promise<void>;
}

export interface PlaybackHostOptions {
  /** Lock and channel name; one per app origin. */
  readonly name: string;
  /** Only called on the page that won the lock. Creates the driver and runtime. */
  readonly createRuntime: () => Promise<PlaybackRuntime> | PlaybackRuntime;
  readonly locks?: LockManagerLike | null;
  readonly channels?: ChannelFactory | null;
  /**
   * Without Web Locks: "refuse" keeps the page read-only (default);
   * "run-unguarded" plays but reports `exclusive: false`.
   */
  readonly unsupportedPolicy?: "refuse" | "run-unguarded";
  readonly clock?: RuntimeClock;
  readonly log?: LogPort;
}

/**
 * Wires the executor election to runtime creation. Observers never create a
 * driver, never prepare, never speak and never report started; they render
 * snapshots the executor broadcasts. A page that takes over starts a fresh
 * runtime: the queue intent comes back stopped and no old cue is replayed.
 */
export function createPlaybackHost(options: PlaybackHostOptions): PlaybackHost {
  return new Host(options);
}

class Host implements PlaybackHost {
  private readonly store: SnapshotStore<HostView>;
  private readonly clockFn: RuntimeClock;
  private readonly log: LogPort;
  private readonly channel: BroadcastChannelLike | null;
  private readonly lock: ExecutorLock | null;
  private runtime: PlaybackRuntime | null = null;
  private unsubscribeRuntime: (() => void) | null = null;
  private role: ExecutorRole = "pending";
  private seq = 0;
  private observed: { instanceId: string; seq: number } | null = null;
  private observedSnapshot: PlaybackSnapshot | null = null;
  private readonly endedInstances = new Set<string>();
  private disposed = false;
  private disposing: Promise<void> | null = null;
  private unguarded = false;

  constructor(private readonly options: PlaybackHostOptions) {
    this.clockFn = options.clock ?? performanceClock;
    this.log = options.log ?? silentLog;
    this.store = new SnapshotStore<HostView>(
      { role: "pending", executorInstanceId: null, snapshot: null, canControl: false, exclusive: true },
      (error) => this.log({ level: "warn", event: "host.listener-error", at: this.clockFn(), data: String(error) })
    );
    const factory = options.channels === undefined ? defaultChannelFactory() : options.channels;
    this.channel = factory ? factory(options.name) : null;
    this.channel?.addEventListener("message", this.onMessage);

    this.lock = createExecutorLock({
      name: options.name,
      locks: options.locks,
      log: this.log,
      clock: this.clockFn,
      onRoleChange: (role) => this.onRole(role),
      onAcquire: () => this.startRuntime(),
      onRelease: () => this.stopRuntime()
    });
    if (this.lock.role === "unsupported" && options.unsupportedPolicy === "run-unguarded") {
      this.unguarded = true;
      void this.startRuntime();
    }
  }

  readonly getView = (): HostView => this.store.getSnapshot();
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  readonly clock: ClockReader = Object.freeze({
    read: (): ClockReading => this.runtime?.clock.read() ?? clockFromSnapshot(this.store.getSnapshot().snapshot, this.clockFn())
  });

  readonly spectrum: SpectrumReader = Object.freeze({
    readMusic: (target: Uint8Array) => (this.runtime ?? { spectrum: SILENT_SPECTRUM }).spectrum.readMusic(target),
    readVoice: (target: Uint8Array) => (this.runtime ?? { spectrum: SILENT_SPECTRUM }).spectrum.readVoice(target),
    voiceLevel: () => (this.runtime ?? { spectrum: SILENT_SPECTRUM }).spectrum.voiceLevel()
  });

  dispatch(command: PlaybackCommand): DispatchResult {
    if (this.disposed) return { accepted: false, reason: "disposed" };
    if (!this.runtime) return { accepted: false, reason: "observer" };
    return this.runtime.dispatch(command);
  }

  unlockAudio(): void {
    this.runtime?.unlockAudio();
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposed = true;
    this.disposing = (async () => {
      if (this.lock) await this.lock.dispose();
      if (this.unguarded) await this.stopRuntime();
      this.channel?.removeEventListener("message", this.onMessage);
      this.channel?.close();
      this.store.clear();
    })();
    return this.disposing;
  }

  private onRole(role: ExecutorRole): void {
    this.role = role;
    if (role === "observer") this.post({ protocol: PROTOCOL, type: "hello" });
    this.publishView();
  }

  private async startRuntime(): Promise<void> {
    if (this.disposed && !this.unguarded) return;
    const runtime = await this.options.createRuntime();
    if (this.disposed && !this.unguarded) {
      await runtime.dispose();
      return;
    }
    this.runtime = runtime;
    this.observed = null;
    this.unsubscribeRuntime = runtime.subscribe(() => this.onRuntimeChange());
    this.onRuntimeChange();
  }

  private async stopRuntime(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = null;
    this.runtime = null;
    await runtime.dispose();
    this.post({ protocol: PROTOCOL, type: "ended", instanceId: runtime.instanceId, seq: ++this.seq });
    this.publishView();
  }

  private onRuntimeChange(): void {
    const runtime = this.runtime;
    if (!runtime) return;
    this.post({ protocol: PROTOCOL, type: "snapshot", instanceId: runtime.instanceId, seq: ++this.seq, snapshot: runtime.getSnapshot() });
    this.publishView();
  }

  private readonly onMessage = (event: { data: unknown }): void => {
    if (this.disposed) return;
    const message = parseChannelMessage(event.data);
    if (!message) return;
    if (message.type === "hello") {
      if (this.runtime) this.onRuntimeChange();
      return;
    }
    if (this.runtime) return; // the executor ignores other pages' state
    if (message.type === "ended") {
      this.endedInstances.add(message.instanceId);
      if (this.observed?.instanceId === message.instanceId) {
        this.observed = null;
        this.observedSnapshot = null;
        this.publishView();
      }
      return;
    }
    if (this.endedInstances.has(message.instanceId)) return;
    if (this.observed && this.observed.instanceId === message.instanceId && message.seq <= this.observed.seq) return; // older snapshot of the same executor
    this.observed = { instanceId: message.instanceId, seq: message.seq };
    this.observedSnapshot = message.snapshot;
    this.publishView();
  };

  private publishView(): void {
    if (this.disposed && this.role === "disposed") return;
    const runtime = this.runtime;
    const view: HostView = runtime
      ? { role: this.role, executorInstanceId: runtime.instanceId, snapshot: runtime.getSnapshot(), canControl: true, exclusive: !this.unguarded }
      : { role: this.role, executorInstanceId: this.observed?.instanceId ?? null, snapshot: this.observedSnapshot, canControl: false, exclusive: this.role !== "unsupported" };
    const current = this.store.getSnapshot();
    if (
      current.role === view.role &&
      current.executorInstanceId === view.executorInstanceId &&
      current.snapshot === view.snapshot &&
      current.canControl === view.canControl &&
      current.exclusive === view.exclusive
    ) {
      return;
    }
    this.store.publish(view);
  }

  private post(message: ChannelMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch (error) {
      this.log({ level: "warn", event: "host.broadcast-failed", at: this.clockFn(), data: String(error) });
    }
  }
}

/** Observer clock: extrapolates the executor's last samples; frozen when they say rate 0. */
export function clockFromSnapshot(snapshot: PlaybackSnapshot | null, now: number): ClockReading {
  const deck = (id: "A" | "B"): DeckClock | null => {
    const view = snapshot?.decks[id];
    if (!view || view.loadId === null || !view.clock) return null;
    const state: DeckClock["state"] = view.status === "idle" || view.status === "ready" ? "loading" : view.status;
    return { deck: id, loadId: view.loadId, positionMs: extrapolatePosition(view.clock, now), rate: view.clock.rate, observedAt: now, state };
  };
  const voice = snapshot?.voice;
  return {
    at: now,
    source: "snapshot",
    decks: { A: deck("A"), B: deck("B") },
    voice:
      voice && voice.voiceLoadId && voice.clock
        ? {
            cueId: voice.cueId,
            voiceLoadId: voice.voiceLoadId,
            positionMs: extrapolatePosition(voice.clock, now),
            rate: voice.clock.rate,
            observedAt: now,
            state: voiceClockState(voice.status, voice.clock.rate)
          }
        : null
  };
}

function voiceClockState(status: string, rate: number): DeckClock["state"] {
  // Plain string: the cue status vocabulary is growing (starting/waiting) and unknown values map to loading.
  switch (status) {
    case "speaking":
      return rate > 0 ? "playing" : "waiting";
    case "waiting":
      return "waiting";
    case "paused":
      return "paused";
    case "ended":
      return "ended";
    case "failed":
      return "failed";
    default:
      return "loading";
  }
}
