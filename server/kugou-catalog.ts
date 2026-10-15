import crypto from "node:crypto";
import type { CatalogSearchPort } from "./catalog.js";
import { searchKuGouSong, type KuGouSong } from "./kugou.js";
import type { TrackRecord } from "./types.js";

export type KuGouRawSearch = (query: string, limit?: number) => Promise<KuGouSong[]>;

function songKey(song: KuGouSong) {
  return song.hash || song.sourceId || `${song.artist ?? ""}\n${song.title}`.toLowerCase();
}

function trackId(song: KuGouSong) {
  return `kg-${crypto.createHash("sha1").update(songKey(song)).digest("hex").slice(0, 16)}`;
}

export function toKuGouApiTrack(song: KuGouSong): TrackRecord {
  return {
    id: trackId(song),
    title: song.title,
    artist: song.artist || "Unknown Artist",
    album: song.album || "KuGou",
    filePath: `kugou://${encodeURIComponent(songKey(song))}`,
    folder: "KuGou API",
    extension: "remote",
    source: "kugou-api",
    playable: true,
    size: 0,
    addedAt: new Date().toISOString()
  };
}

export function createKuGouCatalogSearchPort(rawSearch: KuGouRawSearch = searchKuGouSong): CatalogSearchPort {
  return {
    async search(query, limit) {
      const songs = await rawSearch(query, limit);
      return songs.map(toKuGouApiTrack);
    }
  };
}

export const kuGouCatalogSearchPort = createKuGouCatalogSearchPort();
