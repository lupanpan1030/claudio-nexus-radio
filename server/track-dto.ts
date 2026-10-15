import type { TrackRef } from "@claudio/contracts";
import type { LibraryResponse, LibraryTrackDto, TrackDto, TrackRecord } from "./types.js";

/** Explicit allowlist: persistence locators and filesystem-derived folders stay server-side. */
export function toTrackDto(track: TrackRecord): TrackDto {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album,
    extension: track.extension,
    source: track.source,
    playable: track.playable
  };
}

/**
 * The composition's legacy row → TrackRef rule (provider chosen by
 * tracks.source); null when no provider serves the row. Injected so this DTO
 * layer names no provider and reads no locator.
 */
export type LegacyRefRule = (track: Pick<TrackRecord, "id" | "source">) => TrackRef | null;

/**
 * Library rows for clients. With a ref rule (v1) every row carries the
 * server-stated `ref` (null = not playable through any provider), so clients
 * never derive provider/media ids from legacy ids themselves.
 */
export function toLibraryResponse(tracks: readonly TrackRecord[], total: number, refFor?: LegacyRefRule): LibraryResponse {
  return {
    tracks: tracks.map((track): TrackDto | LibraryTrackDto => (refFor ? { ...toTrackDto(track), ref: refFor(track) } : toTrackDto(track))),
    total
  };
}
