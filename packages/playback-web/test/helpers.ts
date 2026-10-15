import {
  asId,
  type CueAsset,
  type LyricsAvailability,
  type MediaEvent,
  type PlaybackReceipt,
  type QueueEntryRequest,
  type ResolvedMedia,
  type TrackRef
} from "@claudio/contracts";
import type { CoreConfig } from "@claudio/playback-core";
import {
  createPlaybackRuntime,
  type CuePort,
  type CueRequest,
  type LogEntry,
  type LyricsPort,
  type LyricsRequest,
  type PausedObservation,
  type PlaybackRuntime,
  type PreparePort,
  type PrepareRequest,
  type QueueStore,
  type ReceiptPort,
  type RuntimePorts,
  type Timers
} from "../src/index.js";
import { FakeDriver } from "../src/testing/index.js";

/** Deterministic timers: nothing fires until `advance`. */
export class ManualTimers implements Timers {
  now = 0;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { at: this.now + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Advance virtual time, firing due timers in order (including ones scheduled meanwhile). */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.pending) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.pending.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
    }
    this.now = target;
  }
}

export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export function track(name: string, providerId = "fixture"): TrackRef {
  return { providerId: asId(providerId), mediaId: asId(name) };
}

export function entry(name: string, providerId = "fixture"): QueueEntryRequest {
  return { track: track(name, providerId), display: { title: name, artist: "fixture" }, origin: "user" };
}

export function media(ref: TrackRef, options: { durationMs?: number | null; revision?: string } = {}): ResolvedMedia {
  const durationMs = options.durationMs === undefined ? 200_000 : options.durationMs;
  return {
    track: ref,
    recording: { recordingId: asId(`rec-${ref.providerId}-${ref.mediaId}`), confidence: "provider-asserted" },
    sourceRevision: asId(options.revision ?? `rev-${ref.mediaId}`),
    stream: { handle: asId(`${ref.providerId}/${ref.mediaId}`), expiresAt: null },
    duration: durationMs === null ? { kind: "unknown" } : { kind: "known", ms: durationMs, source: "provider-metadata" },
    capabilities: { seekable: true, rangeRequests: true }
  };
}

export function cueAsset(text = "接下来这首歌", voiceHandle = "voice/1"): CueAsset {
  return {
    script: { assetId: asId(`script-${voiceHandle}`), version: 1, text, subtitle: { timing: "plain-text", segments: [{ text }] } },
    voice: {
      assetId: asId(`voice-${voiceHandle}`),
      scriptAssetId: asId(`script-${voiceHandle}`),
      stream: { handle: asId(voiceHandle), expiresAt: null },
      duration: { kind: "unknown" },
      playbackRate: 1
    }
  };
}

interface Call<Req, Res> {
  readonly request: Req;
  readonly signal: AbortSignal;
  resolve(value: Res): void;
  reject(error: unknown): void;
}

/** A port whose every call stays pending until the test answers it (or never). */
export class ControlledPort<Req, Res> {
  readonly calls: Call<Req, Res>[] = [];
  /** When set, calls are answered immediately with this function. */
  auto: ((request: Req) => Res | Promise<Res>) | null = null;

  invoke(request: Req, signal: AbortSignal): Promise<Res> {
    if (this.auto) return Promise.resolve(this.auto(request));
    return new Promise<Res>((resolve, reject) => {
      this.calls.push({ request, signal, resolve, reject });
    });
  }

  last(predicate: (request: Req) => boolean = () => true): Call<Req, Res> {
    const found = this.calls.filter((call) => predicate(call.request)).at(-1);
    if (!found) throw new Error("no matching port call");
    return found;
  }
}

export class Ports {
  readonly prepare = new ControlledPort<PrepareRequest, ResolvedMedia>();
  readonly cue = new ControlledPort<CueRequest, CueAsset>();
  readonly lyrics = new ControlledPort<LyricsRequest, LyricsAvailability>();
  readonly receipts = new ControlledPort<PlaybackReceipt, "recorded" | "duplicate">();

  constructor() {
    this.lyrics.auto = () => ({ status: "missing", reason: "not-found" });
    this.receipts.auto = () => "recorded";
  }

  get bound(): { prepare: PreparePort; cue: CuePort; lyrics: LyricsPort; receipts: ReceiptPort } {
    return {
      prepare: { resolve: (request, signal) => this.prepare.invoke(request, signal) },
      cue: { request: (request, signal) => this.cue.invoke(request, signal) },
      lyrics: { lookup: (request, signal) => this.lyrics.invoke(request, signal) },
      receipts: { report: (receipt, signal) => this.receipts.invoke(receipt, signal) }
    };
  }
}

export interface Harness {
  readonly runtime: PlaybackRuntime;
  readonly driver: FakeDriver;
  readonly ports: Ports;
  readonly timers: ManualTimers;
  readonly log: LogEntry[];
  clockMs: number;
}

export function createHarness(
  options: {
    coreConfig?: Partial<CoreConfig>;
    djEnabled?: boolean;
    ports?: Ports;
    queueStore?: QueueStore;
    portsOverride?: Partial<RuntimePorts>;
    receiptPolicy?: { maxAttempts?: number; attemptTimeoutMs?: number; backoffMs?: number[] };
  } = {}
): Harness {
  const ports = options.ports ?? new Ports();
  const timers = new ManualTimers();
  const log: LogEntry[] = [];
  const harness = { ports, timers, log, clockMs: 1_000_000 } as Harness & { clockMs: number };
  const clock = () => harness.clockMs + timers.now;
  const driver = new FakeDriver(clock);
  const runtime = createPlaybackRuntime({
    driver,
    instanceId: "test",
    ports: { ...ports.bound, ...options.portsOverride },
    clock,
    timers,
    log: (entry) => log.push(entry),
    coreConfig: options.coreConfig,
    initialSettings: { djEnabled: options.djEnabled ?? false },
    queueStore: options.queueStore,
    receiptPolicy: options.receiptPolicy,
    deadlines: { prepare: 5_000, cue: 8_000, lyrics: 4_000 }
  });
  return Object.assign(harness, { runtime, driver });
}

/** Resolve the latest prepare call for a media id with fixture media. */
export async function resolvePrepare(h: Harness, mediaId: string, options: Parameters<typeof media>[1] = {}): Promise<void> {
  const call = h.ports.prepare.last((request) => request.track.mediaId === mediaId);
  call.resolve(media(call.request.track, options));
  await flush();
}

/** Bring the program deck of `mediaId` to playing on the fake driver. */
export function confirmPlaying(h: Harness, deck: "A" | "B", positionMs = 0): void {
  h.driver.deckEvent(deck, { kind: "can-play", through: true });
  h.driver.deckEvent(deck, { kind: "playing", positionMs });
}

/** A `paused` observation as the browser driver reports it (atEnd/requested), valid before and after the contract gains the fields. */
export function paused(positionMs: number, options: { atEnd?: boolean; requested?: boolean } = {}): MediaEvent {
  const observation: PausedObservation = { kind: "paused", positionMs, atEnd: options.atEnd ?? false, requested: options.requested ?? false };
  return observation;
}

export function memoryStorage(): { getItem(key: string): string | null; setItem(key: string, value: string): void; data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}
