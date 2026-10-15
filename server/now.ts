import type { RadioPick, TrackDto } from "./types.js";

export type NowPlayingDjSnapshot = {
  songId: string;
  say: string;
  voiceUrl: string;
  source: "ai" | "rules";
  status: "idle" | "writing" | "voice_preparing" | "voice_ready" | "voice_failed";
};

export type NowPlayingSnapshot = {
  updatedAt: string;
  playback: {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    volume: number;
  };
  currentTrack: TrackDto | null;
  currentPick: RadioPick | null;
  dj: NowPlayingDjSnapshot | null;
  queue: {
    activePlaylistId: string | null;
    activePlaylistTitle: string | null;
    length: number;
    nextSongId: string | null;
  };
  source: "web";
};

const emptySnapshot: NowPlayingSnapshot = {
  updatedAt: "",
  playback: {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 0
  },
  currentTrack: null,
  currentPick: null,
  dj: null,
  queue: {
    activePlaylistId: null,
    activePlaylistTitle: null,
    length: 0,
    nextSongId: null
  },
  source: "web"
};

let nowPlayingSnapshot: NowPlayingSnapshot = emptySnapshot;
const subscribers = new Set<(snapshot: NowPlayingSnapshot) => void>();

function finiteNumber(value: unknown, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function trimString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeTrack(value: unknown): NowPlayingSnapshot["currentTrack"] {
  if (!value || typeof value !== "object") return null;
  const track = value as Partial<TrackDto>;
  const id = trimString(track.id);
  if (!id) return null;

  return {
    id,
    title: trimString(track.title),
    artist: trimString(track.artist),
    album: trimString(track.album),
    extension: trimString(track.extension),
    source: track.source === "kugou-api" ? "kugou-api" : track.source === "kugou-cache" ? "kugou-cache" : "main",
    playable: track.playable === true
  };
}

function normalizePick(value: unknown): RadioPick | null {
  if (!value || typeof value !== "object") return null;
  const pick = value as Partial<RadioPick>;
  const songId = trimString(pick.songId);
  if (!songId) return null;

  return {
    songId,
    djLine: trimString(pick.djLine),
    reason: trimString(pick.reason),
    moodTags: Array.isArray(pick.moodTags) ? pick.moodTags.map((item) => String(item)) : [],
    source: pick.source === "ai" || pick.source === "openai" ? pick.source : "rules",
    segue: pick.segue,
    decision: pick.decision
  };
}

function normalizeDj(value: unknown): NowPlayingDjSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const dj = value as Partial<NowPlayingDjSnapshot>;
  const songId = trimString(dj.songId);
  if (!songId) return null;
  const statusSet = new Set<NowPlayingDjSnapshot["status"]>([
    "idle",
    "writing",
    "voice_preparing",
    "voice_ready",
    "voice_failed"
  ]);

  return {
    songId,
    say: trimString(dj.say),
    voiceUrl: trimString(dj.voiceUrl),
    source: dj.source === "ai" ? "ai" : "rules",
    status: statusSet.has(dj.status as NowPlayingDjSnapshot["status"]) ? (dj.status as NowPlayingDjSnapshot["status"]) : "idle"
  };
}

export function getNowPlayingSnapshot() {
  return nowPlayingSnapshot;
}

export function subscribeNowPlaying(listener: (snapshot: NowPlayingSnapshot) => void) {
  subscribers.add(listener);
  listener(nowPlayingSnapshot);
  return () => {
    subscribers.delete(listener);
  };
}

export function updateNowPlayingSnapshot(payload: unknown) {
  const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const playback = body.playback && typeof body.playback === "object" ? (body.playback as Record<string, unknown>) : {};
  const queue = body.queue && typeof body.queue === "object" ? (body.queue as Record<string, unknown>) : {};

  nowPlayingSnapshot = {
    updatedAt: new Date().toISOString(),
    playback: {
      isPlaying: playback.isPlaying === true,
      currentTime: finiteNumber(playback.currentTime),
      duration: finiteNumber(playback.duration),
      volume: finiteNumber(playback.volume)
    },
    currentTrack: normalizeTrack(body.currentTrack),
    currentPick: normalizePick(body.currentPick),
    dj: normalizeDj(body.dj),
    queue: {
      activePlaylistId: trimString(queue.activePlaylistId) || null,
      activePlaylistTitle: trimString(queue.activePlaylistTitle) || null,
      length: Math.max(0, Math.trunc(finiteNumber(queue.length))),
      nextSongId: trimString(queue.nextSongId) || null
    },
    source: "web"
  };

  for (const subscriber of subscribers) {
    subscriber(nowPlayingSnapshot);
  }

  return nowPlayingSnapshot;
}
