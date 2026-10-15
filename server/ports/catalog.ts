import type { TrackDisplay, TrackRef } from "@claudio/contracts";

/**
 * What the application may know about a catalog entry. Persistence locators
 * (file paths, provider hashes, signed URLs) stay inside adapters.
 */
export interface CatalogEntry {
  readonly ref: TrackRef;
  readonly display: TrackDisplay;
  readonly playable: boolean;
  /** Row key in the legacy tracks table when the entry has one; server-side only. */
  readonly legacyTrackId: string | null;
}

export interface CatalogPort {
  describe(ref: TrackRef): CatalogEntry | null;
  search(query: string, limit: number): readonly CatalogEntry[];
}
