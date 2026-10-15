import { setWeatherLocation } from "./config.js";
import { resolveDirectTrack, directTrackPick } from "./direct.js";
import { getRecentChat, recordChatMessage, upsertTracks } from "./db.js";
import { kuGouCatalogSearchPort } from "./kugou-catalog.js";
import { callLlmText } from "./llm.js";
import { suggestPlaylist } from "./playlist.js";
import { resolvePlaybackSource } from "./playback-source.js";
import { getUserProfileDocs } from "./userProfile.js";
import { getWeatherContext } from "./weather.js";
import type { ChatReply, Track } from "./types.js";

/**
 * Injection points for the v1 composition: playability is checked with the
 * new source resolvers and recency comes from confirmed listens. Defaults keep
 * the legacy behaviour.
 */
export type ChatDeps = {
  verifyPlayable?: (track: Track) => Promise<boolean>;
  recentTracks?: () => Track[];
};

type PendingDirectCandidates = {
  candidates: Track[];
  expiresAt: number;
};

type ChatIntent = "conversation" | "direct" | "queue" | "playlist";

type ModelIntent = {
  intent: ChatIntent;
  query?: string;
};

const pendingDirectTtlMs = 3 * 60 * 1000;
let pendingDirectCandidates: PendingDirectCandidates | null = null;

const cityCoordinates: Record<string, { lat: number; lng: number }> = {
  杭州: { lat: 30.2741, lng: 120.1551 },
  温州: { lat: 27.9938, lng: 120.6994 },
  上海: { lat: 31.2304, lng: 121.4737 },
  北京: { lat: 39.9042, lng: 116.4074 },
  广州: { lat: 23.1291, lng: 113.2644 },
  深圳: { lat: 22.5431, lng: 114.0579 },
  成都: { lat: 30.5728, lng: 104.0668 },
  重庆: { lat: 29.4316, lng: 106.9123 },
  武汉: { lat: 30.5928, lng: 114.3055 },
  南京: { lat: 32.0603, lng: 118.7969 },
  苏州: { lat: 31.299, lng: 120.5853 },
  天津: { lat: 39.3434, lng: 117.3616 },
  长沙: { lat: 28.2282, lng: 112.9388 },
  西安: { lat: 34.3416, lng: 108.9398 },
  厦门: { lat: 24.4798, lng: 118.0894 },
  青岛: { lat: 36.0671, lng: 120.3826 },
  大连: { lat: 38.914, lng: 121.6147 },
  昆明: { lat: 25.0389, lng: 102.7183 },
  三亚: { lat: 18.2528, lng: 109.512 },
  拉萨: { lat: 29.65, lng: 91.1 }
};

function matchCity(message: string): string | null {
  const patterns = [
    /(?:在|到|去)\s*([^\s，。！？]{2,6})(?:市|区|县)?/,
    /(?:我在|我到|我去|人在|定位|天气切到|切到)\s*([^\s，。！？]{2,6})(?:市|区|县)?/
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match) continue;
    const candidate = match[1].replace(/(市|区|县)$/g, "");
    if (cityCoordinates[candidate]) return candidate;
    for (const city of Object.keys(cityCoordinates)) {
      if (candidate.includes(city) || city.includes(candidate)) return city;
    }
  }

  return null;
}

function handleLocationSwitch(message: string): { switched: boolean; city?: string; reply?: string } {
  const city = matchCity(message);
  if (!city) return { switched: false };

  const coords = cityCoordinates[city];
  setWeatherLocation(coords.lat, coords.lng, city);
  return {
    switched: true,
    city,
    reply: `已切换到 ${city} 的天气定位。`
  };
}

function wantsPlaylist(message: string) {
  return /歌单|播放列表|playlist|今日电台计划|今天的电台计划|规划今天|安排今天/i.test(message);
}

function wantsPlaylistRefresh(message: string) {
  return /换一点|换一份|再生成|重新排/.test(message);
}

function wantsQueueInsert(message: string) {
  return /下一首|插入|插队|加入队列|放进队列|排到后面/i.test(message);
}

function isBgmRequest(message: string) {
  return /\bbgm\b|背景音乐/i.test(message);
}

function needsModelIntentClassification(message: string) {
  return /歌单|播放列表|playlist|歌曲|歌手|专辑|点歌|播放|下一首|插入|插队|队列|来一首|听一首|放一首/i.test(message);
}

function offScopeMusicReply() {
  return "这类背景音乐不在这里替你挑。这个入口先留给点名插歌、歌单和聊天。";
}

function directNotFoundReply(query: string) {
  return `我在酷狗的可播放结果里没有稳定找到「${query}」。你可以补充歌手名或版本信息，我再按 API 结果查一次。`;
}

function directAmbiguousReply(candidates: Array<{ artist: string; title: string }>) {
  const options = candidates
    .slice(0, 3)
    .map((track) => `${track.artist} - ${track.title}`)
    .join(" / ");
  return `我找到了几个可能的版本：${options}。为了不播错，你再说得具体一点。`;
}

function directApiUnavailableReply() {
  return "酷狗的搜索服务现在没有响应，所以我没有猜测或使用本地文件替代。等服务恢复后再试一次。";
}

function directUnavailableReply(track: Pick<Track, "artist" | "title">) {
  return `我找到了 ${track.artist} 的《${track.title}》，但现在取不到可播放音源，所以没有把它插进队列。`;
}

async function legacyVerifyPlayable(track: Track) {
  await resolvePlaybackSource(track.id);
  return true;
}

async function playableDirectPick(track: Track, deps: ChatDeps) {
  try {
    upsertTracks([track]);
    const playable = await (deps.verifyPlayable ?? legacyVerifyPlayable)(track);
    return playable ? directTrackPick(track, "KuGou API") : undefined;
  } catch {
    return undefined;
  }
}

function rememberDirectCandidates(candidates: Track[]) {
  pendingDirectCandidates = {
    candidates,
    expiresAt: Date.now() + pendingDirectTtlMs
  };
}

function clearDirectCandidates() {
  pendingDirectCandidates = null;
}

function pickPendingDirectCandidate(message: string) {
  if (!pendingDirectCandidates || pendingDirectCandidates.expiresAt < Date.now()) {
    clearDirectCandidates();
    return null;
  }

  const clean = message.trim().toLowerCase();
  const indexMatch = clean.match(/第\s*([一二三四五12345])\s*(个|首)?/);
  const ordinal = indexMatch?.[1];
  const ordinalIndex: Record<string, number> = {
    一: 0,
    二: 1,
    三: 2,
    四: 3,
    五: 4,
    "1": 0,
    "2": 1,
    "3": 2,
    "4": 3,
    "5": 4
  };

  if (ordinal && ordinalIndex[ordinal] !== undefined) {
    return pendingDirectCandidates.candidates[ordinalIndex[ordinal]] ?? null;
  }

  if (/^(就是这个|就这个|这个|这首|播放这个|放这个|播这个|对|对的|没错)\s*[。.!！]*$/.test(clean)) {
    return pendingDirectCandidates.candidates[0] ?? null;
  }

  return null;
}

function idleReply() {
  return "我在。这个入口现在先处理明确点歌和基础对话；下一首推荐、歌单推荐会分开做，避免互相影响。";
}

export type EmotionalSignal = "low" | "specific" | "none";

export function classifyEmotionalSignal(message: string): EmotionalSignal {
  const clean = message.trim();
  if (!/emo|难过|失落|疲惫|累|烦|舍不得|关系|心情|撑不住|犹豫/i.test(clean)) return "none";
  if (/关系|分手|舍不得|因为|但是|继续|工作|家人|朋友|发生|之后|的时候/.test(clean) || clean.length > 24) {
    return "specific";
  }
  return "low";
}

export function emotionalConversationGuidance(signal: EmotionalSignal) {
  if (signal === "low") {
    return "用户只表达了模糊情绪。用一到两句回应：承认此刻不用急着解释，不补出原因、症状、经历或判断。最多问一个开放的小问题，让用户决定要不要继续说。";
  }
  if (signal === "specific") {
    return "用户说了具体处境。按这个顺序回应：先贴住用户已经说出的事实或矛盾，再给一层克制的观察，最后可选地留一个具体问题。不得补剧情、诊断、说教或替用户下结论；不要使用“我的判断是”之类的裁决口吻。";
  }
  return "";
}

async function classifyChatIntent(message: string): Promise<ModelIntent | undefined> {
  const text = await callLlmText(
    [
      {
        role: "system",
        content: [
          "You route requests for a personal AI radio. Return strict JSON only.",
          'Shape: {"intent":"conversation"|"direct"|"queue"|"playlist","query":""}.',
          "direct means play one named song now; queue means insert one named song after the current track; playlist means create a multi-track playlist.",
          "Use conversation for ordinary chat, questions, or unclear music requests. query must contain only the useful song name, artist, or scene request.",
          "Do not claim playback or invent a song title."
        ].join("\n")
      },
      { role: "user", content: message }
    ],
    "claudio-chat-intent",
    { responseFormat: "json_object", temperature: 0.1, timeoutMs: 12000 }
  );
  if (!text) return undefined;

  try {
    const parsed = JSON.parse(text) as Partial<ModelIntent>;
    const intent = parsed.intent;
    if (!["conversation", "direct", "queue", "playlist"].includes(String(intent))) return undefined;
    return { intent: intent as ChatIntent, query: typeof parsed.query === "string" ? parsed.query.trim() : "" };
  } catch {
    return undefined;
  }
}

async function conversationalReply(message: string) {
  const emotionalSignal = classifyEmotionalSignal(message);
  const docs = await getUserProfileDocs();
  const history = getRecentChat(emotionalSignal === "none" ? 8 : 4)
    .filter((item) => !(item.role === "user" && item.content === message))
    .map((item) => ({ role: item.role === "assistant" ? "assistant" as const : "user" as const, content: String(item.content) }));
  const emotionalGuidance = emotionalConversationGuidance(emotionalSignal);
  const text = await callLlmText(
    [
      {
        role: "system",
        content: [
          "你是个人电台主持人 Claudio。直接回应用户此刻说的话，用自然、克制、简短的中文交谈。",
           "当前只是对话，不要声称已经播放、插队或生成歌单，也不要输出 JSON。",
           "Do not discuss APIs, application architecture, request parameters, or implementation details. Keep the reply in the listener conversation.",
          "不要介绍你自己，不要复述用户原话，不要使用 emoji。",
          "普通对话中不要主动推荐或点名任何歌曲、歌手、歌单或背景音乐；只有明确的点名播放、插入或歌单意图才会走音乐能力。",
          emotionalGuidance,
          emotionalSignal === "none" ? `用户品味参考：${docs.taste.slice(0, 600)}` : ""
        ].join("\n")
      },
      ...history,
      { role: "user", content: message }
    ],
    "claudio-chat",
    { temperature: 0.65, timeoutMs: 12000 }
  );
  return text?.trim() || idleReply();
}

export async function chatWithRadio(message: string, deps: ChatDeps = {}): Promise<ChatReply> {
  const clean = message.trim();
  const explicitQueueRequest =
    clean.includes("下一首") ||
    clean.includes("插入") ||
    clean.includes("插队") ||
    clean.includes("加入队列") ||
    clean.includes("放进队列") ||
    clean.includes("排到后面");
  if (!clean) throw new Error("消息不能为空。");

  recordChatMessage("user", clean);

  const locationSwitch = handleLocationSwitch(clean);
  if (locationSwitch.switched) {
    recordChatMessage("assistant", locationSwitch.reply!);
    return {
      reply: locationSwitch.reply!,
      remembered: `用户切换城市定位到：${locationSwitch.city}`
    };
  }

  const confirmedCandidate = pickPendingDirectCandidate(clean);
  if (confirmedCandidate) {
    clearDirectCandidates();
    const resolved = await playableDirectPick(confirmedCandidate, deps);
    if (!resolved) {
      const reply = directUnavailableReply(confirmedCandidate);
      recordChatMessage("assistant", reply);
      return { reply };
    }
    const pick = resolved;
    const reply: ChatReply = {
      reply: pick.decision?.say || pick.djLine,
      pick,
      decision: pick.decision
    };
    recordChatMessage("assistant", reply.reply);
    return reply;
  }

  const direct = await resolveDirectTrack(clean, kuGouCatalogSearchPort);
  if (direct.match) {
    clearDirectCandidates();
    const pick = await playableDirectPick(direct.match, deps);
    if (!pick) {
      const reply = directUnavailableReply(direct.match);
      recordChatMessage("assistant", reply);
      return { reply };
    }
    const queueOnly = explicitQueueRequest;
    const reply: ChatReply = queueOnly
      ? { reply: `好，下一首接 ${direct.match.artist} 的《${direct.match.title}》。`, queuePick: pick }
      : { reply: pick.decision?.say || pick.djLine, pick, decision: pick.decision };
    recordChatMessage("assistant", reply.reply);
    return reply;
  }

  if (direct.intent && direct.reason === "ambiguous") {
    rememberDirectCandidates(direct.candidates);
    const reply = directAmbiguousReply(direct.candidates);
    recordChatMessage("assistant", reply);
    return { reply };
  }

  if (direct.intent && direct.reason === "api-unavailable") {
    clearDirectCandidates();
    const reply = directApiUnavailableReply();
    recordChatMessage("assistant", reply);
    return { reply };
  }

  if (direct.intent && direct.query) {
    clearDirectCandidates();
    const reply = directNotFoundReply(direct.query);
    recordChatMessage("assistant", reply);
    return { reply };
  }

  if (isBgmRequest(clean)) {
    clearDirectCandidates();
    const reply = offScopeMusicReply();
    recordChatMessage("assistant", reply);
    return { reply };
  }

  const modelIntent = needsModelIntentClassification(clean) ? await classifyChatIntent(clean) : undefined;
  if (modelIntent?.intent === "direct" || modelIntent?.intent === "queue") {
    const modelDirect = await resolveDirectTrack(`播放 ${modelIntent.query}`, kuGouCatalogSearchPort);
    if (modelDirect.match) {
      clearDirectCandidates();
      const pick = await playableDirectPick(modelDirect.match, deps);
      if (!pick) {
        const reply = directUnavailableReply(modelDirect.match);
        recordChatMessage("assistant", reply);
        return { reply };
      }
      const reply: ChatReply =
        modelIntent.intent === "queue" || explicitQueueRequest
          ? { reply: `Queued next: ${modelDirect.match.artist} - ${modelDirect.match.title}.`, queuePick: pick }
          : { reply: pick.decision?.say || pick.djLine, pick, decision: pick.decision };
      recordChatMessage("assistant", reply.reply);
      return reply;
    }
    if (modelDirect.reason === "ambiguous") {
      rememberDirectCandidates(modelDirect.candidates);
      const reply = directAmbiguousReply(modelDirect.candidates);
      recordChatMessage("assistant", reply);
      return { reply };
    }
  }

  if (modelIntent?.intent === "playlist" || wantsPlaylist(clean) || wantsPlaylistRefresh(clean)) {
    clearDirectCandidates();
    const weather = await getWeatherContext().catch(() => undefined);
    const scene = [clean, weather?.summary].filter(Boolean).join(" · ");
    const playlist = await suggestPlaylist(scene, {
      count: 10,
      weather,
      recent: deps.recentTracks?.(),
      verifyPlayable: deps.verifyPlayable
    });
    const reply = `今天先排这 ${playlist.picks.length} 首，我参考了你的历史品味、现在的时间${weather?.summary ? `和 ${weather.summary} 的天气` : ""}。`;
    recordChatMessage("assistant", reply);
    return { reply, playlist, weather };
  }

  const reply = await conversationalReply(clean);
  recordChatMessage("assistant", reply);
  return { reply };
}
