import type { ResolvedMedia } from "../media.js";
import { mediaCapabilitiesDecoder, recordingIdentityDecoder } from "../media.js";
import type { StreamHandle, SourceRevision } from "../ids.js";
import { trackRefDecoder } from "../catalog.js";
import type { VoiceAsset, VoiceAssetWire } from "../narration.js";
import { errorInfoDecoder, type ErrorInfo } from "../operation.js";
import { durationInfoDecoder } from "../timing.js";
import type { AssetId } from "../ids.js";
import { id, isoTimestamp, literal, nullable, number, object, parseIsoTimestamp, type Decoder } from "../validation.js";

export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const protocolVersionDecoder: Decoder<ProtocolVersion> = literal(PROTOCOL_VERSION);

/** Error body for every v1 endpoint. HTTP status mirrors `error.class`. */
export interface ApiErrorV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly error: ErrorInfo;
}

export const apiErrorV1Decoder: Decoder<ApiErrorV1> = object<ApiErrorV1>({
  protocolVersion: protocolVersionDecoder,
  error: errorInfoDecoder
});

/** Wire form of ResolvedMedia: expiry is an ISO timestamp. */
export interface ResolvedMediaWire extends Omit<ResolvedMedia, "stream"> {
  readonly stream: { readonly handle: StreamHandle; readonly expiresAt: string | null };
}

export const resolvedMediaWireDecoder: Decoder<ResolvedMediaWire> = object<ResolvedMediaWire>({
  track: trackRefDecoder,
  recording: recordingIdentityDecoder,
  sourceRevision: id<SourceRevision>(),
  stream: object<ResolvedMediaWire["stream"]>({
    handle: id<StreamHandle>(4096),
    expiresAt: nullable(isoTimestamp)
  }),
  duration: durationInfoDecoder,
  capabilities: mediaCapabilitiesDecoder
});

export const voiceAssetWireDecoder: Decoder<VoiceAssetWire> = object<VoiceAssetWire>({
  assetId: id<AssetId>(),
  scriptAssetId: id<AssetId>(),
  stream: object<VoiceAssetWire["stream"]>({
    handle: id<StreamHandle>(4096),
    expiresAt: nullable(isoTimestamp)
  }),
  duration: durationInfoDecoder,
  playbackRate: number({ min: 0.25, max: 4 })
});

/**
 * Wire ISO → runtime clock ms (epoch-aligned by convention). `null` means "no
 * expiry" and is only returned for `null`; an invalid timestamp throws instead
 * of silently becoming unbounded. Decoded values never throw.
 */
export function wireTimeToClock(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = parseIsoTimestamp(iso);
  if (ms === null) throw new RangeError("invalid ISO-8601 timestamp; decode wire values before converting");
  return ms;
}

export function resolvedMediaFromWire(wire: ResolvedMediaWire): ResolvedMedia {
  return { ...wire, stream: { handle: wire.stream.handle, expiresAt: wireTimeToClock(wire.stream.expiresAt) } };
}

export function voiceAssetFromWire(wire: VoiceAssetWire): VoiceAsset {
  return { ...wire, stream: { handle: wire.stream.handle, expiresAt: wireTimeToClock(wire.stream.expiresAt) } };
}
