/**
 * Opaque identities shared by the playback core, the browser runtime and the
 * server. Every identity is a branded string so a QueueItemId can never be
 * passed where a LoadId or a catalog MediaId is expected.
 */
declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

/** Opaque provider key chosen by server composition (never matched by name in core). */
export type ProviderId = Brand<string, "ProviderId">;
/** Provider-local media key. Only meaningful together with a ProviderId. */
export type MediaId = Brand<string, "MediaId">;
/** One appearance of a track in the queue; re-queuing the same track gets a new id. */
export type QueueItemId = Brand<string, "QueueItemId">;
/** One load of media into a deck (epoch). Facts with another LoadId are stale. */
export type LoadId = Brand<string, "LoadId">;
/** Identity of a planned hand-over between two queue items. */
export type TransitionId = Brand<string, "TransitionId">;
/** Identity of one narration cue (script + voice version) bound to a transition. */
export type CueId = Brand<string, "CueId">;
/** One load of a voice asset into the voice channel. */
export type VoiceLoadId = Brand<string, "VoiceLoadId">;
/** One asynchronous operation requested by the core (prepare, lyrics, cue...). */
export type OperationId = Brand<string, "OperationId">;
/** Recording identity confirmed by a resolver (not the catalog key). */
export type RecordingId = Brand<string, "RecordingId">;
/** Changes whenever the resolved recording changes or cannot be proven identical. */
export type SourceRevision = Brand<string, "SourceRevision">;
/** Opaque handle the executor turns into a stream; never a persisted locator. */
export type StreamHandle = Brand<string, "StreamHandle">;
/** Server-side preparation record identity. */
export type PreparationId = Brand<string, "PreparationId">;
/** Server-side immutable asset identity (script, voice, lyrics). */
export type AssetId = Brand<string, "AssetId">;
/** Identity of one running executor page/process. */
export type ExecutorInstanceId = Brand<string, "ExecutorInstanceId">;
/** Stable key making a started report idempotent. */
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

/** Unchecked cast for trusted producers (ID factories, fixtures). Boundaries use decoders. */
export function asId<T extends Brand<string, string>>(value: string): T {
  return value as T;
}
