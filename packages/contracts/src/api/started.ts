import { trackRefDecoder, type TrackRef } from "../catalog.js";
import type {
  ExecutorInstanceId,
  IdempotencyKey,
  LoadId,
  QueueItemId,
  RecordingId,
  SourceRevision
} from "../ids.js";
import type { PlaybackReceipt } from "../playback/effects.js";
import { id, isoTimestamp, literal, number, object, type Decoder } from "../validation.js";
import { protocolVersionDecoder, PROTOCOL_VERSION, type ProtocolVersion } from "./common.js";

/**
 * "This queue item became program output and its media confirmed playing."
 * Sent at most once per item by the core; the server dedupes by
 * idempotencyKey. Preheat/standby never sends this. Volume 0 is still a play.
 */
export interface StartedRequestV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly idempotencyKey: IdempotencyKey;
  readonly executorInstanceId: ExecutorInstanceId;
  readonly itemId: QueueItemId;
  readonly track: TrackRef;
  readonly recordingId: RecordingId;
  readonly sourceRevision: SourceRevision;
  readonly loadId: LoadId;
  readonly positionMs: number;
  readonly startedAt: string;
}

export interface StartedResponseV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly idempotencyKey: IdempotencyKey;
  readonly status: "recorded" | "duplicate";
}

export const startedRequestV1Decoder: Decoder<StartedRequestV1> = object<StartedRequestV1>({
  protocolVersion: protocolVersionDecoder,
  idempotencyKey: id<IdempotencyKey>(),
  executorInstanceId: id<ExecutorInstanceId>(),
  itemId: id<QueueItemId>(),
  track: trackRefDecoder,
  recordingId: id<RecordingId>(),
  sourceRevision: id<SourceRevision>(),
  loadId: id<LoadId>(),
  positionMs: number({ min: 0 }),
  startedAt: isoTimestamp
});

export const startedResponseV1Decoder: Decoder<StartedResponseV1> = object<StartedResponseV1>({
  protocolVersion: protocolVersionDecoder,
  idempotencyKey: id<IdempotencyKey>(),
  status: literal("recorded", "duplicate")
});

/** Builds the wire request from a core receipt; wall time comes from the runtime. */
export function startedRequestFromReceipt(
  receipt: PlaybackReceipt,
  executorInstanceId: ExecutorInstanceId,
  startedAtIso: string
): StartedRequestV1 {
  return {
    protocolVersion: PROTOCOL_VERSION,
    idempotencyKey: receipt.idempotencyKey,
    executorInstanceId,
    itemId: receipt.itemId,
    track: receipt.track,
    recordingId: receipt.recordingId,
    sourceRevision: receipt.sourceRevision,
    loadId: receipt.loadId,
    positionMs: Math.max(0, receipt.positionMs),
    startedAt: startedAtIso
  };
}
