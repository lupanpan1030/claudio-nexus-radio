// Old-queue import against library rows produced by the real server DTO code
// (server/track-dto.ts + the composition's legacyRefFor rule): no hand-written refs.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { QueueEntryRequest } from "@claudio/contracts";
import { toLibraryResponse } from "../../server/track-dto";
import type { LegacyRefRule } from "../../server/track-dto";
import type { TrackRecord } from "../../server/types";
import { CatalogIndex } from "./catalog";
import { LEGACY_BACKUP_KEY, LEGACY_IMPORT_MARK_KEY, LEGACY_PLAYLIST_KEY, LEGACY_QUEUE_KEY, QUEUE_KEY, createQueueStore, importLegacyQueue } from "./persistence";

function record(id: string, source: string, title: string): TrackRecord {
  return { id, title, artist: "测试歌手", album: "", extension: ".mp3", source, playable: true, filePath: `/private/${id}.mp3`, folder: "private", duration: null, addedAt: "2026-01-01T00:00:00.000Z" } as unknown as TrackRecord;
}

// The composition module is server-only code (Node types); load it at run time
// so the browser tsconfig never typechecks it, but still use its real rule.
const COMPOSITION = "../../server/composition";
const { legacyRefFor } = (await import(COMPOSITION)) as { legacyRefFor: LegacyRefRule };

const LIBRARY = [record("song-a", "kugou-api", "晴天"), record("song-b", "main", "后来"), record("song-x", "unknown-source", "无来源")];

/** What GET /api/library sends: JSON round trip of the real DTO, as the browser would see it. */
function libraryBody(v1: boolean, rows = LIBRARY, total = rows.length) {
  return JSON.parse(JSON.stringify(toLibraryResponse(rows, total, v1 ? legacyRefFor : undefined))) as { tracks: unknown[]; total: number };
}

function catalogFrom(body: { tracks: unknown[]; total: number }) {
  return CatalogIndex.fromLibraryRows(body.tracks, body.total);
}

class MemoryStorage {
  readonly map = new Map<string, string>();
  failWrites: ((key: string) => boolean) | null = null;
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites?.(key)) return; // like safeStorage: a failed write is dropped silently
    this.map.set(key, value);
  }
}

const OLD_QUEUE = JSON.stringify([{ songId: "song-a", djLine: "x" }, { songId: "song-gone" }, { songId: "song-b" }, { songId: "song-x" }]);

function legacyUser() {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_QUEUE_KEY, OLD_QUEUE);
  storage.setItem(LEGACY_PLAYLIST_KEY, JSON.stringify({ playlistId: "p", picks: [] }));
  return { storage, store: createQueueStore(storage) };
}

const runImport = (user: ReturnType<typeof legacyUser>, catalog: CatalogIndex) => importLegacyQueue(user.storage, (id) => catalog.legacyLookup(id), () => "2026-10-16T00:00:00.000Z");

test("the real server DTO: legacy rows lack ref, v1 rows state ref or null; no private fields leak", () => {
  const legacy = libraryBody(false);
  assert.ok(legacy.tracks.every((row) => !Object.prototype.hasOwnProperty.call(row, "ref")));
  const v1 = libraryBody(true);
  const rows = v1.tracks as { id: string; ref: unknown; filePath?: unknown }[];
  assert.deepEqual(rows.map((row) => row.ref), [{ providerId: "kugou", mediaId: "song-a" }, { providerId: "local", mediaId: "song-b" }, null]);
  assert.ok(rows.every((row) => row.filePath === undefined));
  const catalog = catalogFrom(v1);
  assert.equal(catalog.legacyLookup("song-a").status, "found");
  assert.equal(catalog.legacyLookup("song-x").status, "gone", "ref: null = no provider serves it");
  assert.equal(catalog.legacyLookup("song-gone").status, "gone", "absent from a complete list");
  assert.equal(catalogFrom(libraryBody(true, LIBRARY.slice(0, 2), 3)).legacyLookup("song-gone").status, "unmapped", "absent from a partial list is not gone");
  assert.equal(catalogFrom(libraryBody(false)).legacyLookup("song-a").status, "unmapped");
});

test("server without refs: import defers, writes no mark, keeps old keys and backup; a later server with refs imports exactly once", () => {
  const user = legacyUser();
  const deferred = runImport(user, catalogFrom(libraryBody(false)));
  assert.equal(deferred.status, "deferred");
  assert.equal(user.storage.getItem(LEGACY_IMPORT_MARK_KEY), null, "no completion mark");
  assert.equal(user.storage.getItem(QUEUE_KEY), null);
  assert.equal(user.storage.getItem(LEGACY_QUEUE_KEY), OLD_QUEUE, "old key untouched");
  assert.equal(JSON.parse(user.storage.getItem(LEGACY_BACKUP_KEY) ?? "{}").keys[LEGACY_QUEUE_KEY], OLD_QUEUE);

  // Meanwhile the listener played the radio: the new store has an entry of its own.
  const radioPick: QueueEntryRequest = { track: { providerId: "kugou", mediaId: "radio-1" } as QueueEntryRequest["track"], display: null, origin: "radio" };
  user.store.save([radioPick]);

  const imported = runImport(user, catalogFrom(libraryBody(true)));
  assert.deepEqual(imported, { status: "imported", imported: 2, skipped: ["song-gone", "song-x"] });
  assert.deepEqual(user.store.load().map((entry) => `${entry.origin}:${entry.track.mediaId}`), ["radio:radio-1", "restore:song-a", "restore:song-b"], "appended after the newer queue, nothing dropped");
  assert.equal(JSON.parse(user.storage.getItem(LEGACY_IMPORT_MARK_KEY) ?? "{}").status, "complete");

  assert.deepEqual(runImport(user, catalogFrom(libraryBody(true))), { status: "not-needed", reason: "already-imported" });
  assert.equal(user.store.load().length, 3, "no duplicate on a repeated start");
});

test("a version-1 mark that imported nothing (written by the earlier client) is retried", () => {
  const user = legacyUser();
  user.storage.setItem(LEGACY_IMPORT_MARK_KEY, JSON.stringify({ version: 1, importedAt: "x", imported: 0, skipped: ["song-a", "song-b"] }));
  assert.equal(runImport(user, catalogFrom(libraryBody(true))).status, "imported");
  assert.equal(user.store.load().length, 2);
  const done = legacyUser();
  done.storage.setItem(LEGACY_IMPORT_MARK_KEY, JSON.stringify({ version: 1, importedAt: "x", imported: 1, skipped: [] }));
  assert.deepEqual(runImport(done, catalogFrom(libraryBody(true))), { status: "not-needed", reason: "already-imported" });
});

test("storage failures never mark an import done without its entries, nor append twice", () => {
  const saveFails = legacyUser();
  saveFails.storage.failWrites = (key) => key === QUEUE_KEY;
  assert.equal(runImport(saveFails, catalogFrom(libraryBody(true))).status, "deferred");
  assert.equal(saveFails.storage.getItem(LEGACY_IMPORT_MARK_KEY), null, "nothing claims the import");
  saveFails.storage.failWrites = null;
  assert.equal(runImport(saveFails, catalogFrom(libraryBody(true))).status, "imported");
  assert.equal(saveFails.store.load().length, 2);

  // The mark key is only a copy: losing it neither undoes nor repeats the import.
  const markFails = legacyUser();
  markFails.storage.failWrites = (key) => key === LEGACY_IMPORT_MARK_KEY;
  assert.equal(runImport(markFails, catalogFrom(libraryBody(true))).status, "imported");
  assert.equal(markFails.store.load().length, 2);
  markFails.storage.failWrites = null;
  assert.deepEqual(runImport(markFails, catalogFrom(libraryBody(true))), { status: "not-needed", reason: "already-imported" });
  assert.equal(markFails.store.load().length, 2);

  const unreadable = legacyUser();
  unreadable.storage.setItem(QUEUE_KEY, "{broken");
  assert.equal(runImport(unreadable, catalogFrom(libraryBody(true))).status, "deferred");
  assert.equal(unreadable.storage.getItem(QUEUE_KEY), "{broken", "an unreadable new queue is never overwritten");
});

/** Raised by the storage below to model the page/process ending at one write boundary. */
class Terminated extends Error {}

/**
 * Persisted keys only; `crashAt` ends the "process" at one write boundary:
 * before write n (that write never lands) or after it (it landed, nothing
 * after it runs). No in-memory state survives into the next session.
 */
class CrashingStorage extends MemoryStorage {
  writes = 0;
  crashAt: { readonly write: number; readonly when: "before" | "after" } | null = null;
  override setItem(key: string, value: string) {
    this.writes += 1;
    if (this.crashAt?.write === this.writes && this.crashAt.when === "before") throw new Terminated();
    super.setItem(key, value);
    if (this.crashAt?.write === this.writes && this.crashAt.when === "after") throw new Terminated();
  }
}

test("interrupted at any write boundary, the next session imports exactly the missing entries once (repeats and the newer queue kept)", () => {
  const library = [record("song-a", "kugou-api", "晴天"), record("song-b", "main", "后来")];
  const catalog = catalogFrom(libraryBody(true, library));
  const oldQueue = JSON.stringify([{ songId: "song-a" }, { songId: "song-b" }, { songId: "song-a" }]);
  const newer: QueueEntryRequest = { track: { providerId: "kugou", mediaId: "song-a" } as QueueEntryRequest["track"], display: null, origin: "radio" };
  const expected = ["radio:song-a", "restore:song-a", "restore:song-b", "restore:song-a"];
  const seed = () => {
    const storage = new CrashingStorage();
    storage.setItem(LEGACY_QUEUE_KEY, oldQueue);
    createQueueStore(storage).save([newer]);
    storage.writes = 0;
    return storage;
  };
  const session = (storage: CrashingStorage) => importLegacyQueue(storage, (id) => catalog.legacyLookup(id), () => "2026-10-16T00:00:00.000Z");

  const clean = seed();
  assert.equal(session(clean).status, "imported");
  const totalWrites = clean.writes;
  assert.ok(totalWrites >= 3, `backup, queue commit and mark copy (${totalWrites} writes)`);

  const outcomes: string[] = [];
  for (let write = 1; write <= totalWrites; write += 1) {
    for (const when of ["before", "after"] as const) {
      const storage = seed();
      storage.crashAt = { write, when };
      assert.throws(() => session(storage), Terminated, `crash ${when} write ${write}`);
      storage.crashAt = null;
      // New session: only what reached storage.
      const restarted = session(storage);
      const queue = createQueueStore(storage).load().map((entry) => `${entry.origin}:${entry.track.mediaId}`);
      assert.deepEqual(queue, expected, `crash ${when} write ${write}: every old entry once, after the newer queue`);
      outcomes.push(`${when}#${write}:${restarted.status}`);
      // A third start and later runtime saves (including clearing the queue) keep it imported.
      assert.deepEqual(session(storage), { status: "not-needed", reason: "already-imported" });
      createQueueStore(storage).save([]);
      storage.map.delete(LEGACY_IMPORT_MARK_KEY);
      assert.deepEqual(session(storage), { status: "not-needed", reason: "already-imported" }, "the stamp travels with every queue save");
      assert.deepEqual(createQueueStore(storage).load(), []);
      assert.equal(storage.getItem(LEGACY_QUEUE_KEY), oldQueue, "old key never edited");
      assert.equal(JSON.parse(storage.getItem(LEGACY_BACKUP_KEY) ?? "{}").keys[LEGACY_QUEUE_KEY], oldQueue, "backup holds the original raw value");
    }
  }
  // The commit is a single write: crashing before it re-imports, after it does not.
  assert.ok(outcomes.includes("before#2:imported") && outcomes.includes("after#2:not-needed"), outcomes.join(" "));
});
