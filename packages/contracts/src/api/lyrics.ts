import { trackRefDecoder, type TrackRef } from "../catalog.js";
import type { QueueItemId, RecordingId, SourceRevision } from "../ids.js";
import { lyricsAvailabilityDecoder, lyricsResultMatches, type LyricsAvailability } from "../lyrics.js";
import { id, object, type Decoder } from "../validation.js";
import { protocolVersionDecoder, type ProtocolVersion } from "./common.js";

/** Lyrics are requested for an exact recording revision, not a title. */
export interface LyricsRequestV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly itemId: QueueItemId;
  readonly track: TrackRef;
  readonly recordingId: RecordingId;
  readonly sourceRevision: SourceRevision;
}

export interface LyricsResponseV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly itemId: QueueItemId;
  readonly sourceRevision: SourceRevision;
  readonly result: LyricsAvailability;
}

export const lyricsRequestV1Decoder: Decoder<LyricsRequestV1> = object<LyricsRequestV1>({
  protocolVersion: protocolVersionDecoder,
  itemId: id<QueueItemId>(),
  track: trackRefDecoder,
  recordingId: id<RecordingId>(),
  sourceRevision: id<SourceRevision>()
});

export const lyricsResponseV1Decoder: Decoder<LyricsResponseV1> = object<LyricsResponseV1>({
  protocolVersion: protocolVersionDecoder,
  itemId: id<QueueItemId>(),
  sourceRevision: id<SourceRevision>(),
  result: lyricsAvailabilityDecoder
});

/**
 * Lyrics may only be shown for the exact recording they were requested for:
 * the envelope must answer the requested revision, and an asset must carry
 * the requested recordingId and revision itself.
 */
export function lyricsMatchRecording(
  response: LyricsResponseV1,
  request: { readonly recordingId: RecordingId; readonly sourceRevision: SourceRevision }
): boolean {
  return response.sourceRevision === request.sourceRevision && lyricsResultMatches(response.result, request);
}
