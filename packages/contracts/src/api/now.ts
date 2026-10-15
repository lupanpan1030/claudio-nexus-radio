import { trackDisplayDecoder, trackRefDecoder, type TrackDisplay, type TrackRef } from "../catalog.js";
import type { ExecutorInstanceId, QueueItemId } from "../ids.js";
import { errorInfoDecoder, type ErrorInfo } from "../operation.js";
import type { TransportStatus } from "../playback/snapshot.js";
import { boolean, id, isoTimestamp, literal, nullable, number, object, refine, type Decoder } from "../validation.js";
import { protocolVersionDecoder, PROTOCOL_VERSION, type ProtocolVersion } from "./common.js";

/**
 * Low-frequency observation of the single executor.
 *
 * `generation` is a same-origin executor generation: the page that owns the
 * executor lock persists a monotonic counter (e.g. localStorage) and a new
 * executor instance takes the stored value + 1. It orders instances without
 * clocks; it does not arbitrate across devices or browser profiles.
 * `seq` orders projections within one executor instance.
 */
export interface NowProjectionV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly executorInstanceId: ExecutorInstanceId;
  readonly generation: number;
  readonly seq: number;
  readonly observedAt: string;
  readonly transport: TransportStatus;
  readonly item: { readonly itemId: QueueItemId; readonly track: TrackRef; readonly display: TrackDisplay | null } | null;
  readonly positionMs: number | null;
  readonly nextItemId: QueueItemId | null;
  readonly speaking: boolean;
}

const safeCounter = number({ min: 0, integer: true });

export const nowProjectionV1Decoder: Decoder<NowProjectionV1> = object<NowProjectionV1>({
  protocolVersion: protocolVersionDecoder,
  executorInstanceId: id<ExecutorInstanceId>(),
  generation: safeCounter,
  seq: safeCounter,
  observedAt: isoTimestamp,
  transport: literal("idle", "requested", "loading", "playing", "waiting", "paused", "blocked", "failed", "exhausted"),
  item: nullable(
    object<NonNullable<NowProjectionV1["item"]>>({
      itemId: id<QueueItemId>(),
      track: trackRefDecoder,
      display: nullable(trackDisplayDecoder)
    })
  ),
  positionMs: nullable(number({ min: 0 })),
  nextItemId: nullable(id<QueueItemId>()),
  speaking: boolean
});

/**
 * Ordering rule shared by server and executor:
 *  - a larger generation takes over (whatever its seq);
 *  - within the same generation only the same executor instance with a
 *    strictly larger seq is newer;
 *  - a smaller generation, or the same generation from another instance, is
 *    rejected (the server answers 409 with NowConflictV1).
 */
export function isNewerProjection(current: NowProjectionV1 | null, next: NowProjectionV1): boolean {
  if (current === null) return true;
  if (next.generation !== current.generation) return next.generation > current.generation;
  return next.executorInstanceId === current.executorInstanceId && next.seq > current.seq;
}

/** Why a projection was refused; tells the executor whether retrying with a higher generation makes sense. */
export type NowConflictReason =
  /** Same instance, seq not larger: a late duplicate; drop it. */
  | "stale_projection"
  /** Another instance holds this or a larger generation. */
  | "superseded_executor";

/**
 * 409 body for PUT now. It is an error, never a snapshot: callers must not
 * render it as the current projection. `current` names the accepted owner so
 * a page whose storage was cleared can adopt `current.generation + 1` once.
 */
export interface NowConflictV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly error: ErrorInfo;
  readonly reason: NowConflictReason;
  readonly current: {
    readonly executorInstanceId: ExecutorInstanceId;
    readonly generation: number;
    readonly seq: number;
  };
}

export const NOW_CONFLICT_HTTP_STATUS = 409 as const;

export const nowConflictV1Decoder: Decoder<NowConflictV1> = refine(
  object<NowConflictV1>({
    protocolVersion: protocolVersionDecoder,
    error: errorInfoDecoder,
    reason: literal("stale_projection", "superseded_executor"),
    current: object<NowConflictV1["current"]>({
      executorInstanceId: id<ExecutorInstanceId>(),
      generation: safeCounter,
      seq: safeCounter
    })
  }),
  (conflict, report) => {
    if (conflict.error.code !== conflict.reason) report(".error.code", "error.code must equal reason");
  }
);

/** Classifies a refused projection; null when `next` is in fact newer (no conflict). */
export function nowConflictFor(current: NowProjectionV1, next: NowProjectionV1): NowConflictV1 | null {
  if (isNewerProjection(current, next)) return null;
  const reason: NowConflictReason =
    next.generation === current.generation && next.executorInstanceId === current.executorInstanceId ? "stale_projection" : "superseded_executor";
  return {
    protocolVersion: PROTOCOL_VERSION,
    error: { class: "invalid", code: reason },
    reason,
    current: { executorInstanceId: current.executorInstanceId, generation: current.generation, seq: current.seq }
  };
}
