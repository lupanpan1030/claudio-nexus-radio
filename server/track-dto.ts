import type { LibraryResponse, TrackDto, TrackRecord } from "./types.js";

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

export function toLibraryResponse(tracks: readonly TrackRecord[], total: number): LibraryResponse {
  return {
    tracks: tracks.map(toTrackDto),
    total
  };
}
