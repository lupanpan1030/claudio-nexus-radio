import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import type { DailyPlan, RadioPick, RecommendationAuditInput, RecommendationAuditLog, TasteAction, Track } from "./types.js";

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, "radio.sqlite"));

db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    folder TEXT NOT NULL,
    extension TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'main',
    playable INTEGER NOT NULL DEFAULT 1,
    size INTEGER NOT NULL,
    added_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL,
    played_at TEXT NOT NULL,
    reason TEXT,
    dj_line TEXT,
    FOREIGN KEY(track_id) REFERENCES tracks(id)
  );

  CREATE TABLE IF NOT EXISTS tastes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(track_id) REFERENCES tracks(id)
  );

  CREATE TABLE IF NOT EXISTS radio_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL,
    dj_line TEXT NOT NULL,
    reason TEXT NOT NULL,
    mood_tags TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(track_id) REFERENCES tracks(id)
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_state (
    state_key TEXT PRIMARY KEY,
    state_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recommendation_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    query TEXT NOT NULL,
    selected_track_id TEXT NOT NULL,
    selected_title TEXT NOT NULL,
    selected_artist TEXT NOT NULL,
    family TEXT NOT NULL,
    source TEXT NOT NULL,
    dj_line TEXT NOT NULL,
    reason TEXT NOT NULL,
    score_breakdown TEXT NOT NULL,
    candidates TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kugou_playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    track_count INTEGER NOT NULL,
    synced_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kugou_playlist_tracks (
    playlist_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id),
    FOREIGN KEY(playlist_id) REFERENCES kugou_playlists(id),
    FOREIGN KEY(track_id) REFERENCES tracks(id)
  );

  CREATE TABLE IF NOT EXISTS generated_playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    FOREIGN KEY(track_id) REFERENCES tracks(id)
  );
`);

function hasColumn(table: string, column: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  return rows.some((row) => String(row.name) === column);
}

function addColumnIfMissing(table: string, column: string, definition: string) {
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

addColumnIfMissing("tracks", "source", "TEXT NOT NULL DEFAULT 'main'");
addColumnIfMissing("tracks", "playable", "INTEGER NOT NULL DEFAULT 1");

const insertTrack = db.prepare(`
  INSERT INTO tracks (id, title, artist, album, file_path, folder, extension, source, playable, size, added_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(file_path) DO UPDATE SET
    title = excluded.title,
    artist = excluded.artist,
    album = excluded.album,
    folder = excluded.folder,
    extension = excluded.extension,
    source = excluded.source,
    playable = excluded.playable,
    size = excluded.size
`);

export function upsertTracks(tracks: Track[]) {
  db.exec("BEGIN");
  try {
    for (const track of tracks) {
      insertTrack.run(
        track.id,
        track.title,
        track.artist,
        track.album,
        track.filePath,
        track.folder,
        track.extension,
        track.source,
        track.playable ? 1 : 0,
        track.size,
        track.addedAt
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function rowToTrack(row: Record<string, unknown>): Track {
  return {
    id: String(row.id),
    title: String(row.title),
    artist: String(row.artist),
    album: String(row.album),
    filePath: String(row.file_path),
    folder: String(row.folder),
    extension: String(row.extension),
    // Verbatim: an unrecognised source must not be relabelled as a served one.
    source: String(row.source),
    playable: Number(row.playable ?? 1) === 1,
    size: Number(row.size),
    addedAt: String(row.added_at)
  };
}

type GetTracksOptions = {
  playableOnly?: boolean;
  searchFilePath?: boolean;
};

export function getTracks(limit = 500, query = "", options: GetTracksOptions = {}): Track[] {
  const cleanLimit = Math.max(1, Math.min(limit, 5000));
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (query.trim()) {
    const like = `%${query.trim()}%`;
    if (options.searchFilePath === true) {
      where.push("(title LIKE ? OR artist LIKE ? OR album LIKE ? OR file_path LIKE ?)");
      params.push(like, like, like, like);
    } else {
      where.push("(title LIKE ? OR artist LIKE ? OR album LIKE ?)");
      params.push(like, like, like);
    }
  }

  if (options.playableOnly) {
    where.push("playable = 1");
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM tracks
       ${whereClause}
       ORDER BY playable DESC, CASE source WHEN 'kugou-api' THEN 0 WHEN 'main' THEN 1 ELSE 2 END, artist, title
       LIMIT ?`
    )
    .all(...params, cleanLimit) as Record<string, unknown>[];
  return rows.map(rowToTrack);
}

export function preferApiCatalog(tracks: Track[]) {
  const apiTracks = tracks.filter((track) => track.source === "kugou-api");
  const preferred = apiTracks.length > 0 ? apiTracks : tracks;
  const seen = new Set<string>();
  return preferred.filter((track) => {
    if (track.artist.trim().toLowerCase() === "unknown artist") return false;
    if (/^(纯音乐|轻音乐|钢琴曲|music)$/i.test(track.title.trim())) return false;
    const identity = `${track.artist}\n${track.title}`.toLowerCase().replace(/\s+/g, "");
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function getTrack(id: string): Track | undefined {
  const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTrack(row) : undefined;
}

export function countTracks() {
  const row = db.prepare("SELECT COUNT(*) AS count FROM tracks").get() as { count: number };
  return row.count;
}

export type KuGouLibrarySnapshot = {
  playlists: Array<{ id: string; name: string; trackCount: number; trackIds: string[] }>;
  tracks: Track[];
};

export function replaceKuGouLibrary(snapshot: KuGouLibrarySnapshot) {
  const beforeRows = db.prepare("SELECT id, title, artist, album FROM tracks WHERE source = 'kugou-api'").all() as Array<Record<string, unknown>>;
  const before = new Map(beforeRows.map((row) => [String(row.id), `${row.title}\n${row.artist}\n${row.album}`]));
  const incomingIds = new Set(snapshot.tracks.map((track) => track.id));
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;

  db.exec("BEGIN");
  try {
    for (const track of snapshot.tracks) {
      const signature = `${track.title}\n${track.artist}\n${track.album}`;
      if (!before.has(track.id)) added += 1;
      else if (before.get(track.id) !== signature) updated += 1;
      insertTrack.run(track.id, track.title, track.artist, track.album, track.filePath, track.folder, track.extension, track.source, 1, 0, track.addedAt);
    }

    db.exec("DELETE FROM kugou_playlist_tracks; DELETE FROM kugou_playlists;");
    const insertPlaylist = db.prepare("INSERT INTO kugou_playlists (id, name, track_count, synced_at) VALUES (?, ?, ?, ?)");
    const insertMembership = db.prepare("INSERT INTO kugou_playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)");
    for (const playlist of snapshot.playlists) {
      insertPlaylist.run(playlist.id, playlist.name, playlist.trackCount, now);
      playlist.trackIds.forEach((trackId, index) => insertMembership.run(playlist.id, trackId, index + 1));
    }

    for (const id of before.keys()) {
      if (!incomingIds.has(id)) db.prepare("UPDATE tracks SET playable = 0 WHERE id = ? AND source = 'kugou-api'").run(id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { added, updated, removed: [...before.keys()].filter((id) => !incomingIds.has(id)).length, syncedAt: now };
}

export function getKuGouLibraryStatus() {
  const playlist = db.prepare("SELECT COUNT(*) AS count, MAX(synced_at) AS synced_at FROM kugou_playlists").get() as { count: number; synced_at?: string };
  const tracks = db.prepare("SELECT COUNT(*) AS count FROM tracks WHERE source = 'kugou-api' AND playable = 1").get() as { count: number };
  const memberships = db.prepare("SELECT COUNT(*) AS count FROM kugou_playlist_tracks").get() as { count: number };
  return { syncedAt: playlist.synced_at, playlistCount: playlist.count, trackCount: tracks.count, membershipCount: memberships.count };
}

export function getRecentPlays(limit = 12): Track[] {
  const rows = db
    .prepare(
      `SELECT tracks.* FROM plays
       JOIN tracks ON tracks.id = plays.track_id
       ORDER BY plays.played_at DESC
       LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToTrack);
}

export function getRecentRadioPickTracks(limit = 24): Track[] {
  const rows = db
    .prepare(
      `SELECT tracks.* FROM radio_picks
       JOIN tracks ON tracks.id = radio_picks.track_id
       ORDER BY radio_picks.created_at DESC
       LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToTrack);
}

export function getRecentGeneratedPlaylistTracks(limit = 80): Track[] {
  const rows = db
    .prepare(
      `SELECT tracks.* FROM generated_playlist_tracks
       JOIN tracks ON tracks.id = generated_playlist_tracks.track_id
       WHERE datetime(generated_playlist_tracks.generated_at) >= datetime('now', '-3 days')
       ORDER BY generated_playlist_tracks.generated_at DESC
       LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToTrack);
}

export function recordGeneratedPlaylistTracks(playlistId: string, trackIds: string[]) {
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT INTO generated_playlist_tracks (playlist_id, track_id, generated_at) VALUES (?, ?, ?)"
  );
  const uniqueTrackIds = [...new Set(trackIds.filter(Boolean))];
  db.exec("BEGIN");
  try {
    for (const trackId of uniqueTrackIds) insert.run(playlistId, trackId, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getTodayPlayedTrackIds(limit = 24): string[] {
  const rows = db
    .prepare(
      `SELECT track_id FROM plays
       WHERE date(played_at, 'localtime') = date('now', 'localtime')
       ORDER BY played_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((row) => String(row.track_id));
}

export function getTasteSummary(limit = 30) {
  return db
    .prepare(
      `SELECT tracks.title, tracks.artist, tastes.action, tastes.created_at
       FROM tastes
       JOIN tracks ON tracks.id = tastes.track_id
       ORDER BY tastes.created_at DESC
       LIMIT ?`
    )
    .all(limit);
}

type TasteScoreOptions = {
  now?: Date;
};

const tasteTrackWeights: Partial<Record<TasteAction, number>> = {
  like: 4,
  skip: -7
};

const tasteArtistWeights: Partial<Record<TasteAction, number>> = {
  like: 0.8,
  skip: -1.4
};

const tasteSceneWeights: Partial<Record<TasteAction, number>> = {
  commute: 3,
  morning: 2,
  work: 2,
  sleep: 3,
  focus: 3,
  nostalgia: 2,
  other: 1
};

const scoreHalfLifeDays = 45;

function daysBetween(left: Date, rightIso: string) {
  const rightTime = new Date(rightIso).getTime();
  if (Number.isNaN(rightTime)) return 0;
  return Math.max(0, (left.getTime() - rightTime) / 86_400_000);
}

function decayMultiplier(ageDays: number) {
  return Math.pow(0.5, ageDays / scoreHalfLifeDays);
}

function addCappedScore(map: Map<string, number>, key: string, delta: number, min: number, max: number) {
  const next = Math.max(min, Math.min(max, (map.get(key) ?? 0) + delta));
  map.set(key, next);
}

export function getTasteScores(options: TasteScoreOptions = {}) {
  const rows = db
    .prepare(
      `SELECT tracks.id, tracks.artist, tracks.title, tastes.action, tastes.created_at
       FROM tastes
       JOIN tracks ON tracks.id = tastes.track_id`
    )
    .all() as Array<Record<string, unknown>>;

  const now = options.now ?? new Date();
  const scores = new Map<string, number>();
  const artistScores = new Map<string, number>();
  const sceneScores = new Map<string, Map<string, number>>();

  for (const row of rows) {
    const id = String(row.id);
    const artist = String(row.artist);
    const action = String(row.action) as TasteAction;
    const multiplier = decayMultiplier(daysBetween(now, String(row.created_at)));
    const trackWeight = tasteTrackWeights[action] ?? 0;
    const artistWeight = tasteArtistWeights[action] ?? 0;
    const sceneWeight = tasteSceneWeights[action] ?? 0;

    if (trackWeight) {
      addCappedScore(scores, id, trackWeight * multiplier, -12, 12);
    }

    if (artistWeight) {
      addCappedScore(artistScores, artist, artistWeight * multiplier, -5, 5);
    }

    if (sceneWeight) {
      const sceneMap = sceneScores.get(action) ?? new Map<string, number>();
      addCappedScore(sceneMap, id, sceneWeight * multiplier, 0, 9);
      sceneScores.set(action, sceneMap);
    }
  }

  return { scores, artistScores, sceneScores };
}

export function getPreferenceProfile() {
  const likedArtists = db
    .prepare(
      `SELECT tracks.artist, COUNT(*) AS count
       FROM tastes
       JOIN tracks ON tracks.id = tastes.track_id
       WHERE tastes.action IN ('like', 'commute', 'morning', 'work', 'sleep', 'focus', 'nostalgia', 'other')
       GROUP BY tracks.artist
       ORDER BY count DESC
       LIMIT 12`
    )
    .all();

  const skippedArtists = db
    .prepare(
      `SELECT tracks.artist, COUNT(*) AS count
       FROM tastes
       JOIN tracks ON tracks.id = tastes.track_id
       WHERE tastes.action = 'skip'
       GROUP BY tracks.artist
       ORDER BY count DESC
       LIMIT 8`
    )
    .all();

  const sceneTags = db
    .prepare(
      `SELECT action, COUNT(*) AS count
       FROM tastes
       WHERE action IN ('commute', 'morning', 'work', 'sleep', 'focus', 'nostalgia', 'other')
       GROUP BY action
       ORDER BY count DESC`
    )
    .all();

  return { likedArtists, skippedArtists, sceneTags, memories: getMemories(20) };
}

export function recordPlay(trackId: string, pick?: RadioPick) {
  db.prepare("INSERT INTO plays (track_id, played_at, reason, dj_line) VALUES (?, ?, ?, ?)").run(
    trackId,
    new Date().toISOString(),
    pick?.reason ?? "",
    pick?.djLine ?? ""
  );
}

export function updateLatestPlayLine(trackId: string, djLine: string) {
  db.prepare(
    `UPDATE plays
     SET dj_line = ?
     WHERE id = (
       SELECT id FROM plays
       WHERE track_id = ?
       ORDER BY played_at DESC
       LIMIT 1
     )`
  ).run(djLine, trackId);
}

export function recordTaste(trackId: string, action: TasteAction) {
  db.prepare("INSERT INTO tastes (track_id, action, created_at) VALUES (?, ?, ?)").run(
    trackId,
    action,
    new Date().toISOString()
  );
}

export function removeTaste(trackId: string, action: TasteAction) {
  db.prepare("DELETE FROM tastes WHERE track_id = ? AND action = ?").run(trackId, action);
}

export function recordChatMessage(role: "user" | "assistant", content: string) {
  db.prepare("INSERT INTO chat_messages (role, content, created_at) VALUES (?, ?, ?)").run(
    role,
    content,
    new Date().toISOString()
  );
}

export function getRecentChat(limit = 12) {
  return db
    .prepare("SELECT role, content, created_at FROM chat_messages ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .reverse();
}

export function recordMemory(content: string, source = "chat") {
  const clean = content.trim();
  if (!clean) return;
  db.prepare("INSERT INTO memories (content, source, created_at) VALUES (?, ?, ?)").run(
    clean.slice(0, 240),
    source,
    new Date().toISOString()
  );
}

export function getMemories(limit = 20) {
  return db
    .prepare("SELECT content, source, created_at FROM memories ORDER BY created_at DESC LIMIT ?")
    .all(limit);
}

export function recordRadioPick(pick: RadioPick) {
  db.prepare(
    "INSERT INTO radio_picks (track_id, dj_line, reason, mood_tags, source, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    pick.songId,
    pick.djLine,
    pick.reason,
    JSON.stringify(pick.moodTags),
    pick.source,
    new Date().toISOString()
  );
}

export function updateLatestRadioPickLine(trackId: string, djLine: string) {
  db.prepare(
    `UPDATE radio_picks
     SET dj_line = ?, source = 'ai'
     WHERE id = (
       SELECT id FROM radio_picks
       WHERE track_id = ?
       ORDER BY created_at DESC
       LIMIT 1
     )`
  ).run(djLine, trackId);
}

export function getTodayPicks(): Array<RadioPick & { createdAt: string; title: string; artist: string }> {
  const rows = db
    .prepare(
      `SELECT radio_picks.*, tracks.title, tracks.artist FROM radio_picks
       JOIN tracks ON tracks.id = radio_picks.track_id
       WHERE date(radio_picks.created_at, 'localtime') = date('now', 'localtime')
       ORDER BY radio_picks.created_at DESC
       LIMIT 24`
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    songId: String(row.track_id),
    djLine: String(row.dj_line),
    reason: String(row.reason),
    moodTags: JSON.parse(String(row.mood_tags || "[]")) as string[],
    source: row.source === "openai" || row.source === "ai" ? "ai" : "rules",
    createdAt: String(row.created_at),
    title: String(row.title),
    artist: String(row.artist)
  }));
}

export function recordRecommendationAudit(audit: RecommendationAuditInput) {
  db.prepare(
    `INSERT INTO recommendation_audits (
      mode,
      query,
      selected_track_id,
      selected_title,
      selected_artist,
      family,
      source,
      dj_line,
      reason,
      score_breakdown,
      candidates,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    audit.mode,
    audit.query,
    audit.selectedSongId,
    audit.selectedTitle,
    audit.selectedArtist,
    audit.family,
    audit.source,
    audit.djLine,
    audit.reason,
    JSON.stringify(audit.scoreBreakdown),
    JSON.stringify(audit.candidates),
    new Date().toISOString()
  );
}

export function updateLatestRecommendationAuditLine(trackId: string, djLine: string) {
  db.prepare(
    `UPDATE recommendation_audits
     SET dj_line = ?, source = 'ai'
     WHERE id = (
       SELECT id FROM recommendation_audits
       WHERE selected_track_id = ?
       ORDER BY created_at DESC
       LIMIT 1
     )`
  ).run(djLine, trackId);
}

export function getRecommendationAudits(limit = 20): RecommendationAuditLog[] {
  const cleanLimit = Math.max(1, Math.min(limit, 100));
  const rows = db
    .prepare("SELECT * FROM recommendation_audits ORDER BY created_at DESC LIMIT ?")
    .all(cleanLimit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    mode: row.mode === "queue" ? "queue" : "next",
    query: String(row.query),
    selectedSongId: String(row.selected_track_id),
    selectedTitle: String(row.selected_title),
    selectedArtist: String(row.selected_artist),
    family: String(row.family),
    source: row.source === "openai" || row.source === "ai" ? "ai" : "rules",
    djLine: String(row.dj_line),
    reason: String(row.reason),
    scoreBreakdown: JSON.parse(String(row.score_breakdown || "{}")),
    candidates: JSON.parse(String(row.candidates || "[]")),
    createdAt: String(row.created_at)
  }));
}

export function setActiveDailyPlan(plan: DailyPlan) {
  db.prepare(
    `INSERT INTO app_state (state_key, state_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(state_key) DO UPDATE SET
       state_value = excluded.state_value,
       updated_at = excluded.updated_at`
  ).run("active_daily_plan", JSON.stringify(plan), new Date().toISOString());
}

export function getActiveDailyPlan(): DailyPlan | undefined {
  const row = db.prepare("SELECT state_value FROM app_state WHERE state_key = ?").get("active_daily_plan") as
    | { state_value: string }
    | undefined;

  if (!row?.state_value) return undefined;

  try {
    return JSON.parse(row.state_value) as DailyPlan;
  } catch {
    return undefined;
  }
}
