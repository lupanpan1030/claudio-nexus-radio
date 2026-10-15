import { MAX_NARRATION_TEXT_LENGTH } from "./application/narration/limits.js";
import type { Track } from "./types.js";

export type TrackLineMode =
  | "direct_intro"
  | "simple_bridge"
  | "plain_note"
  | "direct_intro_alt"
  | "mood_note"
  | "small_scene"
  | "half_sentence";

export type TrackLineQuality = {
  length: number;
  target: string;
  firstSentence: string;
  firstSentenceShape: string;
  forbiddenPattern: string;
  imageHits: string[];
  actionHits: string[];
  startsWithSimile: boolean;
};

const punctuationPattern = /[，。！？、；；,.!?;:\s"'“”‘’\-—…]+/g;
const genericOpeningPattern = /^(接下来|下面|来一首|来首|听一首|换一首|换一段|这一首|这首歌|送给你|陪你|现在为你|为你播放|为您带来|亲爱的听众)/;
const broadcastTonePattern =
  /亲爱的听众|听众朋友|为您带来|为你播放|欢迎收听|感谢收听|敬请欣赏|让我们|我们一起来|本期节目|此时此刻|治愈你的心灵|生活总会|每一个.*都/;
const writtenTonePattern =
  /情绪过渡|此刻适配|用户口味|听感|氛围感|层次感|画面感|质感|稳定的下一首|适合留一点|值得|仿佛|宛如|恰好落进|推荐逻辑|算法/;
const vocalFactPattern = /歌词|歌声|人声|声线|嗓音|唱腔|唱词|副歌|主歌|咬字|演唱|吟唱/;
const explicitNoVocalPattern = /没有歌词|没有一句歌词|无歌词|不需要歌词|无人声|没有人声|不是人声|不唱/;
const instrumentalFactPattern = /器乐|纯音乐|无词|没有歌词|钢琴|琴声|配器|BGM|instrumental|piano/i;
const realWeatherClaimPattern = /正在下雨|外面下雨|雨还在下|今天下雨|现在很冷|现在很热|天气预报|气温|湿度|风力|台风|暴雨|下雪/;
export const imageTokens = ["夜色", "夜里", "夜晚", "灯", "灯光", "窗边", "慢慢", "轻轻", "靠近", "放低", "温柔", "街", "城市"];
const actionTokens = [
  "说",
  "听",
  "看",
  "坐",
  "换",
  "留",
  "想",
  "让",
  "醒",
  "困",
  "累",
  "亮",
  "暂",
  "放",
  "停",
  "收",
  "走",
  "回来"
];
const similePattern = /像|好像|仿佛|宛如/;
const repeatedOpeningFamilies: Array<[RegExp, string]> = [
  [/^(有时候到这个时间|到这个时间|这个时间点|这个点|零点|过了零点|已经过了零点|时间已经)/, "time-point opening family"],
  [/^(赶路的时候|如果这会儿还在路上|这会儿还在路上|路上这一段|路上有时候|路上)/, "on-the-road opening family"],
  [/^(有时候|其实有些时候)/, "generic sometimes opening family"],
  [/^(不急着|不用急着|不把.{0,8}讲得太满|不讲太满|话不说满|先把.{0,12}放稳|先把话说普通一点|我不会|我不打算|这首我)/, "restraint meta opening family"]
];
const safeDjStates = [
  "今天话少一点，不急着把话说满。",
  "有点累，但不是坏事，声音可以放近一点。",
  "刚喝了咖啡，脑子慢慢清醒。",
  "今天没什么特别想说的，就把歌放好。",
  "现在更想少说两句，留一点给歌。",
  "这会儿心里比较安静，不想把气氛做大。",
  "刚才走神了一下，回来时正好轮到这首。",
  "今天适合把话说短一点，别打扰正在做的事。"
];

const collapsedChinesePatterns: Array<[RegExp, string]> = [
  [/我刚才看了?一眼列表/, "collapsed list-glance template"],
  [/不?是?很隆重的选择/, "collapsed solemn-choice template"],
  [/顺手把一盏小灯扶正/, "collapsed lamp template"],
  [/声音别压过你正在做的事/, "collapsed voice-over-task template"],
  [/我也少[讲说][一一两二]?[句点]/, "collapsed few-words template"],
  [/我少[讲说][一一两二]?[句点]/, "collapsed few-words template"],
  [/想少说两句/, "collapsed few-words template"]
];

const forbiddenTrackLinePatterns: Array<[RegExp, string]> = [
  [/先把.{0,12}(手里|手边|手上|手头).{0,12}(停|放|稳|收)/, "forbidden hand-task opening"],
  [/把(手里|手边|手上|手头)的事/, "forbidden hand-task phrase"],
  [/(停|停下|放下|放开).{0,8}(手里|手边|手上|手头)的事/, "forbidden hand-task phrase"],
  [/手里.{0,10}(事|事情).{0,12}(停|放|稳|收)/, "forbidden hand-task phrase"],
  [/手边.{0,10}(事|事情).{0,12}(停|放|稳|收)/, "forbidden hand-task phrase"],
  [/先停(一停|下来|一下)?/, "forbidden stop opening"],
  [/停一停/, "forbidden stop phrase"],
  [/先把.{0,12}放一放/, "forbidden put-aside phrase"],
  [/留一点(空|空隙|空间|位置)/, "forbidden empty-space phrase"],
  [/呼吸.{0,8}(放|收|宽|慢)/, "forbidden breathing template"],
  [/先把注意力/, "forbidden attention opening"],
  [/先把音量/, "forbidden volume opening"],
  [/先把节奏/, "forbidden rhythm opening"],
  [/(接上|接起来|接下来).{0,8}(这首|这一首|这段|后面|往下|下去|这一轮)/, "forbidden transition intent"],
  [/(带过去|带到后面|带进下一首)/, "forbidden transition intent"],
  [/(引入下一首|引到后面|引入这首)/, "forbidden transition intent"],
  [/铺.{0,4}开/, "forbidden unfolding intent"],
  [/慢慢展开/, "forbidden unfolding intent"],
  [/半听半放/, "forbidden listening instruction"],
  [/(音色|节奏|声音|旋律).{0,8}(会|先|可以).{0,14}(铺|展开|带|走|接|靠近|推进)/, "forbidden music forecast"],
  [/不用.{0,4}(追着|抓着|硬要).{0,4}(判断|认真听)/, "forbidden listening instruction"],
  [/放着(就好|听)/, "forbidden listening instruction"],
  [/随便听/, "forbidden listening instruction"],
  [/怎么听/, "forbidden listening instruction"]
];

export function pickSafeDjState(track: Track, recentLines: string[]) {
  const seed = `${track.id}:${recentLines.length}`;
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return safeDjStates[hash % safeDjStates.length];
}

export function normalizeOpening(line: string) {
  return line.replace(punctuationPattern, "").slice(0, 8);
}

export function modeSpec(mode: TrackLineMode) {
  const specs: Record<TrackLineMode, { label: string; target: string; instruction: string }> = {
    direct_intro: {
      label: "direct_intro",
      target: "10-120 Chinese characters, 1-3 sentences",
      instruction:
        "Per-track radio narration. The first sentence must start with the song title or artist. Put the song here plainly, then say two or three natural host sentences. No recommendation-card reasoning."
    },
    direct_intro_alt: {
      label: "direct_intro",
      target: "90-160 Chinese characters, 2-4 sentences",
      instruction:
        "Per-track radio narration. The first sentence must start with the song title or artist. Put the song here plainly, then say two or three natural host sentences. No recommendation-card reasoning."
    },
    simple_bridge: {
      label: "simple_bridge",
      target: "100-170 Chinese characters, 2-4 sentences",
      instruction:
        "Mention only a small after-feeling from the previous moment, then name this song or artist. Do not describe musical transition or how one track connects to another."
    },
    plain_note: {
      label: "plain_note",
      target: "110-140 Chinese characters, 8-10 spoken lines",
      instruction:
        "Say one complete offhand radio thought in 8-10 spoken lines, usually 8 or 9. Keep the lines medium or slightly long, avoid report-style title/artist openings, and trim explanations before collapsing line count."
    },
    mood_note: {
      label: "mood_note",
      target: "110-180 Chinese characters, 3-4 sentences",
      instruction:
        "Say a light feeling without turning it into a life lesson. A little pause is fine. Keep it clean, not overly literary."
    },
    small_scene: {
      label: "small_scene",
      target: "100-170 Chinese characters, 2-4 sentences",
      instruction:
        "Use one concrete object, action, or time point, then return to the song title. Do not pile up night, light, window, or other scenery, and do not claim the scene is real."
    },
    half_sentence: {
      label: "half_sentence",
      target: "90-150 Chinese characters, 2-3 sentences",
      instruction:
        "Sound like a thought that stops halfway, then give the song title or artist. Every sentence should feel spoken, not like an essay ending."
    }
  };
  return specs[mode];
}

function modeBounds(mode: TrackLineMode) {
  const bounds: Record<TrackLineMode, { min: number; max: number }> = {
    direct_intro: { min: 10, max: 120 },
    direct_intro_alt: { min: 10, max: 120 },
    simple_bridge: { min: 10, max: 140 },
    plain_note: { min: 90, max: 180 },
    mood_note: { min: 10, max: 150 },
    small_scene: { min: 10, max: 140 },
    half_sentence: { min: 10, max: 130 }
  };
  return bounds[mode];
}

export function uniqueHits(line: string, tokens: string[]) {
  return tokens.filter((token, index) => line.includes(token) && tokens.indexOf(token) === index);
}

function firstSentence(line: string) {
  return line.trim().split(/[。！？…]/).map((item) => item.trim()).find(Boolean) ?? line.trim();
}

function firstClause(line: string) {
  return firstSentence(line).split(/[，、；,:]/).map((item) => item.trim()).find(Boolean) ?? firstSentence(line);
}

function forbiddenTrackLineReason(line: string) {
  const clean = line.trim();
  const collapsedMatch = collapsedChinesePatterns.find(([pattern]) => pattern.test(clean));
  if (collapsedMatch) return collapsedMatch[1];
  const match = forbiddenTrackLinePatterns.find(([pattern]) => pattern.test(clean));
  return match?.[1] ?? "";
}

function firstSentenceShape(line: string) {
  return firstSentence(line)
    .replace(/《[^》]+》/g, "《TITLE》")
    .replace(/[A-Za-z0-9ぁ-んァ-ヶ一-龥·'&().-]{2,}/g, "X")
    .replace(/[，。,.!?！？；;:\s"'“”‘’]+/g, "")
    .slice(0, 14);
}

function firstClauseShape(line: string) {
  return firstClause(line)
    .replace(/《[^》]+》/g, "《TITLE》")
    .replace(/[A-Za-z0-9ぁ-んァ-ヶ一-龥·'&().-]{2,}/g, "X")
    .replace(/[，。,.!?！？；;:\s"'“”‘’]+/g, "")
    .slice(0, 10);
}

function startsWithTrackIdentity(line: string, track?: Track) {
  if (!track) return true;
  const first = firstSentence(line).replace(/^["“'‘\s]+/, "");
  const title = track.title.trim();
  const artist = track.artist.trim();
  const titleNoParen = title.replace(/[（(].*?[）)]/g, "").trim();
  const candidates = [title, titleNoParen, artist, `《${title}》`, titleNoParen ? `《${titleNoParen}》` : ""]
    .filter((item) => item.length >= 2)
    .map((item) => item.toLowerCase());
  const normalizedFirst = first.toLowerCase();
  return candidates.some((candidate) => normalizedFirst.startsWith(candidate));
}

function repeatedFirstShapeReason(line: string, recentLines: string[]) {
  const shape = firstSentenceShape(line);
  if (shape.length < 4) return "";
  const cleanFirst = firstSentence(line);
  const startsWithKnownTrackName = /^[A-Za-z0-9\u3040-\u30ff\u4e00-\u9fa5 '&().-]+，/.test(cleanFirst);
  if (startsWithKnownTrackName) return "";
  return recentLines.slice(0, 5).some((recent) => firstSentenceShape(recent) === shape)
    ? `repeated first sentence shape: ${shape}`
    : "";
}

function repeatedOpeningFamilyReason(line: string, recentLines: string[]) {
  const clause = firstClause(line);
  if (clause.length < 4) return "";

  const family = repeatedOpeningFamilies.find(([pattern]) => pattern.test(clause))?.[1];
  if (family) {
    const hit = recentLines.slice(0, 5).some((recent) =>
      repeatedOpeningFamilies.some(([pattern, name]) => name === family && pattern.test(firstClause(recent)))
    );
    if (hit) return `repeated opening family: ${family}`;
  }

  const clauseShape = firstClauseShape(line);
  if (clauseShape.length < 3) return "";
  return recentLines.slice(0, 5).some((recent) => firstClauseShape(recent) === clauseShape)
    ? `repeated first clause shape: ${clauseShape}`
    : "";
}

export function assessTrackLine(line: string, mode: TrackLineMode): TrackLineQuality {
  return {
    length: line.trim().length,
    target: modeSpec(mode).target,
    firstSentence: firstSentence(line),
    firstSentenceShape: firstSentenceShape(line),
    forbiddenPattern: forbiddenTrackLineReason(line),
    imageHits: uniqueHits(line, imageTokens),
    actionHits: uniqueHits(line, actionTokens),
    startsWithSimile: similePattern.test(line.trim().slice(0, 12))
  };
}

function repeatedImageReason(line: string, recentLines: string[]) {
  const recentText = recentLines.slice(0, 6).join("\n");
  const hits = uniqueHits(line, imageTokens).filter((token) => recentText.includes(token));
  return hits.length >= 3 ? `repeated image cluster: ${hits.slice(0, 4).join(",")}` : "";
}

export function isClearlyInstrumental(track: Track) {
  const text = `${track.title} ${track.artist} ${track.album} ${track.folder}`.toLowerCase();
  return /纯音乐|instrumental|piano|钢琴|轻音乐|治愈|ambient|serenity|sleep|bgm|yiruma|pianoboy|坂本龙一|久石让|hisaishi|einaudi|july|tycho|dj okawari/.test(text);
}

export function invalidDjLineReason(line: string, recentLines: string[], track?: Track, mode: TrackLineMode = "direct_intro") {
  const clean = line.trim();
  const bounds = modeBounds(mode);
  if (clean.length < bounds.min) return `${mode} too short`;
  if (clean.length > bounds.max) return `${mode} too long`;
  if (genericOpeningPattern.test(clean)) return "generic opening";
  if (broadcastTonePattern.test(clean)) return "broadcast tone";
  if (writtenTonePattern.test(clean)) return "written tone";
  const forbiddenReason = forbiddenTrackLineReason(clean);
  if (forbiddenReason) return forbiddenReason;
  if ((mode === "direct_intro" || mode === "direct_intro_alt") && !startsWithTrackIdentity(clean, track)) {
    return "direct intro must start with title or artist";
  }
  if (clean.split(/[。！？…]+/).some((sentence) => sentence.trim().length > 86)) return "sentence too long";
  if (realWeatherClaimPattern.test(clean)) return "unverified real weather claim";
  if (instrumentalFactPattern.test(clean) && vocalFactPattern.test(clean)) return "contradictory instrumental/vocal wording";
  if (track && isClearlyInstrumental(track) && vocalFactPattern.test(clean)) return "vocal wording for instrumental track";
  if (similePattern.test(clean) && recentLines.slice(0, 3).some((recent) => similePattern.test(recent))) {
    return "repeated simile structure";
  }
  const imageReason = repeatedImageReason(clean, recentLines);
  if (imageReason) return imageReason;
  const openingFamilyReason = repeatedOpeningFamilyReason(clean, recentLines);
  if (openingFamilyReason) return openingFamilyReason;
  const shapeReason = repeatedFirstShapeReason(clean, recentLines);
  if (shapeReason) return shapeReason;

  const opening = normalizeOpening(clean);
  const startsWithKnownTrackName = /^[A-Za-z0-9\u3040-\u30ff\u4e00-\u9fa5 '&().-]+，/.test(firstSentence(clean));
  if (!startsWithKnownTrackName && opening.length >= 4 && recentLines.some((recent) => normalizeOpening(recent) === opening)) {
    return "repeated recent opening";
  }

  return "";
}

export function invalidContextDjLineReason(line: string, track: Track) {
  const clean = line.trim();
  if (clean.length < 20) return "too short";
  if (clean.length > MAX_NARRATION_TEXT_LENGTH) return "too long";
  if (realWeatherClaimPattern.test(clean)) return "unverified real weather claim";
  if (track && isClearlyInstrumental(track) && vocalFactPattern.test(clean) && !explicitNoVocalPattern.test(clean)) return "vocal wording for instrumental track";
  return "";
}

export function invalidProgramLineReason(line: string) {
  const clean = line.trim();
  if (clean.length < 40) return "too short";
  if (clean.length > 320) return "too long";
  if (broadcastTonePattern.test(clean)) return "broadcast tone";
  if (writtenTonePattern.test(clean)) return "written tone";
  if (realWeatherClaimPattern.test(clean)) return "unverified real weather claim";
  if (clean.split(/[。！？…]+/).some((sentence) => sentence.trim().length > 110)) return "sentence too long";
  return "";
}
