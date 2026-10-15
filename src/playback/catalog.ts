import { decode, trackRefDecoder, type TrackDisplay, type TrackRef } from "@claudio/contracts";

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
export class CatalogIndex {
  static readonly EMPTY = new CatalogIndex([], 0);

  private readonly byLegacy = new Map<string, CatalogEntry>();
  private readonly byRef = new Map<string, CatalogEntry>();

  constructor(
    entries: readonly CatalogEntry[],
    /** Library rows that came without a ref (cannot be queued by this client). */
    readonly unlinkedRows: number
  ) {
    for (const entry of entries) this.put(entry);
  }

  static fromLibraryRows(rows: readonly unknown[]): CatalogIndex {
    const entries: CatalogEntry[] = [];
    let unlinked = 0;
    for (const raw of rows) {
      if (typeof raw !== "object" || raw === null) continue;
      const row = raw as LibraryRow;
      const ref = decodeRef(row.ref);
      if (!ref || typeof row.id !== "string") {
        unlinked += 1;
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
    return new CatalogIndex(entries, unlinked);
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
    const next = new CatalogIndex([...this.byRef.values()], this.unlinkedRows);
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
