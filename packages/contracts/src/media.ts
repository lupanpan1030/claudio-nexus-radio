import type { RecordingId, SourceRevision, StreamHandle } from "./ids.js";
import type { TrackRef } from "./catalog.js";
import type { DurationInfo } from "./timing.js";
import { boolean, id, literal, object, type Decoder } from "./validation.js";

/**
 * How strongly the resolver can vouch that the recording it actually resolved
 * is the one the catalog entry meant. It says nothing about continuity between
 * two resolutions: that is what `sourceRevision` carries. "unverified" media
 * plays normally; a refreshed URL of the same recording under the same
 * revision is still the same source.
 */
export type RecordingConfidence = "provider-asserted" | "content-hash" | "unverified";

export interface RecordingIdentity {
  readonly recordingId: RecordingId;
  readonly confidence: RecordingConfidence;
}

/** What this particular resolved source can do. Absent capability = not supported. */
export interface MediaCapabilities {
  readonly seekable: boolean;
  readonly rangeRequests: boolean;
}

/**
 * Result of resolving a TrackRef for playback. A refreshed signed URL of the
 * same recording keeps the sourceRevision. When the resolved recording changed
 * or its continuity cannot be proven, the server must mint a new
 * sourceRevision (and never bind one revision to two recordings); the client
 * cannot inspect content and trusts recordingId + sourceRevision alone.
 */
export interface ResolvedMedia {
  readonly track: TrackRef;
  readonly recording: RecordingIdentity;
  readonly sourceRevision: SourceRevision;
  readonly stream: {
    readonly handle: StreamHandle;
    /**
     * Runtime-clock deadline (epoch-aligned ms, see RuntimeClockMs in playback/snapshot.ts) after which
     * the handle must not start a new load. Wire DTOs carry ISO strings instead.
     */
    readonly expiresAt: number | null;
  };
  readonly duration: DurationInfo;
  readonly capabilities: MediaCapabilities;
}

/** Media element readiness, mirroring HAVE_* levels without depending on the DOM. */
export type MediaReadiness = "none" | "metadata" | "can-play" | "can-play-through";

const READINESS_ORDER: readonly MediaReadiness[] = ["none", "metadata", "can-play", "can-play-through"];

export function readinessAtLeast(actual: MediaReadiness, required: MediaReadiness): boolean {
  return READINESS_ORDER.indexOf(actual) >= READINESS_ORDER.indexOf(required);
}

export function raiseReadiness(actual: MediaReadiness, observed: MediaReadiness): MediaReadiness {
  return readinessAtLeast(actual, observed) ? actual : observed;
}

/**
 * Same recording AND same revision: the new media may keep lyrics, cues and
 * the playback position. Anything else (another revision of the same
 * recording id, or another recording under the same revision) is a different
 * source. Confidence is deliberately not part of this: it describes the match
 * to the catalog, not continuity (see RecordingConfidence).
 */
export function isSameSource(a: ResolvedMedia, b: ResolvedMedia): boolean {
  return a.sourceRevision === b.sourceRevision && a.recording.recordingId === b.recording.recordingId;
}

export const recordingIdentityDecoder: Decoder<RecordingIdentity> = object<RecordingIdentity>({
  recordingId: id<RecordingId>(),
  confidence: literal("provider-asserted", "content-hash", "unverified")
});

export const mediaCapabilitiesDecoder: Decoder<MediaCapabilities> = object<MediaCapabilities>({
  seekable: boolean,
  rangeRequests: boolean
});
