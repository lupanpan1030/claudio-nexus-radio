import { asId, type RecordingConfidence, type RecordingId, type TrackRef } from "@claudio/contracts";
import { appError, isAbort, throwIfAborted } from "../../application/errors.js";
import { detectLyricsFormat, parseLyricsDocument } from "../../application/lyrics/parse.js";
import { raceAbort } from "../../application/operations.js";
import { refScopedRevision } from "../../application/sources.js";
import type { LyricsLookup, LyricsSourcePort, RawLyrics } from "../../ports/lyrics.js";
import type { MediaSourcePort, MediaStream, ResolveContext, ResolvedSource, SourceBinding, StreamRequest } from "../../ports/media-source.js";
import type { Clock } from "../../ports/runtime.js";
import type { TrackRow, TrackRowReader } from "../sqlite/track-catalog.js";
import type { KuGouClient } from "./client.js";

const HASH = /^[0-9a-f]{32}$/i;

export interface KuGouSearchHit {
  readonly title: string;
  readonly artist?: string;
  readonly hash?: string;
}

/** Which URL request produced a binding: the two /song/url qualities are different files. */
export type KuGouVariant = "q320" | "q128" | "new";

interface KuGouBinding {
  /** The hash this catalog entry resolved to (what refreshes request again). */
  readonly hash: string;
  /** Hash the URL response itself reported for the served file; null when it reported none. */
  readonly servedHash: string | null;
  /** Null only in bindings written before variants were recorded. */
  readonly variant: KuGouVariant | null;
  readonly confidence: RecordingConfidence;
  readonly fetchedAt: number;
  /** Absent once scrubbed: signed URL and account tag are short-lived private data. */
  readonly url?: string;
  readonly accountRevision?: string | null;
  readonly scrubbed?: true;
}

function readBinding(binding: SourceBinding): KuGouBinding {
  const { hash, url, servedHash, variant, scrubbed } = binding;
  if (typeof hash !== "string" || !HASH.test(hash)) throw appError("invalid", "kugou_binding_corrupt");
  if (scrubbed !== true && typeof url !== "string") throw appError("invalid", "kugou_binding_corrupt");
  if (servedHash !== undefined && servedHash !== null && (typeof servedHash !== "string" || !HASH.test(servedHash))) {
    throw appError("invalid", "kugou_binding_corrupt");
  }
  return {
    ...(binding as unknown as KuGouBinding),
    servedHash: typeof servedHash === "string" ? servedHash.toUpperCase() : null,
    variant: variant === "q320" || variant === "q128" || variant === "new" ? variant : null
  };
}

const URL_KEYS = ["url", "backupUrl", "backup_url", "play_url", "playUrl", "audio_url"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function httpAudioUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const match = /^https?:\/\/[^\s"'<>]+$/i.exec(value.trim())?.[0] ?? "";
  return match && !/\.(jpg|jpeg|png|webp|gif)($|\?)/i.test(match) ? match : "";
}

/** First http(s) URL under one entry's own known URL keys (a string or a list of strings); no deeper search. */
function entryUrl(entry: Record<string, unknown>): string {
  for (const key of URL_KEYS) {
    const value = entry[key];
    for (const candidate of Array.isArray(value) ? value : [value]) {
      const url = httpAudioUrl(candidate);
      if (url) return url;
    }
  }
  return "";
}

function entryHash(entry: Record<string, unknown> | null): string | null {
  const value = entry?.hash;
  return typeof value === "string" && HASH.test(value) ? value.toUpperCase() : null;
}

/**
 * A URL together with the hash reported *in the same entry*. `flat` entries
 * are the top-level body and `data` object (the shape the legacy client read
 * from /song/url): a data-level URL may take the top-level hash. `listed`
 * entries are objects inside a `data` array or an array directly under
 * `data`; they only ever carry their own hash. Nothing deeper is searched:
 * an unknown nesting is not evidence of what file a URL serves.
 */
export interface KuGouUrlEntry {
  readonly url: string;
  readonly hash: string | null;
  readonly listed: boolean;
}

export function kugouUrlEntries(body: unknown): KuGouUrlEntry[] {
  const top = asRecord(body);
  if (!top) return [];
  const entries: KuGouUrlEntry[] = [];
  const add = (entry: Record<string, unknown>, hash: string | null, listed: boolean) => {
    const url = entryUrl(entry);
    if (url) entries.push({ url, hash, listed });
  };
  add(top, entryHash(top), false);
  const data = top.data;
  const dataRecord = asRecord(data);
  if (dataRecord) add(dataRecord, entryHash(dataRecord) ?? entryHash(top), false);
  const lists = Array.isArray(data) ? [data] : dataRecord ? Object.values(dataRecord).filter(Array.isArray) : [];
  for (const list of lists) {
    for (const item of list as unknown[]) {
      const record = asRecord(item);
      if (record) add(record, entryHash(record), true);
    }
  }
  return entries;
}

/**
 * Picks the served URL for a requested hash, or null. /song/url addresses
 * the file by the requested hash, so a flat URL without a reported hash
 * keeps that hash as its evidence; /song/url/new has no live sample and
 * returns several qualities at once, so only entries that carry their own
 * hash are accepted. Either way an entry reporting the requested hash is
 * preferred, and one reporting another hash is a different file.
 */
export function pickServedUrl(body: unknown, requestedHash: string, variant: KuGouVariant): { url: string; servedHash: string | null } | null {
  const wanted = requestedHash.toUpperCase();
  const entries = kugouUrlEntries(body).filter((entry) => entry.hash !== null || (variant !== "new" && !entry.listed));
  const chosen =
    entries.find((entry) => entry.hash === wanted) ??
    entries.find((entry) => entry.hash === null) ??
    entries.find((entry) => entry.hash !== null);
  return chosen ? { url: chosen.url, servedHash: chosen.hash } : null;
}

const URL_REQUESTS: readonly { readonly variant: KuGouVariant; readonly pathname: string; readonly quality?: number }[] = [
  { variant: "q320", pathname: "/song/url", quality: 320 },
  { variant: "q128", pathname: "/song/url", quality: 128 },
  { variant: "new", pathname: "/song/url/new" }
];

/**
 * KuGou playback. The recording is the file the URL response vouches for:
 * the requested hash, or the different hash the response reported for the
 * same entry. The revision is scoped to the catalog ref and names the
 * requested hash, the served hash and the URL variant, so a refresh keeps it
 * only when the same request yields the same file again: a new signed URL
 * for the same file keeps it; another reported hash or a fallback to another
 * quality is a new revision, and nothing bound to the old one (lyric clock,
 * position) carries over. Refreshes never search; they ask for the bound
 * hash, starting with the bound variant. Duration stays unknown (no
 * documented unit). Streams are proxied with the caller's Range and never
 * fall back to another recording or to a local file.
 */
export class KuGouMediaSource implements MediaSourcePort {
  constructor(
    private readonly deps: {
      readonly rows: TrackRowReader;
      readonly client: KuGouClient;
      readonly search: (keyword: string, limit: number) => Promise<readonly KuGouSearchHit[]>;
      readonly score: (wanted: { title: string; artist?: string }, hit: KuGouSearchHit) => number;
      readonly urlTtlMs: number;
      readonly clock: Clock;
      readonly fetch?: typeof fetch;
    }
  ) {}

  async resolve(ref: TrackRef, context: ResolveContext): Promise<ResolvedSource> {
    const row = this.deps.rows.get(ref.mediaId, ["kugou-api"]);
    if (!row) throw appError("unavailable", "track_not_found");
    if (!row.playable) throw appError("unavailable", "track_not_playable", "track left the synced KuGou library");

    const previous = context.previous ? readBinding(context.previous.binding) : null;
    const target = previous ? { hash: previous.hash, confidence: previous.confidence } : await this.locate(row, context.signal);
    const requestedHash = target.hash.toUpperCase();
    const served = await this.fetchUrl(requestedHash, previous?.variant ?? null, context.signal);
    const recordingHash = served.servedHash ?? requestedHash;
    const now = this.deps.clock.now();
    const binding: KuGouBinding = {
      hash: requestedHash,
      servedHash: served.servedHash,
      variant: served.variant,
      confidence: target.confidence,
      fetchedAt: now,
      url: served.url,
      accountRevision: this.deps.client.accountRevision()
    };
    return {
      recording: { recordingId: asId<RecordingId>(`kugou:${recordingHash}`), confidence: target.confidence },
      sourceRevision: refScopedRevision("kg-", ref, [requestedHash, recordingHash, served.variant]),
      duration: { kind: "unknown" },
      capabilities: { seekable: true, rangeRequests: true },
      expiresAt: now + this.deps.urlTtlMs,
      binding: binding as unknown as SourceBinding
    };
  }

  /** Earlier answers stop holding when the signed-in account changes. */
  playabilityScope(): string {
    return this.deps.client.accountRevision() ?? "signed-out";
  }

  scrubBinding(raw: SourceBinding): SourceBinding | null {
    const binding = readBinding(raw);
    if (binding.scrubbed) return null;
    const { url: _url, accountRevision: _account, ...kept } = binding;
    return { ...kept, scrubbed: true } as unknown as SourceBinding;
  }

  private async locate(row: TrackRow, signal: AbortSignal): Promise<{ hash: string; confidence: RecordingConfidence }> {
    const key = row.filePath.startsWith("kugou://") ? safeDecode(row.filePath.slice("kugou://".length)) : "";
    if (HASH.test(key)) return { hash: key, confidence: "provider-asserted" };
    // Synced without a hash: a title/artist search can find *a* recording, never prove it is the one the
    // catalog meant (confidence "unverified"). Once found, the hash itself is the recording: refreshes reuse it.
    const hits = await raceAbort(Promise.resolve(this.deps.search(`${row.artist} ${row.title}`.trim(), 6)), signal);
    const minimum = row.artist.trim() ? 85 : 70;
    const best = hits
      .filter((hit) => hit.hash && HASH.test(hit.hash))
      .map((hit) => ({ hit, score: this.deps.score({ title: row.title, artist: row.artist }, hit) }))
      .sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < minimum) throw appError("unavailable", "kugou_no_match", "no confident KuGou match");
    return { hash: best.hit.hash!, confidence: "unverified" };
  }

  private async fetchUrl(
    hash: string,
    preferred: KuGouVariant | null,
    signal: AbortSignal
  ): Promise<{ url: string; servedHash: string | null; variant: KuGouVariant }> {
    // A refresh asks the bound variant first, so an ordinary URL renewal can keep the revision.
    const requests = preferred ? [...URL_REQUESTS].sort((a, b) => Number(b.variant === preferred) - Number(a.variant === preferred)) : URL_REQUESTS;
    const authModes = this.deps.client.hasCredentials() ? [true, false] : [false];
    let lastError: unknown = appError("unavailable", "kugou_no_url", "KuGou returned no playable URL");
    for (const request of requests) {
      for (const auth of authModes) {
        throwIfAborted(signal);
        try {
          const params = request.quality === undefined ? { hash } : { hash, quality: request.quality };
          const body = await this.deps.client.get(request.pathname, params, { auth, signal });
          const served = pickServedUrl(body, hash, request.variant);
          if (served) return { ...served, variant: request.variant };
        } catch (error) {
          if (isAbort(error) || signal.aborted) throw error;
          lastError = error;
        }
      }
    }
    throw lastError;
  }

  async open(raw: SourceBinding, request: StreamRequest): Promise<MediaStream> {
    const binding = readBinding(raw);
    if (binding.scrubbed || !binding.url) throw appError("expired", "kugou_url_scrubbed", "the signed URL was discarded; resolve again");
    const account = binding.accountRevision ?? null;
    if (account !== null && account !== this.deps.client.accountRevision()) {
      throw appError("auth-required", "kugou_account_changed", "the KuGou account changed; resolve again");
    }
    const doFetch = this.deps.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(binding.url, { headers: request.range ? { Range: request.range } : {}, signal: request.signal });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw appError("retryable", "kugou_stream_unreachable", error instanceof Error ? error.message : undefined, error);
    }
    if (response.status === 416) {
      void response.body?.cancel().catch(() => undefined);
      return { status: 416, headers: { "Content-Range": response.headers.get("content-range") ?? "bytes */*" }, body: null };
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw appError(
        response.status === 403 || response.status === 404 || response.status === 410 ? "expired" : "retryable",
        "kugou_stream_failed",
        `remote audio returned ${response.status}`
      );
    }
    const headers: Record<string, string> = {};
    for (const header of ["accept-ranges", "content-length", "content-range"]) {
      const value = response.headers.get(header);
      if (value) headers[header] = value;
    }
    const type = response.headers.get("content-type");
    headers["content-type"] = type?.startsWith("audio/") ? type : "audio/mpeg";
    return { status: response.status === 206 ? 206 : 200, headers, body: response.body as unknown as AsyncIterable<Uint8Array> };
  }
}

/**
 * Lyrics through the bundled KuGouMusicApi /search/lyric → /lyric chain,
 * keyed only by the hash of the file the binding serves (the reported served
 * hash, else the requested one) — never by title. Checked against upstream KuGouMusicApi 06560e3e: /lyric?decode=true
 * adds `decodeContent`, which is KRC only when the document's `contenttype`
 * is 0 and otherwise the base64-decoded text regardless of the requested
 * fmt — so the format is taken from the content and the document must
 * parse as that format before it is accepted. The candidate list is the
 * lyrics service's own body passed through (`candidates[].id/accesskey`);
 * its duration unit is not documented, so durations are not compared.
 */
export class KuGouLyrics implements LyricsSourcePort {
  constructor(private readonly client: KuGouClient) {}

  async fetch(lookup: LyricsLookup, options: { readonly signal: AbortSignal }): Promise<RawLyrics> {
    const binding = readBinding(lookup.binding);
    const searched = await this.client.get("/search/lyric", { hash: binding.servedHash ?? binding.hash, man: "no" }, { auth: false, signal: options.signal });
    const candidate = candidateList(searched).find((item) => item.id && item.accesskey);
    if (!candidate) return { kind: "missing", reason: "not-found" };
    for (const fmt of ["krc", "lrc"] as const) {
      const body = await this.client.get("/lyric", { id: candidate.id, accesskey: candidate.accesskey, fmt, decode: true }, { auth: false, signal: options.signal });
      const text = decodedText(body);
      const format = detectLyricsFormat(text);
      // Unrecognised or unparseable content is not accepted under any label.
      if (!format || !parseLyricsDocument(format, text)) continue;
      return { kind: "text", format, text, documentKey: `kugou-lyric:${candidate.id}:${format}` };
    }
    return { kind: "missing", reason: "not-found" };
  }
}

function candidateList(body: unknown): { id: string; accesskey: string }[] {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : {};
  const list = Array.isArray(record.candidates) ? record.candidates : Array.isArray(data.candidates) ? data.candidates : [];
  return list.map((item) => {
    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      id: typeof entry.id === "string" || typeof entry.id === "number" ? String(entry.id) : "",
      accesskey: typeof entry.accesskey === "string" ? entry.accesskey : ""
    };
  });
}

function decodedText(body: unknown): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const value = record.decodeContent;
  return typeof value === "string" ? value.replace(/^\uFEFF/, "") : "";
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
