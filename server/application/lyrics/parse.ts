import type { LyricLine, LyricWord, TimingProvenance } from "@claudio/contracts";

export interface ParsedLyrics {
  readonly timing: TimingProvenance;
  /** Contract convention: positive delays lyrics relative to media time. */
  readonly offsetMs: number;
  readonly lines: readonly LyricLine[];
}

/**
 * Output caps follow the contracts' lyrics decoder. A document that would
 * need lines or line text cut to fit is refused instead of silently shortened;
 * a line with too many words keeps its full text and loses its word timing.
 */
const MAX_LINES = 5000;
const MAX_WORDS = 500;
const MAX_LINE_CHARS = 2000;
const MAX_WORD_CHARS = 200;
/** Latest time a lyric may name (same bound as a known media duration). */
export const MAX_LYRIC_TIME_MS = 24 * 3600_000;

/** Bumped whenever parsing can produce different output for the same document. */
export const LYRICS_PARSER_VERSION = 2;

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
  const ms = Math.round((minutes * 60 + seconds + fraction) * 1000);
  return ms <= MAX_LYRIC_TIME_MS ? ms : null;
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
const LRC_STAMP = /^\[(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]/;

type Outcome = ParsedLyrics | "untimed" | "refused";

/**
 * Line-synced LRC, with A2 enhanced word tags. Word timing is reported only
 * when every sung line is fully covered by the source's own word times, each
 * inside its line (never before the line's start); otherwise the tags are
 * stripped, all text is kept and the result is line-timed.
 */
export function parseLrc(text: string): ParsedLyrics | null {
  const outcome = lrcOutcome(text);
  return typeof outcome === "string" ? null : outcome;
}

function lrcOutcome(text: string): Outcome {
  const raw: { startMs: number; body: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const stamps: number[] = [];
    let rest = line.trim();
    for (;;) {
      const match = LRC_STAMP.exec(rest);
      if (!match) break;
      const ms = parseClock(match[1] ?? "");
      if (ms !== null) stamps.push(ms);
      rest = rest.slice(match[0].length);
    }
    for (const startMs of stamps) raw.push({ startMs, body: rest });
  }
  if (raw.length === 0) return "untimed";
  if (raw.length > MAX_LINES) return "refused";
  raw.sort((a, b) => a.startMs - b.startMs);

  const entries = raw.map((entry) => ({
    startMs: entry.startMs,
    text: stripTags(entry.body).trim(),
    words: wordsFromEnhanced(entry.startMs, entry.body)
  }));
  if (entries.some((entry) => entry.text.length > MAX_LINE_CHARS)) return "refused";
  const sung = entries.filter((entry) => entry.text);
  const wordTimed = sung.length > 0 && sung.every((entry) => entry.words !== null);
  const lines: LyricLine[] = entries.map((entry) =>
    wordTimed && entry.text && entry.words ? { startMs: entry.startMs, text: entry.text, words: entry.words } : { startMs: entry.startMs, text: entry.text }
  );
  return { timing: wordTimed ? "native-word" : "native-line", offsetMs: lrcOffsetToContract(text), lines };
}

function stripTags(body: string): string {
  return body.replace(TIME_TAG, "").replace(WORD_TAG, "");
}

/**
 * Words from "<t1>word<t2>word<t3>" — a word ends where the next tag starts;
 * the last needs a closing tag. Null unless the words cover every visible
 * character, start no earlier than the line, are ordered and fit the caps.
 */
function wordsFromEnhanced(lineStart: number, body: string): LyricWord[] | null {
  const tags = [...body.matchAll(WORD_TAG)];
  if (tags.length < 2) return null;
  const words: LyricWord[] = [];
  for (let index = 0; index < tags.length - 1; index += 1) {
    const tag = tags[index]!;
    const next = tags[index + 1]!;
    const startMs = parseClock(tag[1] ?? "");
    const endMs = parseClock(next[1] ?? "");
    if (startMs === null || endMs === null || endMs < startMs || startMs < lineStart) return null;
    const wordText = body.slice((tag.index ?? 0) + tag[0].length, next.index ?? 0);
    if (wordText.length > MAX_WORD_CHARS) return null;
    if (wordText) words.push({ startMs, endMs, text: wordText });
  }
  if (words.length === 0 || words.length > MAX_WORDS) return null;
  // Every sung character must be covered by a source-provided word time; an
  // untagged prefix or tail (e.g. a missing closing tag) means the line is not word-timed.
  const covered = words.map((word) => word.text).join("").replace(/\s+/g, "");
  return covered === stripTags(body).replace(/\s+/g, "") ? words : null;
}

/** Any numeric angle tag; only well-formed "<offset,duration,x>" carries a word time. */
const KRC_TAG = /<\s*(-?\d+(?:\s*,\s*-?\d+)*)\s*>/g;
const KRC_HEADER = /^\[(\d+),(\d+)\](.*)$/;

/** Non-negative integer milliseconds within the supported range, else null (never Infinity/NaN). */
function krcMs(digits: string): number | null {
  const trimmed = digits.trim().replace(/^0+(?=\d)/, "");
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= MAX_LYRIC_TIME_MS ? value : null;
}

interface KrcLine {
  readonly text: string;
  /** Null when the words do not prove timing for the whole line. */
  readonly words: LyricWord[] | null;
}

/**
 * One KRC body. The text is always every visible segment (untagged prefix,
 * text after malformed tags included); words are kept only if each visible
 * character lies in a well-formed word that sits inside [lineStart, lineEnd].
 */
function krcLine(body: string, lineStart: number, lineEnd: number): KrcLine {
  const tags = [...body.matchAll(KRC_TAG)];
  const prefix = body.slice(0, tags[0]?.index ?? body.length);
  let text = prefix;
  let covered = !prefix.trim();
  const words: LyricWord[] = [];
  tags.forEach((tag, index) => {
    const segment = body.slice((tag.index ?? 0) + tag[0].length, tags[index + 1]?.index ?? body.length);
    text += segment;
    const fields = (tag[1] ?? "").split(",");
    if (fields.length !== 3) {
      if (segment.trim()) covered = false;
      return;
    }
    if (!segment) return;
    const offset = krcMs(fields[0] ?? "");
    const duration = krcMs(fields[1] ?? "");
    if (offset === null || duration === null || krcMs(fields[2] ?? "") === null) {
      covered = false;
      return;
    }
    const startMs = lineStart + offset;
    const endMs = startMs + duration;
    const previous = words.at(-1);
    if (endMs > lineEnd || segment.length > MAX_WORD_CHARS || (previous && startMs < previous.startMs)) covered = false;
    words.push({ startMs, endMs, text: segment });
  });
  if (words.length === 0 || words.length > MAX_WORDS) covered = false;
  return { text: text.trim(), words: covered ? words : null };
}

/**
 * KuGou KRC (already decoded): "[lineStart,lineDuration]<offset,duration,0>word…".
 * Word offsets are relative to the line start and come from the provider.
 * A line whose own clock is out of range makes the whole document plain text
 * (no line can be dropped and no time invented); word problems only demote
 * the timing to native-line.
 */
export function parseKrc(text: string): ParsedLyrics | null {
  const entries: Array<KrcLine & { startMs: number; endMs: number }> = [];
  let clocksValid = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const header = KRC_HEADER.exec(rawLine.trim());
    if (!header) continue;
    if (entries.length >= MAX_LINES) return null;
    const startMs = krcMs(header[1] ?? "");
    const durationMs = krcMs(header[2] ?? "");
    const body = header[3] ?? "";
    if (startMs === null || durationMs === null || startMs + durationMs > MAX_LYRIC_TIME_MS) {
      clocksValid = false;
      entries.push({ startMs: 0, endMs: 0, ...krcLine(body, 0, 0) });
      continue;
    }
    entries.push({ startMs, endMs: startMs + durationMs, ...krcLine(body, startMs, startMs + durationMs) });
  }
  if (entries.length === 0) return null;
  if (entries.some((entry) => entry.text.length > MAX_LINE_CHARS)) return null;
  const offsetMs = lrcOffsetToContract(text);
  if (!clocksValid) {
    const lines = entries.filter((entry) => entry.text).map((entry) => ({ text: entry.text }));
    return lines.length > 0 ? { timing: "plain-text", offsetMs: 0, lines } : null;
  }
  entries.sort((a, b) => a.startMs - b.startMs);
  const sung = entries.filter((entry) => entry.text);
  const wordTimed = sung.length > 0 && sung.every((entry) => entry.words !== null);
  const lines: LyricLine[] = entries.map((entry) => ({
    startMs: entry.startMs,
    endMs: entry.endMs,
    text: entry.text,
    ...(wordTimed && entry.text && entry.words ? { words: entry.words } : {})
  }));
  return { timing: wordTimed ? "native-word" : "native-line", offsetMs, lines };
}

/** Untimed text: one line per non-empty row, never given invented times. */
export function parsePlain(text: string): ParsedLyrics | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_LINES || lines.some((line) => line.length > MAX_LINE_CHARS)) return null;
  return { timing: "plain-text", offsetMs: 0, lines: lines.map((line) => ({ text: line })) };
}

/**
 * The declared format is the one the source actually delivered: a KRC
 * document that does not parse is refused rather than re-read as LRC, and an
 * LRC document only falls back to plain text when it carries no time stamps.
 */
export function parseLyricsDocument(format: "lrc" | "krc" | "plain", text: string): ParsedLyrics | null {
  if (format === "krc") return parseKrc(text);
  if (format === "lrc") {
    const outcome = lrcOutcome(text);
    if (outcome === "untimed") return parsePlain(stripLrcMetadata(text));
    return outcome === "refused" ? null : outcome;
  }
  return parsePlain(text);
}

/** Which timed format a decoded document actually is, judged from its content. */
export function detectLyricsFormat(text: string): "krc" | "lrc" | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => KRC_HEADER.test(line))) return "krc";
  if (lines.some((line) => LRC_STAMP.test(line))) return "lrc";
  return null;
}

function stripLrcMetadata(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[[a-z]+:[^\]]*\]\s*$/i.test(line))
    .join("\n");
}
