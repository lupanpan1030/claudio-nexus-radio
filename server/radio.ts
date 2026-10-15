import { resolveClaudeDecision } from "./claude.js";
import { buildContext } from "./context.js";
import {
  getRecentPlays,
  getRecentGeneratedPlaylistTracks,
  getRecentRadioPickTracks,
  getTasteScores,
  getTasteSummary,
  getTodayPicks,
  getTracks,
  preferApiCatalog,
  recordRecommendationAudit,
  recordRadioPick
} from "./db.js";
import { getUserProfileDocs } from "./userProfile.js";
import { formatWeatherLine } from "./weather.js";
import { resolvePlaybackSource } from "./playback-source.js";
import type {
  ClaudeDecision,
  DailyPlan,
  RadioPick,
  RecommendationAuditCandidate,
  RecommendationScoreBreakdown,
  Track,
  WeatherContext
} from "./types.js";

type RankedTrack = {
  track: Track;
  score: number;
  scoreBreakdown: RecommendationScoreBreakdown;
};

type TrackFamily = "piano" | "ost" | "chinese-vocal" | "energy" | "instrumental" | "other";

type DecisionResult = {
  decision: ClaudeDecision;
  picks: RadioPick[];
  candidates: Track[];
  ranked: RankedTrack[];
};

type RadioDecisionOptions = {
  useAi?: boolean;
  /** Listening recency (most recent first). Defaults to the legacy plays/picks/playlist tables. */
  recent?: Track[];
  /** Playability preflight. Defaults to the legacy KuGou URL resolver. */
  verifyPlayable?: (track: Track) => Promise<boolean>;
};

function sample<T>(items: T[], size: number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy.slice(0, size);
}

function sceneKeywords(text: string) {
  const source = text.toLowerCase();
  const tags: string[] = [];
  if (/通勤|上班|路上|地铁|公交|开车|commute/.test(source)) tags.push("commute");
  if (/健身|跑步|运动|力量|workout|gym|run/.test(source)) tags.push("workout");
  if (/工作|专注|写代码|学习|阅读|focus|work|study/.test(source)) tags.push("focus");
  if (/睡前|失眠|sleep/.test(source)) tags.push("sleep");
  if (/夜晚|晚上|晚间|night|calm/.test(source)) tags.push("night");
  if (/天气|下雨|阴天|冬天|weather|rain/.test(source)) tags.push("weather");
  if (/午休|午饭|中午|lunch|midday/.test(source)) tags.push("lunch");
  if (/清晨|早上|morning/.test(source)) tags.push("morning");
  if (/下午|午后|afternoon|chill/.test(source)) tags.push("afternoon");
  return tags;
}

export function timeSceneTags(now = new Date()) {
  const hour = now.getHours();
  if (hour >= 5 && hour < 8) return ["morning"];
  if ((hour >= 8 && hour < 10) || (hour >= 18 && hour < 20)) return ["commute"];
  if (hour >= 10 && hour < 12) return ["focus"];
  if (hour >= 12 && hour < 14) return ["lunch"];
  if (hour >= 14 && hour < 18) return ["afternoon"];
  if (hour >= 20 && hour < 22) return ["night"];
  if (hour >= 22 || hour < 5) return ["sleep"];
  return [];
}

export function nextSceneTags(query: string, now = new Date()) {
  const explicitTags = sceneKeywords(query);
  return explicitTags.length > 0 ? explicitTags : timeSceneTags(now);
}

function trackFamily(track: Track): TrackFamily {
  const text = `${track.title} ${track.artist} ${track.album}`.toLowerCase();
  if (/钢琴|piano|pianoboy|夜的钢琴曲|kiss the rain|river flows/.test(text)) return "piano";
  if (/ost|soundtrack|久石|radwimps|澤野|sawano|吉森信|key sounds|hoyo-mix|主题曲|映画|movie/.test(text)) return "ost";
  if (/周杰伦|赵雷|孙燕姿|梁静茹|陈奕迅|毛不易|牛奶咖啡|五月天|朴树|罗大佑|中文|国语/.test(text)) {
    return "chinese-vocal";
  }
  if (/beat|rock|edm|remix|epic|victory|star sky|ymca|run|workout/.test(text)) return "energy";
  if (/pure|纯音乐|instrumental|ambient|healing|治愈|calm|serenity|sleep/.test(text)) return "instrumental";
  return "other";
}

function profileKeywordScore(track: Track, profileText: string) {
  const trackText = `${track.title} ${track.artist} ${track.album}`.toLowerCase();
  let score = 0;

  for (const token of [track.artist, track.title].filter(Boolean)) {
    if (token.length >= 2 && profileText.includes(token.toLowerCase())) {
      score += token === track.artist ? 8 : 5;
    }
  }

  if (/纯音乐|ost|piano|钢琴|治愈/.test(profileText) && /ost|piano|钢琴|治愈|instrumental/i.test(trackText)) score += 4;
  if (/安静|舒缓|睡前|不吵/.test(profileText) && /piano|calm|quiet|sleep|ambient|治愈/i.test(trackText)) score += 3;
  if (/有能量|健身|运动/.test(profileText) && /beat|rock|run|edm|remix|epic/i.test(trackText)) score += 3;

  return score;
}

function trackSceneScore(track: Track, sceneTags: string[]) {
  const text = `${track.title} ${track.artist} ${track.album}`.toLowerCase();
  let score = 0;

  for (const tag of sceneTags) {
    if (tag === "workout" && /beat|rock|run|edm|remix|epic|victory/i.test(text)) score += 5;
    if (tag === "commute" && /city|road|morning|travel|journey|起风|晴天|yellow|light/i.test(text)) score += 3;
    if (tag === "focus" && /piano|ost|instrumental|ambient|study|纯音乐/i.test(text)) score += 4;
    if (tag === "sleep" && /piano|sleep|quiet|calm|ambient|治愈/i.test(text)) score += 5;
    if (tag === "night" && /ost|piano|instrumental|ambient|治愈|中文|国语|light|calm/i.test(text)) score += 3;
    if (tag === "lunch" && /bossa|city|light|jazz|day/i.test(text)) score += 3;
    if (tag === "morning" && /morning|sun|day|light|piano/i.test(text)) score += 3;
    if (tag === "afternoon" && /chill|light|jazz|day|ambient|ost|纯音乐|治愈/i.test(text)) score += 3;
  }

  return score;
}

function artistTokens(artist: string) {
  return artist
    .toLowerCase()
    .split(/[、,，/&+;；]/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token !== "unknown artist");
}

function sharesArtist(left: Track, right: Track) {
  const leftTokens = artistTokens(left.artist);
  if (leftTokens.length === 0) return left.artist === right.artist;
  const rightTokens = new Set(artistTokens(right.artist));
  return leftTokens.some((token) => rightTokens.has(token));
}

function normalizedTitleForRepeat(title: string) {
  return title
    .toLowerCase()
    .replace(/[（(]\s*\d+\s*[)）]/g, "")
    .replace(/\s+/g, "")
    .replace(/[《》"'`“”‘’()[\]（）【】{}.,，。!！?？:：;；\-_/\\]/g, "");
}

function isNearTrackRepeat(track: Track, recentTrack: Track) {
  return sharesArtist(track, recentTrack) && normalizedTitleForRepeat(track.title) === normalizedTitleForRepeat(recentTrack.title);
}

export function calculateRecencyBreakdown(track: Track, recent: Track[]) {
  const recentIndex = recent.findIndex((item) => item.id === track.id || isNearTrackRepeat(track, item));
  const trackPenalty = recentIndex >= 0 ? Math.min(0, -80 + recentIndex * 3) : 0;

  const recentArtistWindow = recent.slice(0, 20);
  const artistIndexes = recentArtistWindow
    .map((item, index) => (sharesArtist(track, item) ? index : -1))
    .filter((index) => index >= 0);
  const artistPenalty =
    artistIndexes.length > 0
      ? Math.max(-72, -32 + Math.min(artistIndexes[0], 12) * 2 - Math.max(0, artistIndexes.length - 1) * 14)
      : 0;

  const artistIndex = recent.findIndex((item) => item.artist === track.artist);
  const exactArtistPenalty = artistIndex >= 0 ? -20 + Math.min(artistIndex, 7) * 2 : 0;

  const family = trackFamily(track);
  const recentFamilyWindow = recent.slice(0, 8).map(trackFamily);
  const familyIndex = recentFamilyWindow.findIndex((item) => item === family);
  const familyCount = recentFamilyWindow.filter((item) => item === family).length;
  const familyPenalty =
    familyIndex >= 0 ? Math.max(-30, -12 + Math.min(familyIndex, 4) - Math.max(0, familyCount - 1) * 5) : 0;

  return {
    track_repeat: trackPenalty,
    artist_repeat: Math.min(artistPenalty, exactArtistPenalty),
    family_repeat: familyPenalty
  };
}

function diversityScore(track: Track, sceneTags: string[]) {
  const family = trackFamily(track);
  if ((sceneTags.includes("sleep") || sceneTags.includes("focus")) && family === "piano") return 4;
  if ((sceneTags.includes("sleep") || sceneTags.includes("focus")) && family === "energy") return -10;
  if (sceneTags.includes("night") && family === "energy") return -8;
  if (sceneTags.includes("night") && ["ost", "chinese-vocal", "instrumental", "other"].includes(family)) return 3;
  if (sceneTags.includes("sleep") && family === "chinese-vocal") return -4;
  if (!sceneTags.includes("workout") && family === "energy") return -6;
  if (sceneTags.includes("commute") && ["chinese-vocal", "ost", "instrumental", "other"].includes(family)) return 3;
  if (sceneTags.includes("afternoon") && ["instrumental", "ost", "other"].includes(family)) return 2;
  if (sceneTags.includes("morning") && ["instrumental", "ost", "chinese-vocal"].includes(family)) return 2;
  if (family === "piano") return -4;
  if (family === "chinese-vocal") return 2;
  if (family === "ost") return 2;
  return 0;
}

function roundScore(value: number) {
  return Math.round(value * 100) / 100;
}

function sumScoreBreakdown(breakdown: RecommendationScoreBreakdown) {
  return Object.values(breakdown).reduce((sum, value) => sum + value, 0);
}

function clampScore(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function frontFamilyCaps(sceneTags: string[]): Record<TrackFamily, number> {
  if (sceneTags.includes("workout")) {
    return {
      piano: 1,
      ost: 3,
      "chinese-vocal": 4,
      energy: 6,
      instrumental: 2,
      other: 4
    };
  }

  if (sceneTags.includes("sleep")) {
    return {
      piano: 4,
      ost: 5,
      "chinese-vocal": 1,
      energy: 0,
      instrumental: 4,
      other: 3
    };
  }

  if (sceneTags.includes("focus")) {
    return {
      piano: 4,
      ost: 5,
      "chinese-vocal": 1,
      energy: 0,
      instrumental: 5,
      other: 3
    };
  }

  if (sceneTags.includes("night")) {
    return {
      piano: 2,
      ost: 5,
      "chinese-vocal": 4,
      energy: 1,
      instrumental: 4,
      other: 4
    };
  }

  if (sceneTags.includes("commute")) {
    return {
      piano: 2,
      ost: 5,
      "chinese-vocal": 5,
      energy: 1,
      instrumental: 4,
      other: 4
    };
  }

  if (sceneTags.includes("morning")) {
    return {
      piano: 3,
      ost: 5,
      "chinese-vocal": 3,
      energy: 1,
      instrumental: 5,
      other: 4
    };
  }

  if (sceneTags.includes("afternoon") || sceneTags.includes("lunch")) {
    return {
      piano: 3,
      ost: 5,
      "chinese-vocal": 3,
      energy: 1,
      instrumental: 5,
      other: 5
    };
  }

  return {
    piano: 2,
    ost: 4,
    "chinese-vocal": 4,
    energy: 1,
    instrumental: 4,
    other: 4
  };
}

const defaultFamilyTargets: Record<TrackFamily, number> = {
  piano: 0.12,
  ost: 0.22,
  "chinese-vocal": 0.26,
  energy: 0.02,
  instrumental: 0.26,
  other: 0.12
};

const defaultFamilyTieBreak: TrackFamily[] = ["instrumental", "ost", "chinese-vocal", "other", "piano", "energy"];

function defaultFamilyOrder(recent: Track[]): TrackFamily[] {
  const window = recent.slice(0, 10).map(trackFamily);
  const counts = new Map<TrackFamily, number>();
  for (const family of window) {
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }

  const repeatedFamily = window.length >= 2 && window[0] === window[1] ? window[0] : undefined;
  const windowSize = Math.max(6, window.length || 6);

  return defaultFamilyTieBreak
    .map((family, index) => {
      const targetCount = defaultFamilyTargets[family] * windowSize;
      const actualCount = counts.get(family) ?? 0;
      const repeatPenalty = family === repeatedFamily ? 2 : 0;
      return {
        family,
        score: targetCount - actualCount - repeatPenalty - index * 0.01
      };
    })
    .sort((left, right) => right.score - left.score)
    .map((item) => item.family);
}

function recentDominantFamily(recent: Track[]): TrackFamily | undefined {
  const window = recent.slice(0, 4).map(trackFamily);
  if (window.length >= 2 && window[0] === window[1]) return window[0];

  for (const family of new Set(window)) {
    if (window.filter((item) => item === family).length >= 3) return family;
  }

  return undefined;
}

function avoidRecentFamilyFront(order: TrackFamily[], recent: Track[]) {
  const dominant = recentDominantFamily(recent);
  if (!dominant) return order;

  const kept = order.filter((family) => family !== dominant);
  const delayed = order.filter((family) => family === dominant);
  return [...kept, ...delayed];
}

function frontFamilyOrder(sceneTags: string[], recent: Track[] = []): TrackFamily[] {
  let order: TrackFamily[];

  if (sceneTags.includes("workout")) {
    order = ["energy", "chinese-vocal", "ost", "other", "energy", "instrumental", "energy", "chinese-vocal", "piano"];
    return avoidRecentFamilyFront(order, recent);
  }

  if (sceneTags.includes("sleep")) {
    order = ["instrumental", "ost", "piano", "ost", "instrumental", "piano", "other"];
    return avoidRecentFamilyFront(order, recent);
  }

  if (sceneTags.includes("focus")) {
    order = ["instrumental", "ost", "piano", "instrumental", "ost", "other", "piano"];
    return avoidRecentFamilyFront(order, recent);
  }

  if (sceneTags.includes("night")) {
    order = ["ost", "chinese-vocal", "instrumental", "other", "ost", "chinese-vocal", "piano", "instrumental"];
    return avoidRecentFamilyFront(order, recent);
  }

  if (sceneTags.includes("commute")) {
    order = ["chinese-vocal", "ost", "instrumental", "other", "chinese-vocal", "ost", "instrumental", "piano"];
    return avoidRecentFamilyFront(order, recent);
  }

  if (sceneTags.includes("morning")) {
    order = ["instrumental", "ost", "other", "chinese-vocal", "piano", "instrumental", "ost"];
    return avoidRecentFamilyFront(order, recent);
  }

  if (sceneTags.includes("afternoon") || sceneTags.includes("lunch")) {
    order = ["instrumental", "other", "ost", "chinese-vocal", "instrumental", "piano", "ost"];
    return avoidRecentFamilyFront(order, recent);
  }

  return defaultFamilyOrder(recent);
}

function canAddWithCaps(
  item: RankedTrack,
  artistCounts: Map<string, number>,
  familyCounts: Map<TrackFamily, number>,
  familyCaps: Partial<Record<TrackFamily, number>>,
  artistLimit: number
) {
  const family = trackFamily(item.track);
  const artistCount = artistCounts.get(item.track.artist) ?? 0;
  const familyCount = familyCounts.get(family) ?? 0;
  const familyCap = familyCaps[family];
  return artistCount < artistLimit && (familyCap === undefined || familyCount < familyCap);
}

function addRanked(
  result: RankedTrack[],
  item: RankedTrack,
  artistCounts: Map<string, number>,
  familyCounts: Map<TrackFamily, number>
) {
  const family = trackFamily(item.track);
  result.push(item);
  artistCounts.set(item.track.artist, (artistCounts.get(item.track.artist) ?? 0) + 1);
  familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
}

function diversifyRanked(ranked: RankedTrack[], limit: number, sceneTags: string[], recent: Track[] = []) {
  const result: RankedTrack[] = [];
  const artistCounts = new Map<string, number>();
  const familyCounts = new Map<TrackFamily, number>();
  const frontLimit = Math.min(limit, 20);
  const frontCaps = frontFamilyCaps(sceneTags);
  const frontOrder = frontFamilyOrder(sceneTags, recent);
  const fullFamilyLimit = Math.max(3, Math.ceil(limit / 5));

  while (result.length < frontLimit) {
    let added = false;

    for (const family of frontOrder) {
      if (result.length >= frontLimit) break;
      const item = ranked.find(
        (candidate) =>
          trackFamily(candidate.track) === family &&
          !result.some((existing) => existing.track.id === candidate.track.id) &&
          canAddWithCaps(candidate, artistCounts, familyCounts, frontCaps, 2)
      );

      if (!item) continue;
      addRanked(result, item, artistCounts, familyCounts);
      added = true;
    }

    if (!added) break;
  }

  for (const item of ranked) {
    if (result.length >= frontLimit) break;
    if (result.some((existing) => existing.track.id === item.track.id)) continue;
    if (!canAddWithCaps(item, artistCounts, familyCounts, {}, 2)) continue;

    addRanked(result, item, artistCounts, familyCounts);
  }

  for (const item of ranked) {
    if (result.length >= limit) break;
    if (result.some((existing) => existing.track.id === item.track.id)) continue;
    if (
      !canAddWithCaps(
        item,
        artistCounts,
        familyCounts,
        {
          piano: fullFamilyLimit,
          ost: fullFamilyLimit,
          "chinese-vocal": fullFamilyLimit,
          energy: fullFamilyLimit,
          instrumental: fullFamilyLimit,
          other: fullFamilyLimit
        },
        2
      )
    ) {
      continue;
    }

    addRanked(result, item, artistCounts, familyCounts);
  }

  for (const item of ranked) {
    if (result.length >= limit) break;
    if (result.some((existing) => existing.track.id === item.track.id)) continue;
    addRanked(result, item, artistCounts, familyCounts);
  }

  return result;
}

function recentlySeenTrack(item: RankedTrack) {
  return item.scoreBreakdown.track_repeat < 0 || item.scoreBreakdown.artist_repeat <= -50;
}

function weightedSampleFromRanked(ranked: RankedTrack[], poolSize: number) {
  const pool = ranked.slice(0, Math.max(1, Math.min(poolSize, ranked.length)));
  const minScore = Math.min(...pool.map((item) => item.score));
  const weights = pool.map((item, index) => Math.max(1, item.score - minScore + 1) / (index + 1));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cursor = Math.random() * total;

  for (let index = 0; index < pool.length; index += 1) {
    cursor -= weights[index];
    if (cursor <= 0) return pool[index];
  }

  return pool[0];
}

function chooseNextTrack(ranked: RankedTrack[]) {
  const fresh = ranked.filter((item) => !recentlySeenTrack(item));
  return weightedSampleFromRanked(fresh.length >= 8 ? fresh : ranked, 10).track;
}

function sceneTasteScore(trackId: string, sceneTags: string[], sceneScores: Map<string, Map<string, number>>) {
  const sceneAliases = new Map<string, string[]>([
    ["commute", ["commute"]],
    ["morning", ["morning"]],
    ["focus", ["focus", "work"]],
    ["sleep", ["sleep"]],
    ["night", ["sleep", "focus"]],
    ["workout", ["other"]],
    ["afternoon", ["focus", "other"]],
    ["lunch", ["other"]]
  ]);

  let score = 0;
  for (const tag of sceneTags) {
    const aliases = sceneAliases.get(tag) ?? [tag];
    for (const alias of aliases) {
      score += sceneScores.get(alias)?.get(trackId) ?? 0;
    }
  }

  return clampScore(score, 0, 9);
}

async function rankCandidates(tracks: Track[], recent: Track[], query: string) {
  const { scores, artistScores, sceneScores } = getTasteScores();
  const docs = await getUserProfileDocs();
  const profileText = `${docs.taste}\n${docs.routines}\n${docs.moodRules}`.toLowerCase();
  const sceneTags = nextSceneTags(query);

  return tracks
    .map((track): RankedTrack => {
      const tasteScore = clampScore(scores.get(track.id) ?? 0, -12, 12);
      const artistScore = clampScore(artistScores.get(track.artist) ?? 0, -5, 5);
      const sceneTaste = sceneTasteScore(track.id, sceneTags, sceneScores);
      const recentScore = calculateRecencyBreakdown(track, recent);
      const sceneScore = trackSceneScore(track, sceneTags);
      const profileScore = clampScore(profileKeywordScore(track, profileText), 0, 8);
      const varietyScore = diversityScore(track, sceneTags);
      const jitter = Math.random() * 5;
      const scoreBreakdown = {
        taste_like: roundScore(tasteScore),
        artist_taste: roundScore(artistScore),
        scene_taste: roundScore(sceneTaste),
        track_repeat: roundScore(recentScore.track_repeat),
        artist_repeat: roundScore(recentScore.artist_repeat),
        family_repeat: roundScore(recentScore.family_repeat),
        scene_match: roundScore(sceneScore),
        profile_match: roundScore(profileScore),
        family_mix: roundScore(varietyScore),
        jitter: roundScore(jitter)
      };
      return {
        track,
        score: roundScore(sumScoreBreakdown(scoreBreakdown)),
        scoreBreakdown
      };
    })
    .sort((left, right) => right.score - left.score);
}

function buildFallbackDecision(tracks: Track[], query: string, weather?: WeatherContext): ClaudeDecision {
  const selected = tracks.slice(0, Math.max(1, tracks.length));
  const primary = selected[0];
  const tags = nextSceneTags(query);
  const weatherLine = formatWeatherLine(weather) || "current environment unavailable";
  const sceneLine = tags.length > 0 ? `scene tags ${tags.join(" / ")}` : "scene unclear";

  return {
    say: primary ? `先接一首 ${primary.artist} 的《${primary.title}》。` : "我先替你接一首稳一点的。",
    play: selected.map((track) => track.id),
    reason: `fallback next-track decision; ${weatherLine}; ${sceneLine}`,
    segue: "fade_in"
  };
}

const weatherImageryPattern = /雨|阴天|晴天|阳光|云层|乌云|天气|气温|温度|季节|春天|夏天|秋天|冬天|雪|雷/;
const genericDjLinePattern =
  /^(接下来|放松一下|温柔的旋律|午后适合|下午适合|来一首|来首|听首|换一首|换一段|这首歌|这一首|很适合|陪着你|送你一首)/;

function normalizeDjLineOpening(line: string) {
  return line
    .replace(/[《》“”"'`，。！？、,.!?;；：:\s-]+/g, "")
    .slice(0, 6);
}

function repeatsRecentDjLine(line: string, recentLines: string[]) {
  const opening = normalizeDjLineOpening(line);
  if (opening.length < 4) return false;
  return recentLines.some((recent) => normalizeDjLineOpening(recent) === opening);
}

function trackHash(value: string) {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

function localDjLine(track: Track, recentLines: string[] = []) {
  const family = trackFamily(track);
  const variants: Record<TrackFamily, string[]> = {
    piano: [
      "把声音收轻一点，让这首曲子留出安静的空间。",
      "这一首不急着往前推，适合把注意力慢慢放下来。",
      "这里不需要太多起伏，留一点清澈的琴声就够了。",
      "让旋律走得慢一些，刚好避开太满的情绪。"
    ],
    ost: [
      "换一段更有画面感的旋律，但情绪不往满处推。",
      "这首的线条比较柔和，可以把上一首的余味自然接住。",
      "这里适合一点有轮廓的器乐，轻轻把空间打开。",
      "让配器多一点层次，但整体仍然保持克制。"
    ],
    "chinese-vocal": [
      "这一轮换回人声，让熟悉的旋律把节奏拉稳。",
      "给你一点中文老歌的质感，不抢，也不硬煽情。",
      "人声进来一点就好，重点还是让旋律耐听。",
      "这里用一首中文歌换气，情绪保持在舒服的位置。"
    ],
    energy: [
      "这首会把节奏稍微抬起来，但不会一下子推得太猛。",
      "这里需要一点更清晰的律动，先轻轻把能量拉上来。",
      "节奏可以更明确一点，但仍然不往吵的方向走。",
      "把速度感加一点，保持干净，不做过度推进。"
    ],
    instrumental: [
      "给耳朵留一点干净的底色，这首更适合慢慢进入。",
      "这一首更克制，适合让背景变得清爽一点。",
      "先用器乐把注意力稳住，不让旋律占满空间。",
      "这首适合做一层淡背景，存在感轻，但不空。"
    ],
    other: [
      "这次换一个不太相同的颜色，让上一首的余味自然转开。",
      "换个方向走一小步，保持稳定，也保留一点新鲜感。",
      "这里不追求强刺激，只需要一点不同的纹理。",
      "让风格稍微偏开一点，避免一路听成同一种颜色。"
    ]
  };
  const options = variants[family];
  const offset = trackHash(track.id) % options.length;
  for (let index = 0; index < options.length; index += 1) {
    const line = options[(offset + index) % options.length];
    if (!repeatsRecentDjLine(line, recentLines)) return line;
  }
  return options[offset];
}

function buildRulesDecision(tracks: Track[], recentLines: string[], sceneTags: string[]): ClaudeDecision {
  const selected = tracks.slice(0, Math.max(1, tracks.length));
  const primary = selected[0];
  const sceneLine = sceneTags.length > 0 ? `scene tags ${sceneTags.join(" / ")}` : "scene unclear";
  return {
    say: primary ? localDjLine(primary, recentLines) : "先留一点安静的空间，我再接一首稳的。",
    play: selected.map((track) => track.id),
    reason: `rules next-track decision; local ranked candidate; ${sceneLine}`,
    segue: "fade_in"
  };
}

function guardDjLine(decision: ClaudeDecision, track: Track, weather: WeatherContext | undefined, recentLines: string[]) {
  const say = decision.say.trim();
  const shouldReplace =
    !say ||
    genericDjLinePattern.test(say) ||
    (!weather && weatherImageryPattern.test(say)) ||
    repeatsRecentDjLine(say, recentLines);

  return shouldReplace
    ? {
        ...decision,
        say: localDjLine(track, recentLines)
      }
    : decision;
}

function mapDecisionToPick(track: Track, decision: ClaudeDecision, source: "ai" | "rules"): RadioPick {
  const moodTags = [...new Set([...sceneKeywords(decision.reason), "next"])].slice(0, 5);
  return {
    songId: track.id,
    djLine: decision.say,
    reason: decision.reason,
    moodTags: moodTags.length > 0 ? moodTags : ["next"],
    source,
    segue: decision.segue,
    decision
  };
}

function auditCandidate(item: RankedTrack): RecommendationAuditCandidate {
  return {
    songId: item.track.id,
    title: item.track.title,
    artist: item.track.artist,
    album: item.track.album,
    family: trackFamily(item.track),
    source: item.track.source,
    score: item.score,
    scoreBreakdown: item.scoreBreakdown
  };
}

function recordNextAudit(query: string, pick: RadioPick, ranked: RankedTrack[]) {
  const selected = ranked.find((item) => item.track.id === pick.songId);
  if (!selected) return;

  recordRecommendationAudit({
    mode: "next",
    query,
    selectedSongId: selected.track.id,
    selectedTitle: selected.track.title,
    selectedArtist: selected.track.artist,
    family: trackFamily(selected.track),
    source: pick.source,
    djLine: pick.djLine,
    reason: pick.reason,
    scoreBreakdown: selected.scoreBreakdown,
    candidates: ranked.slice(0, 12).map(auditCandidate)
  });
}

function legacyRecentTracks() {
  return uniqueRecentTracks([
    ...getRecentGeneratedPlaylistTracks(80),
    ...getRecentPlays(18),
    ...getRecentRadioPickTracks(36)
  ]);
}

async function getRankedPool(query: string, size: number, recentOverride?: Track[]) {
  const tracks = getTracks(2000, query, { playableOnly: true });
  const sourceTracks = tracks.length > 0 ? tracks : getTracks(5000, "", { playableOnly: true });
  const apiPreferred = preferApiCatalog(sourceTracks);
  const allTracks = apiPreferred;
  if (allTracks.length === 0) {
    throw new Error("曲库为空，请先扫描音乐目录。");
  }

  const recent = recentOverride ? uniqueRecentTracks(recentOverride) : legacyRecentTracks();
  const sceneTags = nextSceneTags(query);
  const ranked = diversifyRanked(await rankCandidates(allTracks, recent, query), Math.min(size, allTracks.length), sceneTags, recent);
  return {
    ranked,
    candidates: ranked.map((item) => item.track)
  };
}

async function legacyVerifyPlayable(track: Track) {
  try {
    await resolvePlaybackSource(track.id);
    return true;
  } catch {
    return false;
  }
}

async function keepTracksWithPlaybackSource(
  ranked: RankedTrack[],
  minimum: number,
  verifyPlayable: (track: Track) => Promise<boolean> = legacyVerifyPlayable
) {
  const available: RankedTrack[] = [];
  const batchSize = 8;
  // Keep the API-backed preflight bounded; GPT still makes the final choice.
  const maxChecks = Math.min(ranked.length, 240);

  for (let start = 0; start < maxChecks && available.length < minimum; start += batchSize) {
    const batch = ranked.slice(start, start + batchSize);
    const resolved = await Promise.all(
      batch.map(async (item) => ((await verifyPlayable(item.track).catch(() => false)) ? item : null))
    );
    available.push(...resolved.filter((item): item is RankedTrack => item !== null));
  }

  return available;
}

function uniqueRecentTracks(tracks: Track[]) {
  const seen = new Set<string>();
  const result: Track[] = [];
  for (const track of tracks) {
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    result.push(track);
  }
  return result;
}

function uniquePicks(picks: RadioPick[], usedSongIds: Set<string>) {
  const result: RadioPick[] = [];
  for (const pick of picks) {
    if (usedSongIds.has(pick.songId)) continue;
    usedSongIds.add(pick.songId);
    result.push(pick);
  }
  return result;
}

function recentDjLines(limit = 6) {
  return getTodayPicks()
    .map((pick) => pick.djLine.trim())
    .filter(Boolean)
    .slice(0, limit);
}

export async function getRadioDecision(
  query = "",
  weather?: WeatherContext,
  count = 1,
  options: RadioDecisionOptions = {}
): Promise<DecisionResult> {
  const cleanCount = Math.max(1, Math.min(count, 12));
  const recentLines = recentDjLines();
  const { ranked } = await getRankedPool(query, cleanCount > 1 ? 120 : 80, options.recent);
  const preflightRanked = await keepTracksWithPlaybackSource(
    ranked,
    Math.max(cleanCount + 4, cleanCount * 2),
    options.verifyPlayable
  );
  if (preflightRanked.length < cleanCount) {
    throw new Error("No tracks with a verified playback source are available.");
  }
  const candidates = preflightRanked.map((item) => item.track);
  const sceneTags = nextSceneTags(query);
  const fallbackPool = preflightRanked;
  const fallbackTracks = options.useAi
    ? sample(fallbackPool.slice(0, Math.min(cleanCount > 1 ? 18 : 14, fallbackPool.length)).map((item) => item.track), cleanCount)
      : cleanCount === 1
      ? [chooseNextTrack(fallbackPool)]
      : fallbackPool.slice(0, cleanCount).map((item) => item.track);
  const fallbackDecision = options.useAi
    ? buildFallbackDecision(fallbackTracks, query, weather)
    : buildRulesDecision(fallbackTracks, recentLines, sceneTags);

  let decision = fallbackDecision;
  if (options.useAi) {
    const docs = await getUserProfileDocs();
    const context = await buildContext({
      mode: cleanCount > 1 ? "queue" : "next",
      userMessage: query || (cleanCount > 1 ? "请预排一个短队列" : "请推荐下一首"),
      weather,
      candidates,
      docs,
      toolResults: [
        `Taste events available: ${getTasteSummary(10).length}`,
        cleanCount > 6 ? "Current mode is full playlist planning" : "Current mode is next-track recommendation only",
        "Candidate list has been diversified by recency, artist, and style family",
        "Playlist balance from user taste.md: about 40% instrumental, 30% Chinese/classic vocal, 30% other vocal or mixed tracks",
        "DJ line should explain current fit through listening feel, scene, or user taste; do not mention source/background facts",
        weather ? `Weather is available: ${formatWeatherLine(weather)}` : "Weather is intentionally unavailable for this next pick",
        recentLines.length > 0 ? `Recent DJ lines to avoid copying: ${recentLines.join(" / ")}` : "No recent DJ lines"
      ],
      systemState: [
        "Keep current API surface compatible",
        "Return strict JSON decision",
        cleanCount > 6 ? "Choose a full playlist with varied listening colors" : "Choose track IDs only for the next-track or short-queue workflow",
        "Avoid repeating recent songs, recent artists, and near-identical piano/healing colors",
        "For a 10-track playlist, keep roughly 4 instrumental tracks, 3 Chinese/classic vocal tracks, and 3 other vocal or mixed tracks",
        "For say: one or two restrained Chinese sentences; no song origin, film/game/anime source, artist biography, release history, chart data, or production story",
        "Do not reuse recent DJ line openings or the same sentence skeleton",
        weather ? "Weather imagery is allowed only when it matches the provided weather" : "Do not mention rain, weather, clouds, sunshine, temperature, or season"
      ],
      queue: [],
      currentTrack: null,
      includeRecentChat: false,
      includeLongTermMemory: false,
      includeInterviewTail: false
    });

    decision = await resolveClaudeDecision({
      context,
      candidateIds: candidates.map((track) => track.id),
      fallbackDecision,
      preferredCount: cleanCount,
      label: cleanCount > 1 ? "radio-queue" : "radio-next"
    });
  }

  const candidateMap = new Map(candidates.map((track) => [track.id, track]));
  let validTracks = decision.play.map((id) => candidateMap.get(id)).filter((track): track is Track => Boolean(track));
  let playableRanked = preflightRanked;
  if (options.useAi && validTracks.length < cleanCount) {
    const selectedIds = new Set(validTracks.map((track) => track.id));
    const refill = preflightRanked
      .map((item) => item.track)
      .filter((track) => !selectedIds.has(track.id))
      .slice(0, cleanCount - validTracks.length);
    validTracks = [...validTracks, ...refill];
    decision = { ...decision, play: validTracks.map((track) => track.id) };
  }
  const source: "ai" | "rules" =
    options.useAi && !decision.reason.startsWith("fallback next-track decision") ? "ai" : "rules";
  const guardedDecision = validTracks[0] ? guardDjLine(decision, validTracks[0], weather, recentLines) : decision;
  const picks = validTracks.map((track) => mapDecisionToPick(track, guardedDecision, source));

  return {
    decision,
    picks,
    candidates,
    ranked: playableRanked
  };
}

export type RadioCandidateChoice = {
  track: Track;
  reason: string;
  ranked: Array<{ id: string; score: number }>;
};

/**
 * Side-effect-free rules choice of one next track for the v1 preparation
 * path: no playback preflight, no radio_picks/audit/plays writes. Recency is
 * supplied by the caller (confirmed listens first); excluded ids are hard
 * filters (reserved or recently failed candidates).
 */
export async function chooseRadioCandidate(options: {
  recentTrackIds: readonly string[];
  excludeTrackIds: ReadonlySet<string>;
  query?: string;
}): Promise<RadioCandidateChoice | null> {
  const query = options.query ?? "";
  const pool = preferApiCatalog(getTracks(5000, "", { playableOnly: true })).filter(
    (track) => !options.excludeTrackIds.has(track.id)
  );
  if (pool.length === 0) return null;
  const byId = new Map(getTracks(5000, "", {}).map((track) => [track.id, track]));
  const recent = uniqueRecentTracks(
    options.recentTrackIds.map((id) => byId.get(id)).filter((track): track is Track => Boolean(track))
  );
  const sceneTags = nextSceneTags(query);
  const ranked = diversifyRanked(await rankCandidates(pool, recent, query), Math.min(80, pool.length), sceneTags, recent);
  if (ranked.length === 0) return null;
  const track = chooseNextTrack(ranked);
  const sceneLine = sceneTags.length > 0 ? `scene tags ${sceneTags.join(" / ")}` : "scene unclear";
  return {
    track,
    reason: `rules next-track candidate; ${sceneLine}`,
    ranked: ranked.slice(0, 12).map((item) => ({ id: item.track.id, score: item.score }))
  };
}

export async function nextRadioPick(
  query = "",
  weather?: WeatherContext,
  options: RadioDecisionOptions = {}
): Promise<RadioPick> {
  const result = await getRadioDecision(query, weather, 1, options);
  const pick = result.picks[0];
  if (!pick) {
    throw new Error("没有可用的下一首推荐。");
  }
  recordRadioPick(pick);
  recordNextAudit(query, pick, result.ranked);
  return pick;
}

export async function nextRadioQueue(
  query = "",
  weather?: WeatherContext,
  count = 4,
  options: RadioDecisionOptions = {}
): Promise<RadioPick[]> {
  const result = await getRadioDecision(query, weather, count, options);
  const picks = uniquePicks(result.picks, new Set<string>()).slice(0, Math.max(1, Math.min(count, result.picks.length)));
  for (const pick of picks) {
    recordRadioPick(pick);
  }
  return picks;
}

export async function planToday(message: string, weather?: WeatherContext): Promise<{ dailyPlan?: DailyPlan; reply: string }> {
  const context = formatWeatherLine(weather);
  return {
    reply: `歌单推荐会作为独立流程接入，暂时不复用下一首推荐链路。${
      context ? `当前天气上下文已收到：${context}。` : ""
    }请求已保留：${message}`
  };
}
