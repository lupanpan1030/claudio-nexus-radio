import type { DatabaseSync } from "node:sqlite";
import { asId, type MediaId, type ProviderId, type TrackRef } from "@claudio/contracts";
import type { CatalogEntry, CatalogPort } from "../../ports/catalog.js";

/** Adapter-private view of a legacy tracks row, including its locator. */
export interface TrackRow {
  readonly id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly filePath: string;
  readonly extension: string;
  readonly source: string;
  readonly playable: boolean;
}

export class TrackRowReader {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string, sources: readonly string[]): TrackRow | null {
    const row = this.db
      .prepare(`SELECT * FROM tracks WHERE id = ? AND source IN (${sources.map(() => "?").join(", ")})`)
      .get(id, ...sources) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  search(query: string, sources: readonly string[], limit: number): TrackRow[] {
    const like = `%${query.trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks WHERE source IN (${sources.map(() => "?").join(", ")})
         AND (? = '' OR title LIKE ? OR artist LIKE ? OR album LIKE ?)
         ORDER BY playable DESC, artist, title LIMIT ?`
      )
      .all(...sources, query.trim(), like, like, like, Math.max(1, Math.min(limit, 500))) as Record<string, unknown>[];
    return rows.map(toRow);
  }
}

function toRow(row: Record<string, unknown>): TrackRow {
  return {
    id: String(row.id),
    title: String(row.title),
    artist: String(row.artist),
    album: String(row.album),
    filePath: String(row.file_path),
    extension: String(row.extension),
    source: String(row.source ?? "main"),
    playable: Number(row.playable ?? 1) === 1
  };
}

/**
 * Catalog for the subset of legacy tracks owned by one provider. The legacy
 * tracks.id is the provider media id, so history foreign keys keep working.
 */
export class LegacyTrackCatalog implements CatalogPort {
  constructor(
    private readonly rows: TrackRowReader,
    private readonly providerId: ProviderId,
    private readonly sources: readonly string[]
  ) {}

  describe(ref: TrackRef): CatalogEntry | null {
    if (ref.providerId !== this.providerId) return null;
    const row = this.rows.get(ref.mediaId, this.sources);
    return row ? this.toEntry(row) : null;
  }

  search(query: string, limit: number): readonly CatalogEntry[] {
    return this.rows.search(query, this.sources, limit).map((row) => this.toEntry(row));
  }

  private toEntry(row: TrackRow): CatalogEntry {
    return {
      ref: { providerId: this.providerId, mediaId: asId<MediaId>(row.id) },
      display: { title: row.title, artist: row.artist, album: row.album },
      playable: row.playable,
      legacyTrackId: row.id
    };
  }
}
