import type {
  CueAsset,
  LyricsAvailability,
  PlaybackCommand,
  PlaybackEffect,
  PlaybackFact,
  PlaybackSnapshot,
  QueueEntryRequest,
  ResolvedMedia
} from "@claudio/contracts";
import {
  createInitialState,
  createSequentialIds,
  step,
  toSnapshot,
  type CoreConfig,
  type CoreInput,
  type IdFactory,
  type PlaybackState
} from "@claudio/playback-core";
import { isDriverEffect, type ClockReader, type MediaFact, type PlaybackDriver, type SpectrumReader } from "./driver/types.js";
import { OperationRunner, type OperationDeadlines } from "./operations.js";
import {
  hostTimers,
  performanceClock,
  silentLog,
  type CuePort,
  type LogPort,
  type LyricsPort,
  type PreparePort,
  type QueueStore,
  type ReceiptPort,
  type RuntimeClock,
  type Timers
} from "./ports.js";
import { ReceiptReporter, type ReceiptPolicy } from "./receipts.js";
import { SnapshotStore } from "./snapshot-store.js";

export interface RuntimePorts {
  readonly prepare: PreparePort;
  readonly cue: CuePort;
  readonly lyrics: LyricsPort;
  readonly receipts: ReceiptPort;
}

export interface PlaybackRuntimeOptions {
  readonly driver: PlaybackDriver;
  readonly ports: RuntimePorts;
  /** Identity of this executor; prefixes every id the core creates. */
  readonly instanceId: string;
  readonly ids?: IdFactory;
  readonly clock?: RuntimeClock;
  readonly timers?: Timers;
  readonly log?: LogPort;
  readonly coreConfig?: Partial<CoreConfig>;
  readonly initialSettings?: Partial<PlaybackSnapshot["settings"]>;
  readonly deadlines?: Partial<OperationDeadlines>;
  readonly receiptPolicy?: Partial<ReceiptPolicy>;
  /** When present, the queue intent is restored (stopped) at start and saved on change. */
  readonly queueStore?: QueueStore;
}

export type DispatchResult = { readonly accepted: true; readonly version: number } | { readonly accepted: false; readonly reason: "disposed" | "observer" };

/** The public face of the single executor. UI code only ever sees this. */
export interface PlaybackRuntime {
  readonly instanceId: string;
  dispatch(command: PlaybackCommand): DispatchResult;
  getSnapshot(): PlaybackSnapshot;
  subscribe(listener: () => void): () => void;
  readonly clock: ClockReader;
  readonly spectrum: SpectrumReader;
  /** Call from inside a user gesture (click/keydown) before dispatching play intents. */
  unlockAudio(): void;
  readonly disposed: boolean;
  dispose(): Promise<void>;
}

/**
 * Serial executor around the pure core: one input at a time
 * (command or fact) → step → execute effects in order. Driver effects run
 * synchronously, so pause/seek/stop/skip never wait for the network; async
 * work goes to the OperationRunner/ReceiptReporter, whose answers come back
 * as facts with the identities of the effect that asked for them.
 */
export function createPlaybackRuntime(options: PlaybackRuntimeOptions): PlaybackRuntime {
  return new Runtime(options);
}

class Runtime implements PlaybackRuntime {
  readonly instanceId: string;
  private state: PlaybackState;
  private readonly inbox: CoreInput[] = [];
  private draining = false;
  private disposedFlag = false;
  private disposing: Promise<void> | null = null;
  private readonly clockFn: RuntimeClock;
  private readonly ids: IdFactory;
  private readonly log: LogPort;
  private readonly store: SnapshotStore<PlaybackSnapshot>;
  private readonly operations: OperationRunner;
  private readonly receipts: ReceiptReporter;
  private readonly driver: PlaybackDriver;
  private lastSavedQueue = "";

  constructor(private readonly options: PlaybackRuntimeOptions) {
    this.instanceId = options.instanceId;
    this.clockFn = options.clock ?? performanceClock;
    this.ids = options.ids ?? createSequentialIds(options.instanceId);
    this.log = options.log ?? silentLog;
    this.driver = options.driver;
    this.state = createInitialState({ config: options.coreConfig, settings: options.initialSettings });
    this.store = new SnapshotStore(toSnapshot(this.state), (error) => this.warn("listener.error", error));
    const timers: Timers = options.timers ?? hostTimers;
    const emit = (fact: PlaybackFact) => this.accept({ kind: "fact", fact });
    this.operations = new OperationRunner({ emit, clock: this.clockFn, deadlines: options.deadlines, timers, log: this.log });
    this.receipts = new ReceiptReporter({ port: options.ports.receipts, emit, clock: this.clockFn, policy: options.receiptPolicy, timers, log: this.log });
    this.driver.connect((fact: MediaFact) => this.accept({ kind: "fact", fact }));
    const { musicVolume, voiceVolume, muted } = this.state.settings;
    this.executeDriver({ type: "output.volume", music: musicVolume, voice: voiceVolume, muted });
    this.restoreQueue();
  }

  readonly getSnapshot = (): PlaybackSnapshot => this.store.getSnapshot();
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  readonly clock: ClockReader = Object.freeze({ read: () => this.driver.readClock() });

  get spectrum(): SpectrumReader {
    return this.driver.spectrum;
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  dispatch(command: PlaybackCommand): DispatchResult {
    if (this.disposedFlag) return { accepted: false, reason: "disposed" };
    this.accept({ kind: "command", command });
    return { accepted: true, version: this.state.version };
  }

  unlockAudio(): void {
    if (!this.disposedFlag) this.driver.unlock();
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposedFlag = true;
    this.inbox.length = 0;
    this.operations.dispose();
    this.receipts.dispose();
    this.saveQueue();
    this.store.clear();
    this.disposing = this.driver.dispose().catch((error: unknown) => this.warn("driver.dispose-failed", error));
    return this.disposing;
  }

  /** Inspection hooks for tests and the debug bridge; not part of the UI surface. */
  get pendingWork(): { readonly operations: number; readonly receipts: number; readonly listeners: number } {
    return { operations: this.operations.activeCount, receipts: this.receipts.activeCount, listeners: this.store.listenerCount };
  }

  private accept(input: CoreInput): void {
    if (this.disposedFlag) {
      if (input.kind === "fact") this.debug("fact.after-dispose", input.fact);
      return;
    }
    this.inbox.push(input);
    if (this.draining) return;
    this.draining = true;
    const before = this.state;
    try {
      let next: CoreInput | undefined;
      while ((next = this.inbox.shift()) !== undefined && !this.disposedFlag) this.handle(next);
    } finally {
      this.draining = false;
    }
    if (this.state !== before && !this.disposedFlag) {
      this.store.publish(toSnapshot(this.state));
      this.saveQueue();
    }
  }

  private handle(input: CoreInput): void {
    const at = this.clockFn();
    this.log({ level: "debug", event: input.kind, at, data: input.kind === "command" ? input.command : input.fact });
    const result = step(this.state, input, { now: at, ids: this.ids });
    for (const note of result.notes) this.log({ level: note.kind === "decision" ? "info" : "debug", event: "note", at, data: note });
    this.state = result.state;
    for (const effect of result.effects) this.execute(effect, at);
  }

  private execute(effect: PlaybackEffect, at: number): void {
    this.log({ level: "debug", event: "effect", at, data: effect });
    if (isDriverEffect(effect)) return this.executeDriver(effect);
    const { ports } = this.options;
    switch (effect.type) {
      case "prepare.start": {
        const { opId, itemId, track, purpose, previousRevision } = effect;
        return this.operations.start<ResolvedMedia>({
          kind: "prepare",
          opId,
          run: (signal) => ports.prepare.resolve({ opId, itemId, track, purpose, previousRevision }, signal),
          completed: (media) => ({ type: "prepare.resolved", opId, itemId, media }),
          failed: (outcome, error) => ({ type: "prepare.settled", opId, itemId, outcome, error })
        });
      }
      case "cue.request": {
        const { opId, binding, from, to } = effect;
        return this.operations.start<CueAsset>({
          kind: "cue",
          opId,
          run: (signal) => ports.cue.request({ opId, binding, from, to }, signal),
          completed: (asset) => ({ type: "cue.ready", opId, cueId: binding.cueId, transitionId: binding.transitionId, asset }),
          failed: (outcome, error) => ({ type: "cue.settled", opId, cueId: binding.cueId, outcome, error })
        });
      }
      case "lyrics.request": {
        const { opId, itemId, track, recordingId, sourceRevision } = effect;
        return this.operations.start<LyricsAvailability>({
          kind: "lyrics",
          opId,
          run: (signal) => ports.lyrics.lookup({ opId, itemId, track, recordingId, sourceRevision }, signal),
          completed: (result) => ({ type: "lyrics.result", opId, itemId, sourceRevision, result }),
          failed: (outcome, error) => ({ type: "lyrics.settled", opId, itemId, outcome, error })
        });
      }
      case "operation.cancel":
        return this.operations.cancel(effect.opId);
      case "receipt.report":
        void this.receipts.report(effect.receipt);
        return;
    }
  }

  private executeDriver(effect: Parameters<PlaybackDriver["execute"]>[0]): void {
    try {
      this.driver.execute(effect);
    } catch (error) {
      // A driver bug must not wedge the serial loop; surface it as a media error for that identity.
      this.warn("driver.execute-failed", { effect: effect.type, error: String(error) });
      const info = { class: "unavailable" as const, code: "driver_failed", message: String(error).slice(0, 500) };
      if (effect.type.startsWith("deck.") && "loadId" in effect) {
        this.accept({ kind: "fact", fact: { type: "deck.media", deck: effect.deck, loadId: effect.loadId, event: { kind: "error", error: info } } });
      } else if (effect.type.startsWith("voice.") && "voiceLoadId" in effect) {
        this.accept({ kind: "fact", fact: { type: "voice.media", cueId: effect.cueId, voiceLoadId: effect.voiceLoadId, event: { kind: "error", error: info } } });
      }
    }
  }

  private restoreQueue(): void {
    const store = this.options.queueStore;
    if (!store) return;
    let entries: readonly QueueEntryRequest[] = [];
    try {
      entries = store.load();
    } catch (error) {
      this.warn("queue.restore-failed", error);
    }
    if (entries.length === 0) return;
    this.accept({
      kind: "command",
      command: { type: "enqueue", position: "end", entries: entries.map((entry) => ({ track: entry.track, display: entry.display, origin: "restore" as const })) }
    });
    this.log({ level: "info", event: "queue.restored", at: this.clockFn(), data: { count: entries.length } });
  }

  /** Persists the queue intent (current program first) whenever its item list changes. */
  private saveQueue(): void {
    const store = this.options.queueStore;
    if (!store) return;
    const snapshot = this.state;
    const items = [...(snapshot.program ? [snapshot.program.item] : []), ...snapshot.queue.map((entry) => entry.item)].filter(
      (item, index, all) => all.findIndex((other) => other.itemId === item.itemId) === index
    );
    const key = items.map((item) => item.itemId).join("|");
    if (key === this.lastSavedQueue) return;
    this.lastSavedQueue = key;
    try {
      store.save(items.map((item) => ({ track: item.track, display: item.display, origin: item.origin })));
    } catch (error) {
      this.warn("queue.save-failed", error);
    }
  }

  private warn(event: string, data: unknown): void {
    this.log({ level: "warn", event, at: this.clockFn(), data: data instanceof Error ? data.message : data });
  }

  private debug(event: string, data: unknown): void {
    this.log({ level: "debug", event, at: this.clockFn(), data });
  }
}
