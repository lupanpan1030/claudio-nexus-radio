import { trackDisplayDecoder, trackRefDecoder, type TrackDisplay, type TrackRef } from "../catalog.js";
import type { ExecutorInstanceId, QueueItemId } from "../ids.js";
import type { TransportStatus } from "../playback/snapshot.js";
import { boolean, id, isoTimestamp, literal, nullable, number, object, type Decoder } from "../validation.js";
import { protocolVersionDecoder, type ProtocolVersion } from "./common.js";

/**
 * Low-frequency observation of the single executor. The server keeps the
 * highest `seq` per executor instance and rejects older projections.
 */
export interface NowProjectionV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly executorInstanceId: ExecutorInstanceId;
  readonly seq: number;
  readonly observedAt: string;
  readonly transport: TransportStatus;
  readonly item: { readonly itemId: QueueItemId; readonly track: TrackRef; readonly display: TrackDisplay | null } | null;
  readonly positionMs: number | null;
  readonly nextItemId: QueueItemId | null;
  readonly speaking: boolean;
}

export const nowProjectionV1Decoder: Decoder<NowProjectionV1> = object<NowProjectionV1>({
  protocolVersion: protocolVersionDecoder,
  executorInstanceId: id<ExecutorInstanceId>(),
  seq: number({ min: 0, integer: true }),
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

/** Accept only strictly newer projections from the same executor instance. */
export function isNewerProjection(current: NowProjectionV1 | null, next: NowProjectionV1): boolean {
  if (current === null || current.executorInstanceId !== next.executorInstanceId) return true;
  return next.seq > current.seq;
}
