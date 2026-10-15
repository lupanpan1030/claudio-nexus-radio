import { decode, trackRefDecoder, type TrackDisplay, type TrackRef } from "@claudio/contracts";
import type { LegacyLookupResult } from "./persistence";

/** What the UI may know about one catalog track. `legacyId` is the old library row key the legacy APIs (taste) still use. */
export interface CatalogEntry {
  readonly ref: TrackRef;
  readonly display: TrackDisplay;
  readonly legacyId: string | null;
  readonly playable: boolean;
}

export function refKey(ref: TrackRef): string {
  return `${ref.providerId}\u0000${ref.mediaId}`;
}

/** Decodes an optional TrackRef carried next to legacy DTOs; anything else is "unknown", never guessed. */
export function decodeRef(value: unknown): TrackRef | null {
  const result = decode(trackRefDecoder, value);
  return result.ok ? result.value : null;
}

interface LibraryRow {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly artist?: unknown;
  readonly album?: unknown;
  readonly playable?: unknown;
  readonly ref?: unknown;
}

/**
 * Join of the legacy library rows and their TrackRefs. A row is only linked
 * to a ref the server stated (DTO `ref`, chat pick `track`); a legacy song id
 * is never reinterpreted as a provider id or media id.
 */
/** What the library said about rows it could not link, by legacy id. */
export interface CatalogGaps {
  /** Rows the server listed with `ref: null`: no provider serves them. */
  readonly noProvider: ReadonlySet<string>;
  /** Rows without a usable `ref` field (older server, malformed): mapping not stated. */
  readonly unmapped: ReadonlySet<string>;
  /** False when the list may be cut short (total larger than the rows returned, or unknown). */
  readonly complete: boolean;
}

const NO_GAPS: CatalogGaps = Object.freeze({ noProvider: new Set<string>(), unmapped: new Set<string>(), complete: false });

export class CatalogIndex {
  static readonly EMPTY = new CatalogIndex([], 0);

  private readonly byLegacy = new Map<string, CatalogEntry>();
  private readonly byRef = new Map<string, CatalogEntry>();

  constructor(
    entries: readonly CatalogEntry[],
    /** Library rows that came without a ref (cannot be queued by this client). */
    readonly unlinkedRows: number,
    readonly gaps: CatalogGaps = NO_GAPS
  ) {
    for (const entry of entries) this.put(entry);
  }

  /** `total` is the library's own count; rows beyond the page are unknown, not gone. */
  static fromLibraryRows(rows: readonly unknown[], total: number | null = null): CatalogIndex {
    const entries: CatalogEntry[] = [];
    const noProvider = new Set<string>();
    const unmapped = new Set<string>();
    let unlinked = 0;
    for (const raw of rows) {
      if (typeof raw !== "object" || raw === null) continue;
      const row = raw as LibraryRow;
      const ref = decodeRef(row.ref);
      if (!ref || typeof row.id !== "string") {
        unlinked += 1;
        if (typeof row.id === "string") (Object.prototype.hasOwnProperty.call(row, "ref") && row.ref === null ? noProvider : unmapped).add(row.id);
        continue;
      }
      entries.push({
        ref,
        legacyId: row.id,
        playable: row.playable !== false,
        display: {
          title: typeof row.title === "string" ? row.title : "",
          artist: typeof row.artist === "string" ? row.artist : "",
          ...(typeof row.album === "string" && row.album ? { album: row.album } : {})
        }
      });
    }
    const complete = total !== null && Number.isSafeInteger(total) && total > 0 && rows.length >= total;
    return new CatalogIndex(entries, unlinked, { noProvider, unmapped, complete });
  }

  /**
   * Old queue song id → what the server stated about it. Absent from a
   * complete, non-empty list = gone; absent from a partial or empty list =
   * unmapped (ask again later), never guessed.
   */
  legacyLookup(songId: string): LegacyLookupResult {
    const entry = this.byLegacy.get(songId);
    if (entry) return { status: "found", entry: { track: entry.ref, display: entry.display } };
    if (this.gaps.noProvider.has(songId)) return { status: "gone" };
    if (this.gaps.unmapped.has(songId) || !this.gaps.complete) return { status: "unmapped" };
    return { status: "gone" };
  }

  get size(): number {
    return this.byRef.size;
  }

  byLegacyId(id: string): CatalogEntry | null {
    return this.byLegacy.get(id) ?? null;
  }

  byTrack(ref: TrackRef): CatalogEntry | null {
    return this.byRef.get(refKey(ref)) ?? null;
  }

  /** New index with server-stated (legacyId, ref) pairs added, e.g. from a chat reply. */
  withPairs(pairs: readonly { readonly legacyId: string; readonly ref: TrackRef }[]): CatalogIndex {
    const added = pairs.filter((pair) => !this.byLegacy.has(pair.legacyId));
    if (added.length === 0) return this;
    const next = new CatalogIndex([...this.byRef.values()], this.unlinkedRows, this.gaps);
    for (const pair of added) {
      const known = next.byRef.get(refKey(pair.ref));
      next.put({ ref: pair.ref, legacyId: pair.legacyId, playable: known?.playable ?? true, display: known?.display ?? { title: "", artist: "" } });
    }
    return next;
  }

  private put(entry: CatalogEntry): void {
    this.byRef.set(refKey(entry.ref), entry);
    if (entry.legacyId) this.byLegacy.set(entry.legacyId, entry);
  }
}
