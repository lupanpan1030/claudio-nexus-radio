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

/**
 * The executor's queue store. It writes the package's versioned envelope and
 * carries one extra field through every save: the legacy import stamp, which
 * the import commits in the same single write as the imported entries (see
 * importLegacyQueue). The package decoder ignores the extra field.
 */
export function createQueueStore(storage: KeyValueStorage): QueueStore {
  const inner = createStorageQueueStore(storage, QUEUE_KEY);
  return {
    load: () => inner.load(),
    save(entries) {
      const stamp = readStamp(storage.getItem(QUEUE_KEY));
      storage.setItem(QUEUE_KEY, encodeQueue(entries, stamp));
    }
  };
}

/** The package's own envelope for `entries`, with the import stamp added when there is one. */
function encodeQueue(entries: readonly QueueEntryRequest[], stamp: ImportStamp | null): string {
  let encoded = "";
  createStorageQueueStore({ getItem: () => null, setItem: (_key, value) => void (encoded = value) }, QUEUE_KEY).save(entries);
  if (stamp === null) return encoded;
  return JSON.stringify({ ...(JSON.parse(encoded) as Record<string, unknown>), [STAMP_FIELD]: stamp });
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

/** Field of the queue envelope that records a finished import. */
const STAMP_FIELD = "legacyImport";

interface ImportStamp {
  readonly version: 3;
  readonly status: "complete";
  readonly importedAt: string;
  readonly imported: number;
  readonly skipped: readonly string[];
}

function readStamp(raw: string | null): ImportStamp | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed[STAMP_FIELD])) return null;
    const stamp = parsed[STAMP_FIELD];
    return stamp.version === 3 && stamp.status === "complete" ? (stamp as unknown as ImportStamp) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the separate mark key records a finished import:
 * - version 3 is the copy written after a stamped queue write;
 * - version 2 "complete" came from an unreleased build that wrote it before
 *   the queue; it cannot be checked afterwards and is taken as final;
 * - a version 1 mark that imported nothing but skipped songs came from a
 *   client that could not map ids at all; it is not a finished import.
 */
function markComplete(raw: string | null): boolean {
  if (raw === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true;
  }
  if (!isRecord(parsed)) return true;
  if (parsed.version === 3 || parsed.version === 2) return parsed.status === "complete";
  if (parsed.version === 1 && parsed.imported === 0 && Array.isArray(parsed.skipped) && parsed.skipped.length > 0) return false;
  return true;
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
 * import never drops either queue. Repeated songs stay repeated.
 *
 * Commit point: one storage write holds both the combined queue and the
 * import stamp, so an interruption before it leaves nothing done (the next
 * start imports) and after it leaves everything done (the next start sees
 * the stamp). Every later queue save keeps the stamp. The mark key is only a
 * copy written afterwards; losing it changes nothing.
 */
export function importLegacyQueue(storage: KeyValueStorage, lookup: LegacyLookup, nowIso: () => string): LegacyImportResult {
  if (readStamp(storage.getItem(QUEUE_KEY)) !== null || markComplete(storage.getItem(LEGACY_IMPORT_MARK_KEY))) {
    return { status: "not-needed", reason: "already-imported" };
  }
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

  const existing = currentEntries(storage, createQueueStore(storage));
  if (existing === null) return { status: "deferred", reason: "queue-unreadable", pending: [] };
  const room = Math.max(0, MAX_STORED_QUEUE - existing.length);
  const accepted = entries.slice(0, room);
  if (accepted.length < entries.length) skipped.push(`(queue full: ${entries.length - accepted.length} more)`);

  const stamp: ImportStamp = { version: 3, status: "complete", importedAt: nowIso(), imported: accepted.length, skipped };
  const committed = encodeQueue([...existing, ...accepted], stamp);
  storage.setItem(QUEUE_KEY, committed);
  // A write that did not stick (quota, private mode) committed nothing: the next start tries again.
  if (storage.getItem(QUEUE_KEY) !== committed) return { status: "deferred", reason: "storage-failed", pending: [] };
  storage.setItem(LEGACY_IMPORT_MARK_KEY, JSON.stringify(stamp));
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

