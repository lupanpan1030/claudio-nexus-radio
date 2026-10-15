import fs from "node:fs";
import path from "node:path";
import {
  getRecentGeneratedPlaylistTracks,
  getRecentPlays,
  getRecentRadioPickTracks,
  getTasteScores,
  getTracks,
  preferApiCatalog,
  recordGeneratedPlaylistTracks
} from "./db.js";
import { getRadioDecision } from "./radio.js";
import { getUserProfileDocs } from "./userProfile.js";
import type { PlaylistLinkInspection, PlaylistSuggestion, RadioPick, Track, WeatherContext } from "./types.js";

type PlaylistFamily = "piano" | "ost" | "chinese-vocal" | "energy" | "instrumental" | "other";

type PlaylistCandidate = {
  track: Track;
  family: PlaylistFamily;
  score: number;
};

type PlaylistOptions = {
  count?: number;
  weather?: WeatherContext;
  useAi?: boolean;
  recordHistory?: boolean;
  /** Listening recency (most recent first); defaults to legacy plays/radio picks. */
  recent?: Track[];
  verifyPlayable?: (track: Track) => Promise<boolean>;
};

type AgentPlaylistTrack = {
  title: string;
  artist?: string;
  reason?: string;
  family?: string;
};

type AgentPlaylist = {
  schema?: string;
  title?: string;
  scene?: string;
  program_note?: string;
  tracks?: AgentPlaylistTrack[];
};

export const playlistInboxDir = path.join(process.cwd(), ".data", "playlist-inbox");
export const latestPlaylistInboxPath = path.join(playlistInboxDir, "latest.json");
export const pendingPlaylistInboxPath = path.join(playlistInboxDir, "pending.json");

function firstUrlText(input: unknown) {
  const text = typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? "");
  return text.match(/https?:\/\/\S+/i)?.[0] ?? text.trim();
}

function idFromUrl(url: URL, keys: string[]) {
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value) return value;
  }

  const hashQuery = url.hash.includes("?") ? url.hash.slice(url.hash.indexOf("?") + 1) : "";
  if (hashQuery) {
    const params = new URLSearchParams(hashQuery);
    for (const key of keys) {
      const value = params.get(key);
      if (value) return value;
    }
  }

  return url.pathname.match(/(?:playlist|list|special|album|gedan)[/\-_]?(\d+)/i)?.[1];
}

export function inspectPlaylistLink(input: unknown): PlaylistLinkInspection {
  const inputUrl = firstUrlText(input);
  let url: URL;

  try {
    url = new URL(inputUrl);
  } catch {
    return {
      inputUrl,
      platform: "unknown",
      status: "invalid",
      message: "请粘贴一个完整的歌单链接。",
      nextStep: "如果你已经有 agent JSON，请继续使用 JSON 导入。"
    };
  }

  const host = url.hostname.toLowerCase();
  const platform = host.includes("163.com")
    ? "netease"
    : host.includes("kugou.com")
      ? "kugou"
      : host.includes("qq.com") || host.includes("y.qq.com")
        ? "qqmusic"
        : "unknown";
  const playlistId = idFromUrl(url, ["id", "playlistId", "global_collection_id", "listid", "disstid", "tid"]);

  if (platform === "unknown") {
    return {
      inputUrl,
      platform,
      status: "unsupported",
      message: "已收到链接，但暂未支持这个平台。",
      nextStep: "当前只做链接识别；后续优先接网易云或酷狗歌单解析。"
    };
  }

  return {
    inputUrl,
    platform,
    playlistId,
    status: playlistId ? "recognized" : "unsupported",
    message: playlistId ? "已识别歌单链接；当前阶段尚未抓取曲目。" : "已识别平台，但未找到歌单 ID。",
    nextStep: "下一阶段会把链接解析为 claudio.playlist.v1 JSON，再复用现有本地匹配和队列。"
  };
}

function normalizeText(value: string) {
  return value.toLowerCase();
}

function normalizeMatchText(value: string) {
  return value
    .toLowerCase()
    .replace(/\.(mp3|flac|m4a|wav|ogg)$/i, "")
    .replace(/\b(official|audio|lyrics?|mv|hd|hq|full version|remastered|cover|伴奏|纯音乐版|完整版|无损)\b/gi, " ")
    .replace(/[“”"'`[\]()（）【】]/g, " ")
    .replace(/[，。！？、,.!?;；：:\\|-]+/g, " ")
    .replace(/\s+(feat|ft|with)\s+/gi, " ")
    .replace(/[·・]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactMatchText(value: string) {
  return normalizeMatchText(value).replace(/\s+/g, "");
}

function matchTokens(value: string) {
  return normalizeMatchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function tokenCoverage(queryTokens: string[], haystack: string) {
  if (queryTokens.length === 0) return 0;
  const hitCount = queryTokens.filter((token) => haystack.includes(token)).length;
  return hitCount / queryTokens.length;
}

const importedTitleAliases: Record<string, string[]> = {
  sparkle: ["スパークル", "火花"],
  "one summer s day": ["あの夏へ", "one summer's day"],
  "merry christmas mr lawrence": ["merry christmas mr. lawrence", "劳伦斯先生圣诞快乐", "圣诞快乐劳伦斯先生"],
  "river flows in you": ["你的心河"],
  "kiss the rain": ["雨的印记"]
};

function importedTitleVariants(title: string) {
  const normalized = normalizeMatchText(title);
  const variants = new Set([title]);
  for (const alias of importedTitleAliases[normalized] ?? []) {
    variants.add(alias);
  }
  return [...variants];
}

function playlistFamily(track: Track): PlaylistFamily {
  const text = normalizeText(`${track.title} ${track.artist} ${track.album}`);
  if (/钢琴|piano|pianoboy|kiss the rain|river flows|my soul/.test(text)) return "piano";
  if (/ost|soundtrack|久石|radwimps|泽野|sawano|movie|映画|主题曲/.test(text)) return "ost";
  if (/周杰伦|赵雷|孙燕姿|梁静茹|陈奕迅|五月天|朴树|罗大佑|中文|国语|粤语/.test(text)) {
    return "chinese-vocal";
  }
  if (/beat|rock|edm|remix|epic|victory|workout|run/.test(text)) return "energy";
  if (/纯音乐|instrumental|ambient|healing|治愈|calm|sleep/.test(text)) return "instrumental";
  return "other";
}

function sceneTags(scene: string) {
  const text = normalizeText(scene);
  const tags: string[] = [];
  if (/通勤|上班|路上|地铁|commute/.test(text)) tags.push("commute");
  if (/工作|学习|专注|focus|study|work/.test(text)) tags.push("focus");
  if (/睡前|夜晚|放松|sleep|night|calm/.test(text)) tags.push("sleep");
  if (/中文|老歌|怀旧|人声/.test(text)) tags.push("vocal");
  return tags.length > 0 ? tags : ["radio"];
}

function sceneScore(track: Track, family: PlaylistFamily, tags: string[]) {
  const text = normalizeText(`${track.title} ${track.artist} ${track.album}`);
  let score = 0;

  if (tags.includes("focus")) {
    if (["instrumental", "ost", "piano"].includes(family)) score += 6;
    if (family === "chinese-vocal") score -= 4;
    if (family === "energy") score -= 10;
  }

  if (tags.includes("sleep")) {
    if (["instrumental", "ost", "piano"].includes(family)) score += 5;
    if (family === "chinese-vocal") score -= 5;
    if (family === "energy") score -= 12;
  }

  if (tags.includes("commute")) {
    if (["chinese-vocal", "ost", "instrumental", "other"].includes(family)) score += 4;
    if (family === "energy") score -= 5;
  }

  if (tags.includes("vocal") && family === "chinese-vocal") score += 6;
  if (tags.includes("radio") && ["instrumental", "ost", "chinese-vocal"].includes(family)) score += 3;
  if (/治愈|轻|chill|calm|healing/.test(text)) score += 2;

  return score;
}

function profileScore(track: Track, docsText: string) {
  const text = normalizeText(`${track.title} ${track.artist} ${track.album}`);
  let score = 0;

  for (const token of [track.title, track.artist].filter((item) => item.length >= 2)) {
    if (docsText.includes(normalizeText(token))) score += token === track.title ? 6 : 4;
  }

  if (/纯音乐|ost|治愈|通勤|中文老歌/.test(docsText) && /纯音乐|ost|piano|钢琴|治愈|中文|国语/i.test(text)) {
    score += 3;
  }

  return Math.min(score, 10);
}

function recentPenalty(track: Track, recent: Track[]) {
  const index = recent.findIndex((item) => item.id === track.id);
  if (index >= 0) return -60 + Math.min(index, 10) * 4;

  const artistIndex = recent.findIndex((item) => item.artist === track.artist);
  return artistIndex >= 0 ? -18 + Math.min(artistIndex, 8) * 2 : 0;
}

function familyTargets(tags: string[]): PlaylistFamily[] {
  if (tags.includes("focus")) return ["instrumental", "ost", "piano", "instrumental", "ost", "other"];
  if (tags.includes("sleep")) return ["instrumental", "piano", "ost", "instrumental", "other"];
  if (tags.includes("commute")) return ["chinese-vocal", "ost", "instrumental", "other", "chinese-vocal", "ost"];
  if (tags.includes("vocal")) return ["chinese-vocal", "chinese-vocal", "ost", "other", "instrumental"];
  return ["instrumental", "ost", "chinese-vocal", "other", "piano"];
}

function rankForPlaylist(tracks: Track[], docsText: string, scene: string, recent: Track[]) {
  const { scores, artistScores, sceneScores } = getTasteScores();
  const tags = sceneTags(scene);

  return tracks
    .map((track): PlaylistCandidate => {
      const family = playlistFamily(track);
      const softSceneScore = tags.reduce((sum, tag) => sum + (sceneScores.get(tag)?.get(track.id) ?? 0), 0);
      const score =
        (scores.get(track.id) ?? 0) +
        (artistScores.get(track.artist) ?? 0) +
        Math.min(softSceneScore, 9) +
        sceneScore(track, family, tags) +
        profileScore(track, docsText) +
        recentPenalty(track, recent) +
        Math.random() * 4;

      return { track, family, score };
    })
    .sort((left, right) => right.score - left.score);
}

function choosePlaylistTracks(ranked: PlaylistCandidate[], count: number, tags: string[]) {
  const result: PlaylistCandidate[] = [];
  const usedIds = new Set<string>();
  const artistCounts = new Map<string, number>();
  const familyCounts = new Map<PlaylistFamily, number>();
  const targets = familyTargets(tags);
  const maxFamilyCount = Math.max(2, Math.ceil(count / 3));

  while (result.length < count) {
    let added = false;

    for (const family of targets) {
      if (result.length >= count) break;
      const candidate = ranked.find((item) => {
        if (item.family !== family || usedIds.has(item.track.id)) return false;
        if ((artistCounts.get(item.track.artist) ?? 0) >= 2) return false;
        if ((familyCounts.get(item.family) ?? 0) >= maxFamilyCount) return false;
        return true;
      });

      if (!candidate) continue;
      result.push(candidate);
      usedIds.add(candidate.track.id);
      artistCounts.set(candidate.track.artist, (artistCounts.get(candidate.track.artist) ?? 0) + 1);
      familyCounts.set(candidate.family, (familyCounts.get(candidate.family) ?? 0) + 1);
      added = true;
    }

    if (!added) break;
  }

  for (const candidate of ranked) {
    if (result.length >= count) break;
    if (usedIds.has(candidate.track.id)) continue;
    if ((artistCounts.get(candidate.track.artist) ?? 0) >= 2) continue;
    result.push(candidate);
    usedIds.add(candidate.track.id);
    artistCounts.set(candidate.track.artist, (artistCounts.get(candidate.track.artist) ?? 0) + 1);
  }

  return result;
}

function pickLine(track: Track, index: number, scene: string) {
  if (index === 0) return `先用 ${track.artist} 的《${track.title}》开场，把${scene || "这段时间"}的气口放稳。`;
  return `第 ${index + 1} 首接 ${track.artist} 的《${track.title}》，让歌单保持一点变化。`;
}

function toPick(candidate: PlaylistCandidate, index: number, scene: string): RadioPick {
  const djLine = pickLine(candidate.track, index, scene);
  return {
    songId: candidate.track.id,
    djLine,
    reason: `playlist workflow: scene=${scene || "default"}; family=${candidate.family}; rank=${index + 1}`,
    moodTags: ["playlist", candidate.family],
    source: "rules",
    segue: index === 0 ? "fade_in" : "direct",
    decision: {
      say: djLine,
      play: [candidate.track.id],
      reason: `playlist workflow selected ${candidate.family}`,
      segue: index === 0 ? "fade_in" : "direct"
    }
  };
}

function parseAgentPlaylist(input: unknown): AgentPlaylist {
  if (typeof input === "string") {
    const text = input.replace(/^\uFEFF/, "").trim();
    try {
      return JSON.parse(text) as AgentPlaylist;
    } catch {
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (!match) throw new Error("未找到有效的 Claudio JSON。");
      return JSON.parse(match[1].replace(/^\uFEFF/, "").trim()) as AgentPlaylist;
    }
  }

  if (input && typeof input === "object") return input as AgentPlaylist;
  throw new Error("无效的歌单 JSON。");
}

function scoreImportedTrack(track: Track, wanted: AgentPlaylistTrack) {
  const title = normalizeMatchText(wanted.title);
  const artist = normalizeMatchText(wanted.artist ?? "");
  const trackTitle = normalizeMatchText(track.title);
  const trackArtist = normalizeMatchText(track.artist);
  const haystack = normalizeMatchText(`${track.title} ${track.artist} ${track.album} ${track.filePath}`);
  const compactTitle = compactMatchText(wanted.title);
  const compactTrackTitle = compactMatchText(track.title);
  const compactHaystack = compactMatchText(`${track.title} ${track.artist} ${track.album} ${track.filePath}`);
  const titleTokens = matchTokens(wanted.title);
  const artistTokens = matchTokens(wanted.artist ?? "");
  let score = 0;

  if (!title) return 0;
  for (const variant of importedTitleVariants(wanted.title)) {
    const variantTitle = normalizeMatchText(variant);
    const compactVariantTitle = compactMatchText(variant);
    const variantTokens = matchTokens(variant);
    if (!variantTitle) continue;

    if (trackTitle === variantTitle || compactTrackTitle === compactVariantTitle) score += 100;
    else if (trackTitle.includes(variantTitle) || compactTrackTitle.includes(compactVariantTitle)) score += 78;
    else if (
      variantTitle.includes(trackTitle) &&
      trackTitle.length >= 5 &&
      (variantTokens.length <= 1 || trackTitle.length / compactVariantTitle.length >= 0.7)
    ) {
      score += 64;
    } else if (haystack.includes(variantTitle) || compactHaystack.includes(compactVariantTitle)) {
      score += 70;
    }

    const variantCoverage = tokenCoverage(variantTokens, haystack);
    if (variantCoverage >= 1) score += 64;
    else if (variantCoverage >= 0.67) score += 52;
    else if (variantCoverage >= 0.5 && compactVariantTitle.length >= 5) score += 38;
  }

  if (artist) {
    if (trackArtist === artist) score += 30;
    else if (trackArtist.includes(artist) || artist.includes(trackArtist)) score += 18;
    else {
      const artistCoverage = tokenCoverage(artistTokens, haystack);
      if (artistCoverage >= 1) score += 16;
      else if (artistCoverage >= 0.5) score += 8;
      else score -= 8;
    }
  }

  return score;
}

function rankImportedTrackMatches(tracks: Track[], wanted: AgentPlaylistTrack, usedIds: Set<string>) {
  return tracks
    .filter((track) => !usedIds.has(track.id))
    .map((track) => ({ track, score: scoreImportedTrack(track, wanted) }))
    .filter((item) => item.score >= 45)
    .sort((left, right) => right.score - left.score);
}

function findImportedTrackMatch(tracks: Track[], wanted: AgentPlaylistTrack, usedIds: Set<string>) {
  const ranked = rankImportedTrackMatches(tracks, wanted, usedIds);
  const [top, second] = ranked;
  if (!top) return undefined;
  if (top.score >= 82) return top.track;
  if (top.score >= 68 && (!second || top.score - second.score >= 10)) return top.track;
  return undefined;
}

function missingCandidates(tracks: Track[], wanted: AgentPlaylistTrack, usedIds: Set<string>) {
  return rankImportedTrackMatches(tracks, wanted, usedIds)
    .slice(0, 3)
    .map((item) => ({
      songId: item.track.id,
      title: item.track.title,
      artist: item.track.artist,
      score: Math.round(item.score),
      playable: item.track.playable,
      source: item.track.source,
      extension: item.track.extension
    }));
}

function importedPick(track: Track, wanted: AgentPlaylistTrack, index: number, scene: string): RadioPick {
  const note = wanted.reason || `来自外部 playlist agent 的第 ${index + 1} 首。`;
  const djLine = `接入歌单：${track.artist} 的《${track.title}》。`;

  return {
    songId: track.id,
    djLine,
    reason: `imported playlist: scene=${scene}; ${note}`,
    moodTags: ["playlist", "imported", wanted.family ?? "agent"],
    source: "rules",
    segue: index === 0 ? "fade_in" : "direct",
    decision: {
      say: djLine,
      play: [track.id],
      reason: `imported playlist matched local track: ${track.artist} - ${track.title}`,
      segue: index === 0 ? "fade_in" : "direct"
    }
  };
}

export function importAgentPlaylist(input: unknown): PlaylistSuggestion {
  const payload = parseAgentPlaylist(input);
  if (payload.schema !== "claudio.playlist.v1") throw new Error("只支持 claudio.playlist.v1 歌单。");
  if (!Array.isArray(payload.tracks) || payload.tracks.length === 0) throw new Error("歌单里没有 tracks。");

  const allTracks = getTracks(2000, "");
  const tracks = allTracks.filter((track) => track.playable);
  const usedIds = new Set<string>();
  const missingTracks: PlaylistSuggestion["missingTracks"] = [];
  const scene = payload.scene || "work";

  const picks = payload.tracks.flatMap((wanted, index) => {
    if (!wanted?.title) {
      missingTracks.push({ title: "(empty)", artist: wanted?.artist, reason: "缺少标题" });
      return [];
    }

    const match = findImportedTrackMatch(tracks, wanted, usedIds);
    if (!match) {
      const candidates = missingCandidates(allTracks, wanted, usedIds);
      const hasOnlyUnplayableCandidates = candidates.length > 0 && candidates.every((candidate) => !candidate.playable);
      missingTracks.push({
        title: wanted.title,
        artist: wanted.artist,
        reason:
          candidates.length > 0
            ? hasOnlyUnplayableCandidates
              ? "本地索引里找到了，但不是浏览器可播放格式"
              : "找到近似候选但置信度不足"
            : "本地曲库未匹配到可播放歌曲",
        candidates
      });
      return [];
    }

    usedIds.add(match.id);
    return [importedPick(match, wanted, index, scene)];
  });

  if (picks.length === 0) throw new Error("导入失败：没有匹配到本地可播放歌曲。");

  return {
    playlistId: `agent-playlist-${Date.now()}`,
    title: payload.title || "Agent 工作歌单",
    scene,
    summary: `已导入 ${picks.length} 首；${missingTracks.length} 首未匹配到本地可播放歌曲。`,
    picks,
    missingTracks,
    source: "rules",
    generatedAt: new Date().toISOString()
  };
}

export function importLatestInboxPlaylist(): PlaylistSuggestion {
  if (!fs.existsSync(latestPlaylistInboxPath)) {
    throw new Error(`没有找到最新歌单：${latestPlaylistInboxPath}`);
  }

  const payload = fs.readFileSync(latestPlaylistInboxPath, "utf8");
  return importAgentPlaylist(payload);
}

export function importPendingInboxPlaylist(): PlaylistSuggestion | null {
  if (!fs.existsSync(pendingPlaylistInboxPath)) return null;

  const payload = fs.readFileSync(pendingPlaylistInboxPath, "utf8");
  return importAgentPlaylist(payload);
}

export async function suggestPlaylist(scene = "", options: PlaylistOptions = {}): Promise<PlaylistSuggestion> {
  const count = 10;
  if (options.useAi !== false) {
    const result = await getRadioDecision(scene, options.weather, count, {
      useAi: true,
      recent: options.recent ? [...getRecentGeneratedPlaylistTracks(80), ...options.recent] : undefined,
      verifyPlayable: options.verifyPlayable
    });
    const picks = result.picks.slice(0, count);
    if (picks.length > 0) {
      if (picks.length < count) {
        throw new Error(`今日歌单暂时只能找到 ${picks.length} 首可播放歌曲，未生成不完整歌单。`);
      }
      const playlist: PlaylistSuggestion = {
        playlistId: `playlist-${Date.now()}`,
        title: scene ? `${scene}姝屽崟` : "Claudio 绉佷汉姝屽崟",
        scene: scene || "绉佷汉鐢靛彴",
        summary: `Claudio generated a temporary queue of ${picks.length} tracks from your scene, taste, and recent listening history.`,
        picks,
        source: picks.some((pick) => pick.source === "ai") ? "ai" : "rules",
        generatedAt: new Date().toISOString()
      };
      if (options.recordHistory !== false) recordGeneratedPlaylistTracks(playlist.playlistId, picks.map((pick) => pick.songId));
      return playlist;
    }
  }
  const tracks = preferApiCatalog(getTracks(5000, "", { playableOnly: true }));
  if (tracks.length === 0) throw new Error("曲库为空，请先扫描音乐目录。");

  const docs = await getUserProfileDocs();
  const docsText = normalizeText(`${docs.taste}\n${docs.routines}\n${docs.moodRules}\n${docs.interviews}`);
  const recent = options.recent
    ? [...getRecentGeneratedPlaylistTracks(80), ...options.recent]
    : [...getRecentGeneratedPlaylistTracks(80), ...getRecentPlays(20), ...getRecentRadioPickTracks(24)];
  const tags = sceneTags(scene);
  const ranked = rankForPlaylist(tracks, docsText, scene, recent);
  const selected = choosePlaylistTracks(ranked, Math.min(count, tracks.length), tags);
  const picks = selected.map((candidate, index) => toPick(candidate, index, scene || "私人电台"));

  const playlist: PlaylistSuggestion = {
    playlistId: `playlist-${Date.now()}`,
    title: scene ? `${scene}歌单` : "Claudio 私人歌单",
    scene: scene || "私人电台",
    summary: `已生成 ${picks.length} 首临时队列；播放期间普通下一首会先消费这条队列，直接点歌可以随时打断。`,
    picks,
    source: "rules",
    generatedAt: new Date().toISOString()
  };
  if (options.recordHistory !== false) recordGeneratedPlaylistTracks(playlist.playlistId, picks.map((pick) => pick.songId));
  return playlist;
}
