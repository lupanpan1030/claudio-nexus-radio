import { decode, subtitleTrackDecoder, type CueAsset, type SubtitleSegment, type SubtitleTrack } from "@claudio/contracts";

/**
 * Estimated sentence timing for DJ subtitles. The server publishes the
 * script as one plain-text segment before any audio exists; once the voice
 * asset carries a measured duration, the snapshot can show the sentence that
 * is probably being spoken. This is a guess from text length and punctuation,
 * never an alignment: the track is labelled "estimated", per-character times
 * are never produced, and anything this cannot split honestly stays as it was.
 */

/** More sentences than this are merged into neighbouring segments. */
export const MAX_ESTIMATED_SEGMENTS = 40;
/** Segments shorter than this on average are not worth showing one by one. */
export const MIN_ESTIMATED_SEGMENT_MS = 400;

const TERMINAL = /[。！？!?；;…‼⁇⁈⁉｡]/u;
const CLOSER = /[」』”’"'）)\]】》〉»]/u;
const FULL_STOP = /[.．]/u;
const PAUSE = /[，、,：:—]/u;
const SPACE = /\s/u;
/** Characters spoken as roughly one syllable each. */
const SYLLABIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Splits after sentence-final punctuation (with closing quotes) and at line breaks; whitespace collapsed. */
export function splitSentences(text: string): string[] {
  const chars = Array.from(text);
  const sentences: string[] = [];
  let current = "";
  const flush = () => {
    const sentence = current.replace(/\s+/gu, " ").trim();
    current = "";
    if (!sentence) return;
    // Punctuation alone belongs to the sentence before it.
    if (!WORD_CHAR.test(sentence) && sentences.length > 0) sentences[sentences.length - 1] += sentence;
    else sentences.push(sentence);
  };
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    if (char === "\n" || char === "\r") {
      flush();
      continue;
    }
    current += char;
    const next = chars[index + 1];
    const ends = TERMINAL.test(char) || (FULL_STOP.test(char) && (next === undefined || SPACE.test(next) || CLOSER.test(next)));
    if (!ends) continue;
    while (index + 1 < chars.length && (TERMINAL.test(chars[index + 1]!) || FULL_STOP.test(chars[index + 1]!) || CLOSER.test(chars[index + 1]!))) {
      index += 1;
      current += chars[index];
    }
    flush();
  }
  flush();
  return sentences;
}

/** Relative speaking time: syllabic characters, Latin/number words by length, and pauses at punctuation. */
export function sentenceWeight(sentence: string): number {
  let weight = 0;
  let word = 0;
  const endWord = () => {
    if (word > 0) weight += Math.max(1, word / 3);
    word = 0;
  };
  for (const char of sentence) {
    if (SYLLABIC.test(char)) {
      endWord();
      weight += 1;
    } else if (WORD_CHAR.test(char)) {
      word += 1;
    } else {
      endWord();
      if (TERMINAL.test(char) || FULL_STOP.test(char)) weight += 1.5;
      else if (PAUSE.test(char)) weight += 0.75;
    }
  }
  endWord();
  return Math.max(1, weight);
}

/** Contiguous groups of at most `limit` with similar total weight; order and text are kept. */
function mergeToLimit(sentences: readonly string[], weights: readonly number[], limit: number): { text: string; weight: number }[] {
  if (sentences.length <= limit) return sentences.map((text, index) => ({ text, weight: weights[index]! }));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const groups: { text: string; weight: number }[] = [];
  let consumed = 0;
  sentences.forEach((text, index) => {
    const weight = weights[index]!;
    const remainingSentences = sentences.length - index;
    const remainingGroups = limit - groups.length;
    const target = (total * groups.length) / limit;
    // Start a new group when this group reached its share, or when every remaining sentence needs its own group.
    const startNew = groups.length === 0 || (remainingGroups > 0 && (consumed >= target || remainingSentences <= remainingGroups));
    if (startNew && groups.length < limit) groups.push({ text, weight });
    else {
      const last = groups[groups.length - 1]!;
      // Latin sentences keep a space between them; CJK text joins directly.
      last.text = `${last.text}${/[\x21-\x7e]$/u.test(last.text) && /^[\x21-\x7e]/u.test(text) ? " " : ""}${text}`;
      last.weight += weight;
    }
    consumed += weight;
  });
  return groups;
}

/**
 * A plain-text subtitle spread over the voice's measured media duration
 * (rate 1, the unit of the voice clock), sentence by sentence. Returns the
 * input unchanged unless it is plain text, the duration is known and usable,
 * and there are at least two sentences.
 */
export function estimateSubtitleTiming(track: SubtitleTrack, durationMs: number | null): SubtitleTrack {
  if (track.timing !== "plain-text" || durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return track;
  const sentences = track.segments.flatMap((segment) => splitSentences(segment.text));
  const limit = Math.min(MAX_ESTIMATED_SEGMENTS, Math.floor(durationMs / MIN_ESTIMATED_SEGMENT_MS));
  if (sentences.length < 2 || limit < 2) return track;
  const groups = mergeToLimit(sentences, sentences.map(sentenceWeight), limit);
  const total = groups.reduce((sum, group) => sum + group.weight, 0);
  let cumulative = 0;
  const starts = groups.map((group) => {
    const start = Math.round((durationMs * cumulative) / total);
    cumulative += group.weight;
    return start;
  });
  const segments: SubtitleSegment[] = groups.map((group, index) => ({
    startMs: starts[index]!,
    endMs: index + 1 < groups.length ? starts[index + 1]! : durationMs,
    text: group.text
  }));
  const estimated: SubtitleTrack = { timing: "estimated", segments };
  // Never publish something the shared decoder would refuse (e.g. an over-long merged segment).
  return decode(subtitleTrackDecoder, estimated).ok ? estimated : track;
}

const projected = new WeakMap<CueAsset, SubtitleTrack>();

/**
 * Subtitle of a cue asset as the snapshot shows it. Assets are immutable and
 * replaced wholesale, so the projection is computed once per asset and the
 * same object is returned for every snapshot (owner and observers alike).
 */
export function projectedSubtitle(asset: CueAsset): SubtitleTrack {
  const cached = projected.get(asset);
  if (cached) return cached;
  const duration = asset.voice.duration;
  const track = estimateSubtitleTiming(asset.script.subtitle, duration.kind === "known" ? duration.ms : null);
  projected.set(asset, track);
  return track;
}
