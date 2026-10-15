import { isRecord, type QueueEntryRequest } from "@claudio/contracts";
import { createStorageQueueStore, type KeyValueStorage, type QueueStore } from "@claudio/playback-web";
import { decodeRef } from "./catalog";

export const QUEUE_KEY = "claudio.playback.queue.v1";
export const LEGACY_PLAYLIST_KEY = "claudio.activePlaylist";
export const LEGACY_QUEUE_KEY = "claudio.radioQueue";
export const LEGACY_BACKUP_KEY = "claudio.legacy.backup.v1";
export const LEGACY_IMPORT_MARK_KEY = "claudio.legacy.import.v1";

export interface SafeStorage extends KeyValueStorage {
  /** False after the first failure (quota, private mode, disabled storage). */
  readonly healthy: boolean;
}

/**
 * Storage that never throws into playback: a broken or full storage reads as
 * empty and drops writes. Music never depends on persistence succeeding.
 */
export function safeStorage(resolve: () => KeyValueStorage | null, onError: (error: unknown) => void = () => {}): SafeStorage {
  let healthy = true;
  const guard = <T>(run: (storage: KeyValueStorage) => T, fallback: T): T => {
    try {
      const storage = resolve();
      return storage ? run(storage) : fallback;
    } catch (error) {
      healthy = false;
      onError(error);
      return fallback;
    }
  };
  return {
    get healthy() {
      return healthy;
    },
    getItem: (key) => guard((storage) => storage.getItem(key), null),
    setItem: (key, value) => guard((storage) => storage.setItem(key, value), undefined)
  };
}

export function createQueueStore(storage: KeyValueStorage): QueueStore {
  return createStorageQueueStore(storage, QUEUE_KEY);
}

export type LegacyImportResult =
  | { readonly status: "not-needed"; readonly reason: "new-queue-exists" | "already-imported" | "no-legacy-data" }
  | { readonly status: "imported"; readonly imported: number; readonly skipped: readonly string[] }
  | { readonly status: "failed"; readonly reason: string };

/** Resolves an old queue song id to a queue entry via server-stated catalog data; null = unknown, skipped. */
export type LegacyLookup = (songId: string) => Pick<QueueEntryRequest, "track" | "display"> | null;

/**
 * One-time import of the old app's queue into the new versioned store. Runs
 * before the runtime restores. Never touches the old keys: their raw strings
 * are copied to a backup key first, then a mark records the import so it is
 * not repeated. Unknown songs are skipped and reported, never guessed.
 */
export function importLegacyQueue(storage: KeyValueStorage, store: QueueStore, lookup: LegacyLookup, nowIso: () => string): LegacyImportResult {
  if (storage.getItem(QUEUE_KEY) !== null) return { status: "not-needed", reason: "new-queue-exists" };
  if (storage.getItem(LEGACY_IMPORT_MARK_KEY) !== null) return { status: "not-needed", reason: "already-imported" };
  const rawQueue = storage.getItem(LEGACY_QUEUE_KEY);
  const rawPlaylist = storage.getItem(LEGACY_PLAYLIST_KEY);
  if (rawQueue === null && rawPlaylist === null) return { status: "not-needed", reason: "no-legacy-data" };

  if (storage.getItem(LEGACY_BACKUP_KEY) === null) {
    storage.setItem(LEGACY_BACKUP_KEY, JSON.stringify({ version: 1, savedAt: nowIso(), keys: { [LEGACY_PLAYLIST_KEY]: rawPlaylist, [LEGACY_QUEUE_KEY]: rawQueue } }));
    if (storage.getItem(LEGACY_BACKUP_KEY) === null) return { status: "failed", reason: "backup-not-written" };
  }

  let picks: unknown = [];
  try {
    picks = rawQueue === null ? [] : JSON.parse(rawQueue);
  } catch {
    picks = null;
  }
  const entries: QueueEntryRequest[] = [];
  const skipped: string[] = [];
  if (Array.isArray(picks)) {
    for (const pick of picks) {
      if (!isRecord(pick) || typeof pick.songId !== "string") {
        skipped.push(String(isRecord(pick) ? pick.songId : pick));
        continue;
      }
      const stated = decodeRef(pick.track);
      const known = lookup(pick.songId);
      const track = stated ?? known?.track ?? null;
      if (!track) {
        skipped.push(pick.songId);
        continue;
      }
      entries.push({ track, display: known?.display ?? null, origin: "restore" });
    }
  } else {
    skipped.push("(unreadable legacy queue)");
  }
  if (entries.length > 0) store.save(entries);
  storage.setItem(LEGACY_IMPORT_MARK_KEY, JSON.stringify({ version: 1, importedAt: nowIso(), imported: entries.length, skipped }));
  return { status: "imported", imported: entries.length, skipped };
}

/** Versioned UI settings; unknown or broken data falls back to defaults. */
export interface AppSettings {
  readonly theme: "dark" | "light";
  readonly stageEnabled: boolean;
  readonly musicVolume: number;
  readonly djEnabled: boolean;
}

export const SETTINGS_KEY = "claudio.settings.v1";
export const DEFAULT_SETTINGS: AppSettings = Object.freeze({ theme: "dark", stageEnabled: false, musicVolume: 0.5, djEnabled: true });

export function readSettings(storage: KeyValueStorage): AppSettings {
  const raw = storage.getItem(SETTINGS_KEY);
  if (raw === null) return DEFAULT_SETTINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (!isRecord(parsed) || parsed.version !== 1) return DEFAULT_SETTINGS;
  const volume = typeof parsed.musicVolume === "number" && parsed.musicVolume >= 0 && parsed.musicVolume <= 1 ? parsed.musicVolume : DEFAULT_SETTINGS.musicVolume;
  return {
    theme: parsed.theme === "light" ? "light" : "dark",
    stageEnabled: parsed.stageEnabled === true,
    musicVolume: volume,
    djEnabled: parsed.djEnabled !== false
  };
}

export function writeSettings(storage: KeyValueStorage, settings: AppSettings): void {
  storage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, ...settings }));
}

