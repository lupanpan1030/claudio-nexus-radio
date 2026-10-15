import type { CatalogSearchPort } from "./catalog.js";
import type { ClaudeDecision, RadioPick, TrackRecord } from "./types.js";

type ScoredTrack = {
  track: TrackRecord;
  score: number;
};

export type DirectTrackResolution = {
  intent: boolean;
  query: string;
  match?: TrackRecord;
  candidates: TrackRecord[];
  reason: "matched" | "ambiguous" | "not-found" | "api-unavailable" | "no-intent";
};

const directIntentPattern = /播放|点歌|放一首|放一个|来一首|听一首|听一个|我想听|想听|要听|play/i;
const recommendationPattern = /推荐|适合|通勤|健身|睡前|工作|学习|随便|来点|歌单|播放列表|电台|playlist/i;
const queueInsertPattern = /(?:\u628a\s*)?(.+?)\s*(?:\u63d2\u5230|\u63d2\u5165|\u63d2\u961f\u5230|\u52a0\u5165|\u653e\u8fdb)\s*(?:\u4e0b\u4e00\u9996|\u961f\u5217)/;

function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/[“”"'`[\]()（）【】]/g, " ")
    .replace(/[，。！？、,.!?;；：:\\|-]+/g, " ")
    .replace(/\s*的\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactSearchText(value: string) {
  return normalizeSearchText(value).replace(/\s+/g, "");
}

function titleWithoutDescriptiveSuffix(value: string) {
  return value
    .replace(/\s*[\(\[（【][^\)\]）】]*[\)\]）】]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSpecificContainedTitle(title: string) {
  return title.length >= 4 || /[\u4e00-\u9fff\u3040-\u30ff]/.test(title);
}

export function hasDirectPlaybackIntent(message: string) {
  return (directIntentPattern.test(message) || queueInsertPattern.test(message)) && !recommendationPattern.test(message);
}

export function extractDirectSongQuery(message: string) {
  const clean = message.replace(/[“”"'`]/g, " ").trim();
  const queueInsert = clean.match(queueInsertPattern)?.[1]?.trim();
  if (queueInsert && queueInsert.length >= 2 && queueInsert.length <= 80 && !recommendationPattern.test(queueInsert)) {
    return queueInsert;
  }
  const patterns = [
    /(?:播放|点歌|放一首|放一个|来一首|听一首|听一个|play)\s*(.+)/i,
    /(?:我想听|想听|要听)\s*(.+)/,
    /(?:把)\s*(.+?)\s*(?:播放|放一首|接上)/
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    const query = match?.[1]
      ?.replace(/^(这个|这首|一下|给我|帮我)\s*/, "")
      .replace(/\s*的\s+/g, " ")
      .replace(/(加入|加到|放进|排到|下一首|播放列表|队列|歌单).*$/, "")
      .trim();

    if (query && query.length >= 2 && query.length <= 80 && !recommendationPattern.test(query)) {
      return query;
    }
  }

  return "";
}

function scoreTrack(track: TrackRecord, query: string) {
  const normalizedQuery = normalizeSearchText(query);
  const title = normalizeSearchText(titleWithoutDescriptiveSuffix(track.title));
  const artist = normalizeSearchText(track.artist);
  const album = normalizeSearchText(track.album);
  const artistTitle = normalizeSearchText(`${track.artist} ${track.title}`);
  const titleArtist = normalizeSearchText(`${track.title} ${track.artist}`);
  const haystack = normalizeSearchText(`${track.title} ${track.artist} ${track.album}`);
  const compactQuery = compactSearchText(query);
  const compactTitle = compactSearchText(titleWithoutDescriptiveSuffix(track.title));
  const compactArtistTitle = compactSearchText(`${track.artist}${track.title}`);
  const compactTitleArtist = compactSearchText(`${track.title}${track.artist}`);
  const compactHaystack = compactSearchText(`${track.title}${track.artist}${track.album}`);
  const tokens = normalizedQuery.split(" ").filter((token) => token.length >= 2);

  if (!normalizedQuery) return 0;
  if (title === normalizedQuery) return 100;
  if (compactTitle === compactQuery) return 100;
  if (artistTitle === normalizedQuery || titleArtist === normalizedQuery) return 100;
  if (compactArtistTitle === compactQuery || compactTitleArtist === compactQuery) return 100;
  if (title.includes(normalizedQuery)) return 86;
  if (compactTitle.includes(compactQuery)) return 86;
  if (normalizedQuery.includes(title) && normalizedQuery.includes(artist)) return 96;
  if (compactQuery.includes(compactTitle) && compactQuery.includes(compactSearchText(track.artist))) return 96;
  if (artistTitle.includes(normalizedQuery) || titleArtist.includes(normalizedQuery)) return 80;
  if (compactArtistTitle.includes(compactQuery) || compactTitleArtist.includes(compactQuery)) return 80;
  if (normalizedQuery.includes(title) && isSpecificContainedTitle(title)) return 72;
  if (compactQuery.includes(compactTitle) && isSpecificContainedTitle(compactTitle)) return 72;
  if (artist === normalizedQuery) return 68;
  if (artist.includes(normalizedQuery) || album.includes(normalizedQuery)) return 58;
  if (tokens.length > 0 && tokens.every((token) => haystack.includes(token))) return 62;
  if (compactQuery.length >= 2 && compactHaystack.includes(compactQuery)) return 62;

  return 0;
}

function rankCatalogMatches(query: string, tracks: readonly TrackRecord[]) {
  const seen = new Set<string>();
  const uniqueTracks = tracks.filter((track) => {
    if (track.artist.trim().toLowerCase() === "unknown artist") return false;
    const identity = `${compactSearchText(track.artist)}\n${compactSearchText(track.title)}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });

  return uniqueTracks
    .map((track): ScoredTrack => ({ track, score: scoreTrack(track, query) }))
    .sort((left, right) => right.score - left.score);
}

function isConfidentMatch(top: ScoredTrack, second?: ScoredTrack) {
  if (top.score >= 96) return true;
  if (!second && top.score >= 86) return true;
  return Boolean(second && top.score >= 86 && top.score - second.score >= 10);
}

export async function resolveDirectTrack(message: string, catalog: CatalogSearchPort): Promise<DirectTrackResolution> {
  if (!hasDirectPlaybackIntent(message)) {
    return { intent: directIntentPattern.test(message), query: "", candidates: [], reason: "no-intent" };
  }

  const query = extractDirectSongQuery(message);
  if (!query) {
    return { intent: hasDirectPlaybackIntent(message), query: "", candidates: [], reason: "no-intent" };
  }

  let tracks: readonly TrackRecord[];
  try {
    tracks = await catalog.search(query, 8);
  } catch {
    return { intent: true, query, candidates: [], reason: "api-unavailable" };
  }

  const ranked = rankCatalogMatches(query, tracks);
  const [top, second] = ranked;
  const candidates = ranked.slice(0, 5).map((item) => item.track);
  if (!top) return { intent: true, query, candidates: [], reason: "not-found" };
  if (!isConfidentMatch(top, second)) return { intent: true, query, candidates, reason: "ambiguous" };
  return { intent: true, query, match: top.track, candidates, reason: "matched" };
}

export function directTrackPick(track: TrackRecord, auditSource: string): RadioPick {
  const decision: ClaudeDecision = {
    say: `收到，接下来是 ${track.artist} 的《${track.title}》。`,
    play: [track.id],
    reason: `${auditSource} direct match: ${track.artist} - ${track.title}`,
    segue: "direct"
  };

  return {
    songId: track.id,
    djLine: decision.say,
    reason: decision.reason,
    moodTags: ["direct-request"],
    source: "rules",
    segue: decision.segue,
    decision
  };
}
