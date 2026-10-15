import assert from "node:assert/strict";
import { test } from "node:test";
import { asId, type AssetId, type PlaybackSnapshot, type QueueEntryRequest, type QueueItemId, type RecordingId, type SourceRevision } from "@claudio/contracts";
import type { QueueStore } from "@claudio/playback-web";
import { CatalogIndex } from "./catalog";
import { planChatReply, shouldDeliver } from "./chat-intent";
import { LEGACY_BACKUP_KEY, LEGACY_IMPORT_MARK_KEY, LEGACY_QUEUE_KEY, LEGACY_PLAYLIST_KEY, QUEUE_KEY, importLegacyQueue, readSettings, safeStorage } from "./persistence";
import { voiceControls } from "./voice-model";
import { activeLyricIndex, activeSegmentIndex, lyricsStatusText, subtitleLines } from "./subtitles";
import { ref } from "./test-support";

const catalog = CatalogIndex.fromLibraryRows(
  [
    { id: "song-a", title: "晴天", artist: "周杰伦", ref: ref("A", "kugou") },
    { id: "song-b", title: "后来", artist: "刘若英", ref: ref("B", "kugou") },
    { id: "song-legacy-only", title: "无 ref", artist: "x" }
  ],
  3
);

function snapshot(partial: Partial<Record<string, unknown>>): PlaybackSnapshot {
  return { transport: "idle", program: null, queue: [], history: [], voice: null, narration: { retained: null, replay: { available: false, reason: "no-narration" } }, ...partial } as unknown as PlaybackSnapshot;
}

const playingWithQueue = snapshot({
  transport: "playing",
  program: { item: { itemId: asId<QueueItemId>("p1") }, started: true },
  queue: [{ item: { itemId: asId<QueueItemId>("q1") }, reservation: "none", lastError: null }]
});

test("catalog links legacy rows only to server-stated refs, never guesses from song ids", () => {
  assert.equal(catalog.byLegacyId("song-a")?.ref.mediaId, "A");
  assert.equal(catalog.byLegacyId("song-legacy-only"), null);
  assert.equal(catalog.unlinkedRows, 1);
});

test("chat: playlist loads (replace-queue, no autoplay) while listening; pick plays now only when nothing else is lined up", () => {
  const playlist = planChatReply({ playlist: { title: "夜晚", picks: [{ songId: "song-a" }, { songId: "song-b" }, { songId: "song-a" }] } }, playingWithQueue, catalog);
  assert.equal(playlist.kind, "load-playlist");
  assert.deepEqual(playlist.commands.map((command) => command.type), ["replace-queue"]);
  const replace = playlist.commands[0];
  assert.ok(replace?.type === "replace-queue" && replace.autoplay === false && replace.entries.length === 3, "repeated songs stay separate entries");

  const pickWhileListening = planChatReply({ pick: { songId: "song-b" } }, playingWithQueue, catalog);
  assert.equal(pickWhileListening.kind, "queue-next");
  assert.equal(pickWhileListening.destructive, false);

  const pickWhenIdle = planChatReply({ pick: { songId: "song-b", track: ref("B", "kugou") } }, snapshot({}), catalog);
  assert.equal(pickWhenIdle.kind, "play-now");
  assert.equal(pickWhenIdle.commands[0]?.type, "select");

  const unknown = planChatReply({ pick: { songId: "song-legacy-only" } }, snapshot({}), catalog);
  assert.equal(unknown.kind, "none");
  assert.deepEqual(unknown.unresolved, ["song-legacy-only"]);
});

test("chat: an overtaken reply is suggested instead of applied when it would change or start playback", () => {
  const exhausted = snapshot({ transport: "exhausted" });
  const queuePick = planChatReply({ queuePick: { songId: "song-a" } }, exhausted, catalog);
  assert.equal(queuePick.autoStarts, true, "enqueue into an exhausted queue would start by itself");
  assert.equal(shouldDeliver(queuePick, true), "suggest");
  assert.equal(shouldDeliver(queuePick, false), "apply");
  const additive = planChatReply({ queuePick: { songId: "song-a" } }, playingWithQueue, catalog);
  assert.equal(shouldDeliver(additive, true), "apply", "adding after the current program changes nothing audible");
  const replace = planChatReply({ playlist: { picks: [{ songId: "song-a" }] } }, playingWithQueue, catalog);
  assert.equal(shouldDeliver(replace, true), "suggest");
});

class MemoryStorage {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

function memoryQueueStore(storage: MemoryStorage): QueueStore & { saved: QueueEntryRequest[][] } {
  const saved: QueueEntryRequest[][] = [];
  return {
    saved,
    load: () => saved.at(-1) ?? [],
    save(entries) {
      saved.push([...entries]);
      storage.setItem(QUEUE_KEY, JSON.stringify({ version: 1, entries }));
    }
  };
}

test("legacy import: backs up both old keys, maps known songs, skips unknown, runs once, never edits old keys", () => {
  const storage = new MemoryStorage();
  const oldQueue = JSON.stringify([{ songId: "song-a", djLine: "x" }, { songId: "song-gone" }, { songId: "song-b" }]);
  const oldPlaylist = JSON.stringify({ playlistId: "p", picks: [] });
  storage.setItem(LEGACY_QUEUE_KEY, oldQueue);
  storage.setItem(LEGACY_PLAYLIST_KEY, oldPlaylist);
  const store = memoryQueueStore(storage);
  const lookup = (songId: string) => catalog.legacyLookup(songId);
  const result = importLegacyQueue(storage, store, lookup, () => "2026-10-16T00:00:00.000Z");
  assert.deepEqual(result, { status: "imported", imported: 2, skipped: ["song-gone"] });
  assert.deepEqual(store.saved[0]?.map((entry) => entry.track.mediaId), ["A", "B"]);
  assert.ok(store.saved[0]?.every((entry) => entry.origin === "restore"));
  const backup = JSON.parse(storage.getItem(LEGACY_BACKUP_KEY) ?? "{}");
  assert.equal(backup.keys[LEGACY_QUEUE_KEY], oldQueue);
  assert.equal(backup.keys[LEGACY_PLAYLIST_KEY], oldPlaylist);
  assert.equal(storage.getItem(LEGACY_QUEUE_KEY), oldQueue, "old key untouched");
  assert.ok(storage.getItem(LEGACY_IMPORT_MARK_KEY));
  storage.map.delete(QUEUE_KEY);
  assert.deepEqual(importLegacyQueue(storage, store, lookup, () => "later"), { status: "not-needed", reason: "already-imported" });
  assert.equal(store.saved.length, 1);
});

test("broken storage never throws into playback; bad settings fall back to defaults", () => {
  const broken = safeStorage(() => ({
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceeded");
    }
  }));
  assert.equal(broken.getItem("x"), null);
  assert.doesNotThrow(() => broken.setItem("x", "y"));
  assert.equal(broken.healthy, false);
  const storage = new MemoryStorage();
  storage.setItem("claudio.settings.v1", "{not json");
  assert.equal(readSettings(storage).musicVolume, 0.5);
  storage.setItem("claudio.settings.v1", JSON.stringify({ version: 1, theme: "light", musicVolume: 7 }));
  assert.equal(readSettings(storage).theme, "light");
  assert.equal(readSettings(storage).musicVolume, 0.5);
});

test("voice controls follow core facts: stop while active, replay only when the core allows it", () => {
  const subtitle = { timing: "plain-text" as const, segments: [{ text: "接下来这首。" }] };
  const retained = { itemId: "p1", cueId: "c1", transitionId: "t1", scriptText: "接下来这首。", subtitle, spokenMs: null, expiresAt: null };
  const idle = voiceControls(snapshot({ narration: { retained, replay: { available: true } } }));
  assert.equal(idle.mainAction, "replay");
  assert.equal(idle.panelAction, "replay");
  assert.equal(idle.text, "接下来这首。");
  const blocked = voiceControls(snapshot({ narration: { retained, replay: { available: false, reason: "expired" } } }));
  assert.equal(blocked.mainAction, null);
  assert.equal(blocked.replayBlock, "expired");
  const speaking = voiceControls(snapshot({ voice: { cueId: "c2", status: "speaking", origin: "manual", pausedBy: null, scriptText: "接下来这首。", subtitle }, narration: { retained, replay: { available: false, reason: "voice-active" } } }));
  assert.equal(speaking.mainAction, "stop");
  assert.equal(speaking.panelAction, "pause");
  const userPaused = voiceControls(snapshot({ voice: { cueId: "c2", status: "paused", origin: "manual", pausedBy: "user", scriptText: "x", subtitle } }));
  assert.equal(userPaused.panelAction, "resume");
  assert.equal(userPaused.userPaused, true);
});

test("subtitles use real timing only: lyric offset delays, plain DJ text has no current line", () => {
  const asset = { assetId: asId<AssetId>("l"), recordingId: asId<RecordingId>("r"), sourceRevision: asId<SourceRevision>("v"), timing: "native-line" as "native-line" | "plain-text", offsetMs: 500, lines: [{ startMs: 0, text: "一" }, { startMs: 2000, text: "二" }] };
  assert.equal(activeLyricIndex(asset, 400), -1);
  assert.equal(activeLyricIndex(asset, 600), 0);
  assert.equal(activeLyricIndex(asset, 2600), 1);
  assert.equal(activeLyricIndex({ ...asset, timing: "plain-text", lines: [{ text: "一" }] }, 9999), -1);
  const plain = { timing: "plain-text" as const, segments: [{ text: "第一句。第二句！" }] };
  assert.equal(activeSegmentIndex(plain, 5000), -1);
  assert.deepEqual(subtitleLines(plain, null), ["第一句。", "第二句！"]);
  const timed = { timing: "native-line" as const, segments: [{ startMs: 0, text: "甲" }, { startMs: 1200, text: "乙" }] };
  assert.equal(activeSegmentIndex(timed, 1300), 1);
  assert.equal(lyricsStatusText({ status: "unmatched" }), "找到的歌词和正在播放的录音版本对不上，暂不显示");
});

test("every chat reply becomes at most one command (no fact can slip between two dispatches)", () => {
  const replies = [
    { pick: { songId: "song-a" }, queuePick: { songId: "song-b" } },
    { pick: { songId: "song-a" }, queuePick: { songId: "song-b" }, playlist: { picks: [{ songId: "song-b" }] } },
    { queuePick: { songId: "song-b" }, playlist: { picks: [{ songId: "song-a" }] } },
    { pick: { songId: "song-a" } },
    { queuePick: { songId: "song-a" } }
  ];
  for (const reply of replies) {
    for (const state of [snapshot({}), playingWithQueue]) {
      assert.ok(planChatReply(reply, state, catalog).commands.length <= 1, JSON.stringify(reply));
    }
  }
  const both = planChatReply(replies[0]!, playingWithQueue, catalog);
  assert.equal(both.commands[0]?.type, "enqueue", "listening with a queue: both join as next");
  const idleBoth = planChatReply(replies[0]!, snapshot({}), catalog);
  assert.ok(idleBoth.commands[0]?.type === "replace-queue" && idleBoth.commands[0].autoplay && idleBoth.commands[0].entries.length === 2);
});

test("userActionSeq advances on queue intents only, not on pause/seek/volume/voice", async () => {
  const { PlaybackController } = await import("./controller");
  const dispatched: string[] = [];
  const state = playingWithQueue;
  const host = {
    getView: () => ({ role: "executor" as const, executorInstanceId: "e", snapshot: state, canControl: true, exclusive: true }),
    dispatch: (command: { type: string }) => {
      dispatched.push(command.type);
      return { accepted: true as const, version: 1 };
    },
    unlockAudio: () => {}
  };
  const controller = new PlaybackController(host, () => null);
  controller.togglePlay();
  controller.seek(1000);
  controller.setVolume(0.2);
  controller.voiceMain();
  assert.equal(controller.getUserActionSeq(), 0);
  controller.next();
  assert.equal(controller.getUserActionSeq(), 1);
  assert.deepEqual(dispatched, ["pause", "seek", "set-volume", "next"]);
});
