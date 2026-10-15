import type { MediaId, ProviderId, QueueItemId } from "./ids.js";
import { branded, id, literal, nullable, number, object, optional, string, type Decoder } from "./validation.js";

/** Catalog media reference. Login instances/auth revisions stay server-side. */
export interface TrackRef {
  readonly providerId: ProviderId;
  readonly mediaId: MediaId;
}

/** Display-only metadata. Never used to prove recording identity. */
export interface TrackDisplay {
  readonly title: string;
  readonly artist: string;
  readonly album?: string;
}

export type QueueItemOrigin = "user" | "radio" | "chat" | "restore";

/** One appearance in the queue. The same TrackRef queued twice yields two items. */
export interface QueueItem {
  readonly itemId: QueueItemId;
  readonly track: TrackRef;
  readonly display: TrackDisplay | null;
  readonly origin: QueueItemOrigin;
  /** Monotonic clock value supplied by the runtime when the item was created. */
  readonly enqueuedAt: number;
}

export function sameTrack(a: TrackRef, b: TrackRef): boolean {
  return a.providerId === b.providerId && a.mediaId === b.mediaId;
}

/** Lowercase opaque key; deliberately not an enum of known providers. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const trackRefDecoder: Decoder<TrackRef> = object<TrackRef>({
  providerId: branded<ProviderId>(string({ pattern: PROVIDER_ID_PATTERN })),
  mediaId: id<MediaId>(512)
});

export const trackDisplayDecoder: Decoder<TrackDisplay> = object<TrackDisplay>({
  title: string({ max: 500 }),
  artist: string({ max: 500 }),
  album: optional(string({ max: 500 }))
});

export const queueItemDecoder: Decoder<QueueItem> = object<QueueItem>({
  itemId: id<QueueItemId>(),
  track: trackRefDecoder,
  display: nullable(trackDisplayDecoder),
  origin: literal("user", "radio", "chat", "restore"),
  enqueuedAt: number({ min: 0 })
});
