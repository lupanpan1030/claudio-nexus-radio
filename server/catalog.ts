import type { TrackRecord } from "./types.js";

/**
 * Application-facing catalog search boundary.
 *
 * This deliberately hides provider response shapes. TrackRecord is still a
 * transitional canonical record until playback locators and provider identity
 * are separated from persistence in a later slice.
 */
export interface CatalogSearchPort {
  search(query: string, limit?: number): Promise<readonly TrackRecord[]>;
}
