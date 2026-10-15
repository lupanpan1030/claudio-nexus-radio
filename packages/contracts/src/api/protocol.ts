import { PROVIDER_ID_PATTERN, trackDisplayDecoder, trackRefDecoder, type TrackDisplay, type TrackRef } from "../catalog.js";
import type { PreparationId, ProviderId, QueueItemId, RecordingId, SourceRevision } from "../ids.js";
import { array, boolean, branded, id, isoTimestamp, literal, nullable, number, object, string, type Decoder } from "../validation.js";
import { protocolVersionDecoder, type ProtocolVersion } from "./common.js";
import { API_V1_EXTRA_PATHS, API_V1_PATHS, type ApiV1AnnouncedPathName } from "./paths.js";

/** Server-relative API path ("/api/..."), as announced by the handshake. */
const apiPath: Decoder<string> = string({ min: 5, max: 512, pattern: /^\/api\// });

/**
 * GET protocol. `playbackProtocol` says which playback protocol the server
 * runs; "legacy" closes every other /api/v1 route.
 */
export interface ProtocolHandshakeV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly playbackProtocol: "v1" | "legacy";
  readonly serverInstanceId: string;
  readonly paths: { readonly [K in ApiV1AnnouncedPathName]: string };
  readonly providers: readonly { readonly providerId: ProviderId; readonly lyrics: boolean }[];
}

const announcedPathNames = [...Object.keys(API_V1_PATHS), ...Object.keys(API_V1_EXTRA_PATHS)] as ApiV1AnnouncedPathName[];

export const protocolHandshakeV1Decoder: Decoder<ProtocolHandshakeV1> = object<ProtocolHandshakeV1>({
  protocolVersion: protocolVersionDecoder,
  playbackProtocol: literal("v1", "legacy"),
  serverInstanceId: string({ min: 1, max: 256 }),
  paths: object<ProtocolHandshakeV1["paths"]>(
    Object.fromEntries(announcedPathNames.map((name) => [name, apiPath])) as { readonly [K in ApiV1AnnouncedPathName]: Decoder<string> }
  ),
  providers: array(
    object<ProtocolHandshakeV1["providers"][number]>({
      providerId: branded<ProviderId>(string({ pattern: PROVIDER_ID_PATTERN })),
      lyrics: boolean
    }),
    { max: 64 }
  )
});

/** One confirmed started fact. `sourceVerified`: the revision matched a source this server resolved. */
export interface StartedHistoryEntryV1 {
  readonly itemId: QueueItemId;
  readonly track: TrackRef;
  readonly display: TrackDisplay | null;
  readonly recordingId: RecordingId;
  readonly sourceRevision: SourceRevision;
  readonly startedAt: string;
  readonly positionMs: number;
  readonly sourceVerified: boolean;
}

export interface StartedHistoryResponseV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly semantics: "confirmed-started";
  readonly started: readonly StartedHistoryEntryV1[];
}

export const startedHistoryResponseV1Decoder: Decoder<StartedHistoryResponseV1> = object<StartedHistoryResponseV1>({
  protocolVersion: protocolVersionDecoder,
  semantics: literal("confirmed-started"),
  started: array(
    object<StartedHistoryEntryV1>({
      itemId: id<QueueItemId>(),
      track: trackRefDecoder,
      display: nullable(trackDisplayDecoder),
      recordingId: id<RecordingId>(),
      sourceRevision: id<SourceRevision>(),
      startedAt: isoTimestamp,
      positionMs: number({ min: 0 }),
      sourceVerified: boolean
    }),
    { max: 1000 }
  )
});

/** One selection audit row. A candidate is not a play and never enters listening cooldown. */
export interface CandidateHistoryEntryV1 {
  readonly itemId: QueueItemId;
  readonly preparationId: PreparationId;
  readonly track: TrackRef;
  readonly display: TrackDisplay | null;
  readonly policy: string;
  readonly reason: string;
  readonly considered: readonly { readonly ref: TrackRef; readonly score: number }[];
  readonly createdAt: string;
}

export interface CandidateHistoryResponseV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly semantics: "candidate-selection";
  readonly candidates: readonly CandidateHistoryEntryV1[];
}

export const candidateHistoryResponseV1Decoder: Decoder<CandidateHistoryResponseV1> = object<CandidateHistoryResponseV1>({
  protocolVersion: protocolVersionDecoder,
  semantics: literal("candidate-selection"),
  candidates: array(
    object<CandidateHistoryEntryV1>({
      itemId: id<QueueItemId>(),
      preparationId: id<PreparationId>(),
      track: trackRefDecoder,
      display: nullable(trackDisplayDecoder),
      policy: string({ max: 200 }),
      reason: string({ max: 4000 }),
      considered: array(object<CandidateHistoryEntryV1["considered"][number]>({ ref: trackRefDecoder, score: number() }), { max: 1000 }),
      createdAt: isoTimestamp
    }),
    { max: 1000 }
  )
});

export interface CatalogSearchEntryV1 {
  readonly track: TrackRef;
  readonly display: TrackDisplay;
  readonly playable: boolean;
}

export interface CatalogSearchResponseV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly tracks: readonly CatalogSearchEntryV1[];
}

export const catalogSearchResponseV1Decoder: Decoder<CatalogSearchResponseV1> = object<CatalogSearchResponseV1>({
  protocolVersion: protocolVersionDecoder,
  tracks: array(object<CatalogSearchEntryV1>({ track: trackRefDecoder, display: trackDisplayDecoder, playable: boolean }), { max: 1000 })
});
