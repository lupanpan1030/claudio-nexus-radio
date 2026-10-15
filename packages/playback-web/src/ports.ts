import type {
  CueAsset,
  CueBinding,
  ErrorInfo,
  LyricsAvailability,
  OperationId,
  PlaybackReceipt,
  PreparePurpose,
  QueueEntryRequest,
  QueueItemId,
  RecordingId,
  ResolvedMedia,
  SourceRevision,
  StreamHandle,
  TrackRef
} from "@claudio/contracts";

/**
 * Narrow capabilities the runtime needs from the outside world. Each port is
 * injected by the application (HTTP adapters, fixtures, a second provider...)
 * so the runtime and the core never learn which vendor answered.
 *
 * Async ports receive an AbortSignal. Aborting is best effort: the runtime
 * has already settled the operation and will drop any late answer by identity.
 */

export interface PrepareRequest {
  readonly opId: OperationId;
  readonly itemId: QueueItemId;
  readonly track: TrackRef;
  readonly purpose: PreparePurpose;
  readonly previousRevision: SourceRevision | null;
}

export interface PreparePort {
  resolve(request: PrepareRequest, signal: AbortSignal): Promise<ResolvedMedia>;
}

export interface CueRequest {
  readonly opId: OperationId;
  readonly binding: CueBinding;
  readonly from: TrackRef;
  readonly to: TrackRef;
}

export interface CuePort {
  request(request: CueRequest, signal: AbortSignal): Promise<CueAsset>;
}

export interface LyricsRequest {
  readonly opId: OperationId;
  readonly itemId: QueueItemId;
  readonly track: TrackRef;
  readonly recordingId: RecordingId;
  readonly sourceRevision: SourceRevision;
}

export interface LyricsPort {
  lookup(request: LyricsRequest, signal: AbortSignal): Promise<LyricsAvailability>;
}

/** History sink for started receipts. Must be idempotent by `receipt.idempotencyKey`. */
export interface ReceiptPort {
  report(receipt: PlaybackReceipt, signal: AbortSignal): Promise<"recorded" | "duplicate">;
}

/** Where the media element should load an opaque stream handle from. */
export interface MediaSourceSpec {
  readonly url: string;
  /** Needed for cross-origin streams routed through Web Audio; null = same origin. */
  readonly crossOrigin: "anonymous" | "use-credentials" | null;
}

export interface StreamUrlPort {
  music(handle: StreamHandle): MediaSourceSpec;
  voice(handle: StreamHandle): MediaSourceSpec;
}

/**
 * Persistence of the queue intent across reloads. Only the single executor
 * writes. Restored entries come back as a stopped queue (nothing plays and
 * no old narration is replayed until the user resumes).
 */
export interface QueueStore {
  load(): readonly QueueEntryRequest[];
  save(entries: readonly QueueEntryRequest[]): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly level: LogLevel;
  /** Stable event name, e.g. "command", "fact", "effect", "note", "operation.late". */
  readonly event: string;
  /** Runtime clock ms. */
  readonly at: number;
  readonly data?: unknown;
}

export type LogPort = (entry: LogEntry) => void;

export const silentLog: LogPort = () => {};

/** Timer seam so tests can drive deadlines deterministically. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const hostTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** Monotonic, epoch-aligned runtime clock (see contracts `RuntimeClockMs`). */
export type RuntimeClock = () => number;

export const performanceClock: RuntimeClock = () => performance.timeOrigin + performance.now();

/**
 * A port failure with a classification the core understands. Anything else a
 * port throws is reported as `retryable/port_failed`.
 */
export class PortError extends Error {
  constructor(readonly info: ErrorInfo) {
    super(info.message ?? info.code);
    this.name = "PortError";
  }
}

export function errorInfoOf(error: unknown, fallbackCode: string): ErrorInfo {
  if (error instanceof PortError) return error.info;
  const message = error instanceof Error ? error.message : String(error);
  return { class: "retryable", code: fallbackCode, message: message.slice(0, 1000) };
}
