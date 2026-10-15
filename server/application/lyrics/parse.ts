import type { LyricLine, LyricWord, TimingProvenance } from "@claudio/contracts";

export interface ParsedLyrics {
  readonly timing: TimingProvenance;
  /** Contract convention: positive delays lyrics relative to media time. */
  readonly offsetMs: number;
  readonly lines: readonly LyricLine[];
}

const MAX_LINES = 5000;
const MAX_WORDS = 500;
const MAX_LINE_CHARS = 2000;

const INSTRUMENTAL_MARKERS = [/纯音乐[，,]?\s*请(欣赏|您欣赏)/, /此歌曲为没有填词的纯音乐/, /^\s*instrumental\s*$/im];

export function looksInstrumental(text: string): boolean {
  return INSTRUMENTAL_MARKERS.some((pattern) => pattern.test(text));
}

/** "mm:ss", "mm:ss.f", "mm:ss.ff", "mm:ss.fff" or "mm:ss:ff" → ms. Fractions keep their precision. */
export function parseClock(value: string): number | null {
  const match = /^(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (seconds >= 60) return null;
  const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
  return Math.round((minutes * 60 + seconds + fraction) * 1000);
}

function lrcOffsetToContract(text: string): number {
  // LRC [offset:+N] shows lyrics N ms sooner; the contract's positive offset delays them.
  const match = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(text);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) && value !== 0 ? Math.max(-600_000, Math.min(600_000, -value)) : 0;
}

const TIME_TAG = /\[(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]/g;
const WORD_TAG = /<(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)>/g;

/**
 * Line-synced LRC, with A2 enhanced word tags. Word timing is reported only
 * when every timed line carries word tags (the source's own word times);
 * otherwise tags are stripped and the result is line-timed.
 */
export function parseLrc(text: string): ParsedLyrics | null {
  const raw: { startMs: number; body: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const stamps: number[] = [];
    let rest = line.trim();
    for (;;) {
      const match = /^\[(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]/.exec(rest);
      if (!match) break;
      const ms = parseClock(match[1] ?? "");
      if (ms !== null) stamps.push(ms);
      rest = rest.slice(match[0].length);
    }
    if (stamps.length === 0) continue;
    for (const startMs of stamps) raw.push({ startMs, body: rest });
  }
  if (raw.length === 0) return null;
  raw.sort((a, b) => a.startMs - b.startMs);

  const withWords = raw.filter((entry) => stripTags(entry.body).trim()).map((entry) => wordsFromEnhanced(entry.startMs, entry.body));
  const allWordTimed = withWords.length > 0 && withWords.every((words) => words !== null);

  const lines: LyricLine[] = raw.slice(0, MAX_LINES).map((entry) => {
    const lineText = stripTags(entry.body).trim().slice(0, MAX_LINE_CHARS);
    if (!allWordTimed || !lineText) return { startMs: entry.startMs, text: lineText };
    const words = wordsFromEnhanced(entry.startMs, entry.body) ?? [];
    return { startMs: entry.startMs, text: lineText, words: words.slice(0, MAX_WORDS) };
  });
  return { timing: allWordTimed ? "native-word" : "native-line", offsetMs: lrcOffsetToContract(text), lines };
}

function stripTags(body: string): string {
  return body.replace(TIME_TAG, "").replace(WORD_TAG, "");
}

/** Words from "<t1>word<t2>word<t3>" — a word ends where the next tag starts; the last needs a closing tag. */
function wordsFromEnhanced(lineStart: number, body: string): LyricWord[] | null {
  const tags = [...body.matchAll(WORD_TAG)];
  if (tags.length < 2) return null;
  const words: LyricWord[] = [];
  for (let index = 0; index < tags.length - 1; index += 1) {
    const tag = tags[index]!;
    const next = tags[index + 1]!;
    const startMs = parseClock(tag[1] ?? "");
    const endMs = parseClock(next[1] ?? "");
    if (startMs === null || endMs === null || endMs < startMs || startMs < lineStart - 1000) return null;
    const wordText = body.slice((tag.index ?? 0) + tag[0].length, next.index ?? 0);
    if (wordText) words.push({ startMs, endMs, text: wordText.slice(0, 200) });
  }
  // Every sung character must be covered by a source-provided word time; an
  // untagged tail (e.g. a missing closing tag) means the line is not word-timed.
  const covered = words.map((word) => word.text).join("").replace(/\s+/g, "");
  return words.length > 0 && covered === stripTags(body).replace(/\s+/g, "") ? words : null;
}

/**
 * KuGou KRC (already decoded): "[lineStart,lineDuration]<offset,duration,0>word…".
 * Word offsets are relative to the line start and come from the provider.
 */
export function parseKrc(text: string): ParsedLyrics | null {
  const lines: LyricLine[] = [];
  let wordTimed = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const header = /^\[(\d+),(\d+)\](.*)$/.exec(rawLine.trim());
    if (!header) continue;
    const startMs = Number(header[1]);
    const durationMs = Number(header[2]);
    const body = header[3] ?? "";
    const words: LyricWord[] = [];
    for (const match of body.matchAll(/<(\d+),(\d+),\d+>([^<]*)/g)) {
      const offset = Number(match[1]);
      const duration = Number(match[2]);
      const wordText = match[3] ?? "";
      if (!wordText) continue;
      words.push({ startMs: startMs + offset, endMs: startMs + offset + duration, text: wordText.slice(0, 200) });
    }
    const lineText = (words.length > 0 ? words.map((word) => word.text).join("") : body.replace(/<[^>]*>/g, "")).trim();
    if (words.length === 0 && lineText) wordTimed = false;
    lines.push({
      startMs,
      endMs: startMs + durationMs,
      text: lineText.slice(0, MAX_LINE_CHARS),
      ...(words.length > 0 ? { words: words.slice(0, MAX_WORDS) } : {})
    });
    if (lines.length >= MAX_LINES) break;
  }
  if (lines.length === 0) return null;
  lines.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
  const anyWords = lines.some((line) => line.words && line.words.length > 0);
  if (!wordTimed || !anyWords) {
    return {
      timing: "native-line",
      offsetMs: lrcOffsetToContract(text),
      lines: lines.map(({ words: _words, ...line }) => line)
    };
  }
  return { timing: "native-word", offsetMs: lrcOffsetToContract(text), lines };
}

/** Untimed text: one line per non-empty row, never given invented times. */
export function parsePlain(text: string): ParsedLyrics | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_LINES)
    .map((line) => ({ text: line.slice(0, MAX_LINE_CHARS) }));
  return lines.length > 0 ? { timing: "plain-text", offsetMs: 0, lines } : null;
}

export function parseLyricsDocument(format: "lrc" | "krc" | "plain", text: string): ParsedLyrics | null {
  if (format === "krc") return parseKrc(text) ?? parseLrc(text);
  if (format === "lrc") return parseLrc(text) ?? parsePlain(stripLrcMetadata(text));
  return parsePlain(text);
}

function stripLrcMetadata(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[[a-z]+:[^\]]*\]\s*$/i.test(line))
    .join("\n");
}
