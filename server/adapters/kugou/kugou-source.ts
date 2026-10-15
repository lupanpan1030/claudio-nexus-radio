import { createHash } from "node:crypto";
import {
  asId,
  type RecordingConfidence,
  type RecordingId,
  type SourceRevision,
  type TrackRef
} from "@claudio/contracts";
import { appError, isAbort, throwIfAborted } from "../../application/errors.js";
import { raceAbort } from "../../application/operations.js";
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

interface KuGouBinding {
  /** The hash this catalog entry resolved to (the recording). */
  readonly hash: string;
  /** File hash the URL endpoint reported, when it reported one. */
  readonly servedHash: string | null;
  readonly url: string;
  readonly confidence: RecordingConfidence;
  readonly accountRevision: string | null;
  readonly fetchedAt: number;
}

function readBinding(binding: SourceBinding): KuGouBinding {
  if (typeof binding.hash !== "string" || !HASH.test(binding.hash) || typeof binding.url !== "string") {
    throw appError("invalid", "kugou_binding_corrupt");
  }
  return binding as unknown as KuGouBinding;
}

/** First http(s) audio-looking URL from the url/backup fields (deep), as the legacy resolver did. */
export function extractAudioUrl(value: unknown, depth = 0): string {
  if (!value || depth > 6) return "";
  if (typeof value === "string") {
    const match = /https?:\/\/[^\s"'<>]+/i.exec(value)?.[0] ?? "";
    return match && !/\.(jpg|jpeg|png|webp|gif)($|\?)/i.test(match) ? match : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractAudioUrl(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["url", "backupUrl", "backup_url", "play_url", "playUrl", "audio_url"]) {
    const found = extractAudioUrl(record[key], depth + 1);
    if (found) return found;
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") {
      const found = extractAudioUrl(child, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function reportedHash(body: unknown): string | null {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : {};
  for (const value of [record.hash, data.hash]) {
    if (typeof value === "string" && HASH.test(value)) return value.toUpperCase();
  }
  return null;
}

/**
 * KuGou playback. The recording is the resolved hash; the URL endpoint's
 * reported file hash also enters the revision. Refreshing a signed URL for
 * the same hash keeps the revision; a different hash is a new revision.
 * Streams are proxied with the caller's Range and never fall back to
 * another recording or to a local file.
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
    const { url, servedHash } = await this.fetchUrl(target.hash, context.signal);
    const recordingHash = target.hash.toUpperCase();
    const revision = createHash("sha256").update(`${recordingHash}|${servedHash ?? recordingHash}`).digest("hex").slice(0, 40);
    const now = this.deps.clock.now();
    const binding: KuGouBinding = {
      hash: recordingHash,
      servedHash,
      url,
      confidence: target.confidence,
      accountRevision: this.deps.client.accountRevision(),
      fetchedAt: now
    };
    return {
      recording: { recordingId: asId<RecordingId>(`kugou:${recordingHash}`), confidence: target.confidence },
      sourceRevision: asId<SourceRevision>(`kg-${revision}`),
      // The URL endpoint's length fields are not verified against the real service: leave unknown.
      duration: { kind: "unknown" },
      capabilities: { seekable: true, rangeRequests: true },
      expiresAt: now + this.deps.urlTtlMs,
      binding: binding as unknown as SourceBinding
    };
  }

  private async locate(row: TrackRow, signal: AbortSignal): Promise<{ hash: string; confidence: RecordingConfidence }> {
    const key = row.filePath.startsWith("kugou://") ? safeDecode(row.filePath.slice("kugou://".length)) : "";
    if (HASH.test(key)) return { hash: key, confidence: "provider-asserted" };
    // Synced without a hash: a title/artist search can find *a* recording, never prove it is the same one.
    const hits = await raceAbort(Promise.resolve(this.deps.search(`${row.artist} ${row.title}`.trim(), 6)), signal);
    const minimum = row.artist.trim() ? 85 : 70;
    const best = hits
      .filter((hit) => hit.hash && HASH.test(hit.hash))
      .map((hit) => ({ hit, score: this.deps.score({ title: row.title, artist: row.artist }, hit) }))
      .sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < minimum) throw appError("unavailable", "kugou_no_match", "no confident KuGou match");
    return { hash: best.hit.hash!, confidence: "unverified" };
  }

  private async fetchUrl(hash: string, signal: AbortSignal): Promise<{ url: string; servedHash: string | null }> {
    const requests = [
      { pathname: "/song/url", params: { hash, quality: 320 } },
      { pathname: "/song/url", params: { hash, quality: 128 } },
      { pathname: "/song/url/new", params: { hash } }
    ];
    const authModes = this.deps.client.hasCredentials() ? [true, false] : [false];
    let lastError: unknown = appError("unavailable", "kugou_no_url", "KuGou returned no playable URL");
    for (const request of requests) {
      for (const auth of authModes) {
        throwIfAborted(signal);
        try {
          const body = await this.deps.client.get(request.pathname, request.params, { auth, signal });
          const url = extractAudioUrl(body);
          if (url) return { url, servedHash: reportedHash(body) };
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
    if (binding.accountRevision !== null && binding.accountRevision !== this.deps.client.accountRevision()) {
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
      void response.body?.cancel();
      return { status: 416, headers: { "Content-Range": response.headers.get("content-range") ?? "bytes */*" }, body: null };
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel();
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
 * Lyrics through the KuGouMusicApi /search/lyric → /lyric chain, keyed only
 * by the bound recording hash (never by title). Endpoint names follow the
 * KuGouMusicApi docs and Folia's provider; not verified against the bundled
 * service on this machine.
 */
export class KuGouLyrics implements LyricsSourcePort {
  constructor(private readonly client: KuGouClient, private readonly durationToleranceMs = 3000) {}

  async fetch(lookup: LyricsLookup, options: { readonly signal: AbortSignal }): Promise<RawLyrics> {
    const binding = readBinding(lookup.binding);
    const hash = binding.servedHash ?? binding.hash;
    const searched = await this.client.get("/search/lyric", { hash, man: "no" }, { auth: false, signal: options.signal });
    const candidates = candidateList(searched);
    const candidate = candidates.find((item) => item.id && item.accesskey);
    if (!candidate) return { kind: "missing", reason: "not-found" };
    const known = lookup.duration.kind === "known" ? lookup.duration.ms : null;
    if (known !== null && candidate.durationMs !== null && Math.abs(candidate.durationMs - known) > this.durationToleranceMs) {
      return { kind: "unmatched" };
    }
    for (const fmt of ["krc", "lrc"] as const) {
      const body = await this.client.get("/lyric", { id: candidate.id, accesskey: candidate.accesskey, fmt, decode: true }, { auth: false, signal: options.signal });
      const text = decodedText(body);
      if (text.trim()) return { kind: "text", format: fmt, text, documentKey: `kugou-lyric:${candidate.id}:${fmt}` };
    }
    return { kind: "missing", reason: "not-found" };
  }
}

function candidateList(body: unknown): { id: string; accesskey: string; durationMs: number | null }[] {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : {};
  const list = Array.isArray(record.candidates) ? record.candidates : Array.isArray(data.candidates) ? data.candidates : [];
  return list.map((item) => {
    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const duration = Number(entry.duration);
    return {
      id: entry.id === undefined ? "" : String(entry.id),
      accesskey: typeof entry.accesskey === "string" ? entry.accesskey : "",
      durationMs: Number.isFinite(duration) && duration > 0 ? duration : null
    };
  });
}

function decodedText(body: unknown): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : {};
  const value = record.decodeContent ?? data.decodeContent;
  return typeof value === "string" ? value : "";
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
