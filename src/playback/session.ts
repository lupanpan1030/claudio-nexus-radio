import { asId, type ExecutorInstanceId, type PlaybackCommand, type PlaybackSnapshot } from "@claudio/contracts";
import { createSequentialIds, withReservations } from "@claudio/playback-core";
import {
  createBrowserDriver,
  createPlaybackHost,
  createPlaybackRuntime,
  type ClockReader,
  type DispatchResult,
  type LogEntry,
  type LogPort,
  type PlaybackHost,
  type PlaybackRuntime,
  type SpectrumReader
} from "@claudio/playback-web";
import type { CatalogIndex } from "./catalog";
import { pageClock } from "./clock";
import { PlaybackController, type OwnerServices } from "./controller";
import type { FetchLike } from "./http";
import { NowProjector } from "./now-projector";
import { createQueueStore, importLegacyQueue, writeSettings, type AppSettings, type LegacyImportResult, type SafeStorage } from "./persistence";
import { HttpCuePort, HttpLyricsPort, HttpReceiptPort, createStreamUrls } from "./ports";
import { HttpPreparePort, PreparationClient } from "./preparation";
import type { ProtocolPaths } from "./protocol";
import { RadioRefill } from "./radio-refill";
import { createStatusStore, type StatusStore } from "./status-store";

export const PLAYBACK_LOCK_NAME = "claudio.playback.v1";

export interface PlaybackSessionOptions {
  readonly fetchFn: FetchLike;
  readonly paths: ProtocolPaths;
  readonly origin: string;
  readonly storage: SafeStorage;
  readonly settings: () => AppSettings;
  /** Catalog used to map the old queue's song ids during the one-time import. */
  readonly loadCatalog: (signal: AbortSignal) => Promise<CatalogIndex>;
  readonly log?: LogPort;
}

export type OwnerStartup =
  | { readonly status: "none" }
  | { readonly status: "starting" }
  | { readonly status: "ready"; readonly legacyImport: LegacyImportResult }
  | { readonly status: "failed"; readonly message: string };

export interface PlaybackSession {
  readonly host: PlaybackHost;
  readonly controller: PlaybackController;
  /** Non-null only on the executor page. */
  readonly owner: StatusStore<OwnerServices | null>;
  readonly startup: StatusStore<OwnerStartup>;
  dispose(): Promise<void>;
}

/** Wraps the runtime so its companions (refill, now feed, settings) share its lifetime. */
class OwnedRuntime implements PlaybackRuntime {
  constructor(
    private readonly inner: PlaybackRuntime,
    private readonly companions: readonly (() => void)[]
  ) {}

  get instanceId(): string {
    return this.inner.instanceId;
  }
  get clock(): ClockReader {
    return this.inner.clock;
  }
  get spectrum(): SpectrumReader {
    return this.inner.spectrum;
  }
  get disposed(): boolean {
    return this.inner.disposed;
  }
  dispatch(command: PlaybackCommand): DispatchResult {
    return this.inner.dispatch(command);
  }
  getSnapshot(): PlaybackSnapshot {
    return this.inner.getSnapshot();
  }
  subscribe(listener: () => void): () => void {
    return this.inner.subscribe(listener);
  }
  unlockAudio(): void {
    this.inner.unlockAudio();
  }
  dispose(): Promise<void> {
    for (const stop of this.companions) {
      try {
        stop();
      } catch {
        // A companion failing to stop must not keep the media alive.
      }
    }
    return this.inner.dispose();
  }
}

function newInstanceId(): ExecutorInstanceId {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return asId<ExecutorInstanceId>(`web-${random}`);
}

/**
 * One playback session per page. The Web Lock decides the single executor;
 * only there are the AudioContext, HTTP ports, radio refill, now projection
 * and queue persistence created. Other pages observe broadcast snapshots and
 * make no playback requests.
 */
export function createPlaybackSession(options: PlaybackSessionOptions): PlaybackSession {
  const log: LogPort = options.log ?? (() => {});
  const owner = createStatusStore<OwnerServices | null>(null);
  const startup = createStatusStore<OwnerStartup>({ status: "none" });
  let controller: PlaybackController | null = null;
  const shutdown = new AbortController();

  const createRuntime = async (): Promise<PlaybackRuntime> => {
    startup.set({ status: "starting" });
    let driver: Awaited<ReturnType<typeof createBrowserDriver>> | null = null;
    try {
      const executorInstanceId = newInstanceId();
      const ids = withReservations(createSequentialIds(executorInstanceId));
      const queueStore = createQueueStore(options.storage);
      let legacyImport: LegacyImportResult = { status: "not-needed", reason: "no-legacy-data" };
      try {
        const catalog = await options.loadCatalog(shutdown.signal);
        legacyImport = importLegacyQueue(
          options.storage,
          queueStore,
          (songId) => {
            const entry = catalog.byLegacyId(songId);
            return entry ? { track: entry.ref, display: entry.display } : null;
          },
          () => new Date().toISOString()
        );
      } catch (error) {
        legacyImport = { status: "failed", reason: error instanceof Error ? error.message : String(error) };
      }
      log({ level: "info", event: "legacy.import", at: pageClock(), data: legacyImport });

      const client = new PreparationClient(options.fetchFn, options.paths);
      const prepare = new HttpPreparePort(client, { onCancelFailed: (id) => log({ level: "debug", event: "prepare.cancel-failed", at: pageClock(), data: id }) });
      driver = await createBrowserDriver({ urls: createStreamUrls(options.paths, options.origin), log, document: typeof document === "undefined" ? null : document });
      const settings = options.settings();
      const runtime = createPlaybackRuntime({
        driver,
        instanceId: executorInstanceId,
        ids,
        log,
        queueStore,
        initialSettings: { musicVolume: settings.musicVolume, djEnabled: settings.djEnabled },
        ports: {
          prepare,
          cue: new HttpCuePort(options.fetchFn, options.paths, prepare),
          lyrics: new HttpLyricsPort(options.fetchFn, options.paths),
          receipts: new HttpReceiptPort(options.fetchFn, options.paths, executorInstanceId)
        }
      });
      const refill = new RadioRefill({ target: runtime, client, port: prepare, ids, userActionSeq: () => controller?.getUserActionSeq() ?? 0, log, clock: pageClock });
      const generation = nextExecutorGeneration(options.storage);
      const now = new NowProjector({ source: runtime, fetchFn: options.fetchFn, path: options.paths.now, executorInstanceId, generation, clock: pageClock });
      let lastSettings = runtime.getSnapshot().settings;
      const stopSettings = runtime.subscribe(() => {
        const next = runtime.getSnapshot().settings;
        if (next.musicVolume === lastSettings.musicVolume && next.djEnabled === lastSettings.djEnabled) return;
        lastSettings = next;
        writeSettings(options.storage, { ...options.settings(), musicVolume: next.musicVolume, djEnabled: next.djEnabled });
      });
      refill.start();
      now.start();
      owner.set({ refill, ids });
      startup.set({ status: "ready", legacyImport });
      return new OwnedRuntime(runtime, [
        () => owner.set(null),
        () => refill.dispose(),
        () => now.dispose(),
        stopSettings,
        () => startup.set({ status: "none" })
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      startup.set({ status: "failed", message });
      await driver?.dispose().catch(() => {});
      log({ level: "error", event: "executor.start-failed", at: pageClock(), data: message });
      throw error;
    }
  };

  const host = createPlaybackHost({ name: PLAYBACK_LOCK_NAME, createRuntime, log, unsupportedPolicy: "run-unguarded", clock: pageClock });
  controller = new PlaybackController(host, () => owner.get());
  const stopObserving = host.subscribe(() => controller?.observe(host.getView().snapshot));

  return {
    host,
    controller,
    owner,
    startup,
    async dispose() {
      shutdown.abort();
      stopObserving();
      await host.dispose();
    }
  };
}

export const GENERATION_KEY = "claudio.executor.generation.v1";

/**
 * Same-origin executor generation: only the lock holder calls this, so a
 * read-increment-write cannot race another executor of this origin. An
 * unreadable value restarts from the current time (still increasing).
 */
export function nextExecutorGeneration(storage: SafeStorage): number {
  const stored = Number(storage.getItem(GENERATION_KEY));
  const next = Number.isSafeInteger(stored) && stored >= 0 ? stored + 1 : Date.now();
  storage.setItem(GENERATION_KEY, String(next));
  return next;
}

/** Bounded in-memory log for diagnostics; never persisted or sent anywhere. */
export function createRingLog(capacity = 400): { readonly log: LogPort; entries(): readonly LogEntry[] } {
  const buffer: LogEntry[] = [];
  return {
    log(entry) {
      if (entry.level === "debug") return;
      buffer.push(entry);
      if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
      if (entry.level === "error") console.error("[playback]", entry.event, entry.data);
    },
    entries: () => buffer.slice()
  };
}
