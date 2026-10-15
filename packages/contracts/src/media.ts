import type { RecordingId, SourceRevision, StreamHandle } from "./ids.js";
import type { TrackRef } from "./catalog.js";
import type { DurationInfo } from "./timing.js";
import { boolean, id, literal, object, type Decoder } from "./validation.js";

/**
 * How strongly the resolver can vouch that this recording is the one the
 * catalog entry meant. "unverified" recordings still play but never inherit
 * lyrics/cues from another revision.
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
 * Result of resolving a TrackRef for playback. A refreshed signed URL keeps
 * the sourceRevision; a different (or unprovable) recording must get a new
 * sourceRevision, which invalidates lyrics and narration cues bound to it.
 */
export interface ResolvedMedia {
  readonly track: TrackRef;
  readonly recording: RecordingIdentity;
  readonly sourceRevision: SourceRevision;
  readonly stream: {
    readonly handle: StreamHandle;
    /**
     * Runtime-clock deadline (epoch-aligned ms, see playback/clock.ts) after which
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
 * the playback position. Anything else is a different source.
 */
export function isSameSource(a: ResolvedMedia, b: ResolvedMedia): boolean {
  return (
    a.sourceRevision === b.sourceRevision &&
    a.recording.recordingId === b.recording.recordingId &&
    b.recording.confidence !== "unverified"
  );
}

export const recordingIdentityDecoder: Decoder<RecordingIdentity> = object<RecordingIdentity>({
  recordingId: id<RecordingId>(),
  confidence: literal("provider-asserted", "content-hash", "unverified")
});

export const mediaCapabilitiesDecoder: Decoder<MediaCapabilities> = object<MediaCapabilities>({
  seekable: boolean,
  rangeRequests: boolean
});
