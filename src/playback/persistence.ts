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
  | { readonly status: "not-needed"; readonly reason: "already-imported" | "no-legacy-data" }
  | { readonly status: "imported"; readonly imported: number; readonly skipped: readonly string[] }
  /**
   * Not imported this time, nothing marked: the server could not yet state a
   * TrackRef for some old songs (or the stored queue was unreadable). The old
   * keys and the backup stay; the next executor start tries again.
   */
  | { readonly status: "deferred"; readonly reason: "mapping-unavailable" | "queue-unreadable" | "storage-failed"; readonly pending: readonly string[] }
  | { readonly status: "failed"; readonly reason: string };

/**
 * What the server says about one old queue song id:
 * - found: a server-stated TrackRef;
 * - gone: the server lists it without any provider (`ref: null`) or no longer has it;
 * - unmapped: the server has not stated a mapping (older server, truncated list):
 *   asking again later may succeed, so it is never treated as gone.
 */
export type LegacyLookupResult =
  | { readonly status: "found"; readonly entry: Pick<QueueEntryRequest, "track" | "display"> }
  | { readonly status: "gone" }
  | { readonly status: "unmapped" };

export type LegacyLookup = (songId: string) => LegacyLookupResult;

/** Same bound the versioned queue store decodes; a longer list would not load at all. */
const MAX_STORED_QUEUE = 500;

interface ImportMark {
  readonly complete: boolean;
}

/**
 * A version 2 mark is final only with status "complete". A version 1 mark
 * that imported nothing but skipped songs came from a client that could not
 * map ids at all; it is not a finished import and is retried.
 */
function readMark(raw: string | null): ImportMark | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { complete: true };
  }
  if (!isRecord(parsed)) return { complete: true };
  if (parsed.version === 2) return { complete: parsed.status === "complete" };
  if (parsed.version === 1 && parsed.imported === 0 && Array.isArray(parsed.skipped) && parsed.skipped.length > 0) return { complete: false };
  return { complete: true };
}

/** Entries already in the new store, or null when its stored value is present but unreadable (never overwritten). */
function currentEntries(storage: KeyValueStorage, store: QueueStore): readonly QueueEntryRequest[] | null {
  const entries = store.load();
  if (entries.length > 0) return entries;
  const raw = storage.getItem(QUEUE_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && parsed.version === 1 && Array.isArray(parsed.entries) && parsed.entries.length === 0) return [];
  } catch {
    // Unreadable: fall through.
  }
  return null;
}

/**
 * Import of the old app's queue into the new versioned store, before the
 * runtime restores (stopped). Never touches the old keys: their raw strings
 * are copied to a backup key first.
 *
 * All or nothing per attempt: while the server cannot state a TrackRef for
 * some old song, nothing is imported or marked and a later start retries.
 * Songs the server lists without any provider, or no longer has, are skipped
 * and reported. Imported entries are appended after whatever the new store
 * already holds (e.g. radio picks made while the import waited), so a late
 * import never drops either queue.
 *
 * Exactly once: the finished mark is written and read back before the
 * entries are saved, so a repeated run can never append them twice; if the
 * save does not stick, the mark is withdrawn again.
 */
export function importLegacyQueue(storage: KeyValueStorage, store: QueueStore, lookup: LegacyLookup, nowIso: () => string): LegacyImportResult {
  const previousMark = storage.getItem(LEGACY_IMPORT_MARK_KEY);
  if (readMark(previousMark)?.complete) return { status: "not-needed", reason: "already-imported" };
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
  const pending: string[] = [];
  if (Array.isArray(picks)) {
    for (const pick of picks) {
      if (!isRecord(pick) || typeof pick.songId !== "string") {
        skipped.push(String(isRecord(pick) ? pick.songId : pick));
        continue;
      }
      const stated = decodeRef(pick.track);
      const known = lookup(pick.songId);
      if (stated) {
        entries.push({ track: stated, display: known.status === "found" ? known.entry.display : null, origin: "restore" });
      } else if (known.status === "found") {
        entries.push({ track: known.entry.track, display: known.entry.display, origin: "restore" });
      } else if (known.status === "unmapped") {
        pending.push(pick.songId);
      } else {
        skipped.push(pick.songId);
      }
    }
  } else {
    skipped.push("(unreadable legacy queue)");
  }
  if (pending.length > 0) return { status: "deferred", reason: "mapping-unavailable", pending };

  const existing = currentEntries(storage, store);
  if (existing === null) return { status: "deferred", reason: "queue-unreadable", pending: [] };
  const room = Math.max(0, MAX_STORED_QUEUE - existing.length);
  const accepted = entries.slice(0, room);
  if (accepted.length < entries.length) skipped.push(`(queue full: ${entries.length - accepted.length} more)`);

  const mark = JSON.stringify({ version: 2, status: "complete", importedAt: nowIso(), imported: accepted.length, skipped });
  storage.setItem(LEGACY_IMPORT_MARK_KEY, mark);
  if (storage.getItem(LEGACY_IMPORT_MARK_KEY) !== mark) return { status: "deferred", reason: "storage-failed", pending: [] };
  if (accepted.length > 0) {
    store.save([...existing, ...accepted]);
    if (store.load().length !== existing.length + accepted.length) {
      // The save did not stick: withdraw the mark so the next start can try again.
      if (previousMark === null) storage.setItem(LEGACY_IMPORT_MARK_KEY, JSON.stringify({ version: 2, status: "retry", at: nowIso() }));
      else storage.setItem(LEGACY_IMPORT_MARK_KEY, previousMark);
      return { status: "deferred", reason: "storage-failed", pending: [] };
    }
  }
  return { status: "imported", imported: accepted.length, skipped };
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

