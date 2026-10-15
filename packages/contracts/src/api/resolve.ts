import { trackRefDecoder, type TrackRef } from "../catalog.js";
import type { PreparationId, QueueItemId, SourceRevision } from "../ids.js";
import { id, literal, nullable, object, type Decoder } from "../validation.js";
import { protocolVersionDecoder, resolvedMediaWireDecoder, type ProtocolVersion, type ResolvedMediaWire } from "./common.js";

/**
 * Re-resolve a source (expired handle, retry). The server must not silently
 * return another recording under `previousRevision`; a different recording
 * gets a new sourceRevision.
 */
export interface ResolveRequestV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly itemId: QueueItemId;
  readonly track: TrackRef;
  readonly preparationId: PreparationId | null;
  readonly reason: "initial" | "refresh" | "retry";
  readonly previousRevision: SourceRevision | null;
}

export interface ResolveResponseV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly itemId: QueueItemId;
  readonly media: ResolvedMediaWire;
}

export const resolveRequestV1Decoder: Decoder<ResolveRequestV1> = object<ResolveRequestV1>({
  protocolVersion: protocolVersionDecoder,
  itemId: id<QueueItemId>(),
  track: trackRefDecoder,
  preparationId: nullable(id<PreparationId>()),
  reason: literal("initial", "refresh", "retry"),
  previousRevision: nullable(id<SourceRevision>())
});

export const resolveResponseV1Decoder: Decoder<ResolveResponseV1> = object<ResolveResponseV1>({
  protocolVersion: protocolVersionDecoder,
  itemId: id<QueueItemId>(),
  media: resolvedMediaWireDecoder
});
