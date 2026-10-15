import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { asId, type DurationInfo, type RecordingId, type SourceRevision, type TrackRef } from "@claudio/contracts";
import { appError, throwIfAborted } from "../../application/errors.js";
import type { RawLyrics, LyricsLookup, LyricsSourcePort } from "../../ports/lyrics.js";
import type { MediaSourcePort, MediaStream, ResolveContext, ResolvedSource, SourceBinding, StreamRequest } from "../../ports/media-source.js";
import { probeAudioDuration } from "../audio/duration.js";
import { contentTypeFor, fileStream } from "../files/byte-range.js";
import type { TrackRowReader } from "../sqlite/track-catalog.js";

/** Files larger than this are hashed by streaming and their duration left unknown. */
const MAX_IN_MEMORY_BYTES = 256 * 1024 * 1024;
const MAX_LYRIC_BYTES = 1024 * 1024;

interface Fingerprint {
  readonly sha256: string;
  readonly duration: DurationInfo;
}

/** Content hash per (path, size, mtime); recomputed whenever the file changes. */
export class LocalFingerprints {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}

  async get(filePath: string, stat: fs.Stats, extension: string, signal: AbortSignal): Promise<Fingerprint> {
    const row = this.db
      .prepare("SELECT sha256, duration_json FROM local_content_fingerprints WHERE file_path = ? AND size = ? AND mtime_ms = ?")
      .get(filePath, stat.size, Math.trunc(stat.mtimeMs)) as { sha256: string; duration_json: string } | undefined;
    if (row) return { sha256: row.sha256, duration: JSON.parse(row.duration_json) as DurationInfo };

    let fingerprint: Fingerprint;
    if (stat.size <= MAX_IN_MEMORY_BYTES) {
      const bytes = new Uint8Array(await fs.promises.readFile(filePath, { signal }));
      fingerprint = { sha256: createHash("sha256").update(bytes).digest("hex"), duration: probeAudioDuration(bytes, extension) };
    } else {
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(filePath, { signal })) hash.update(chunk as Buffer);
      fingerprint = { sha256: hash.digest("hex"), duration: { kind: "unknown" } };
    }
    throwIfAborted(signal);
    this.db
      .prepare(
        `INSERT INTO local_content_fingerprints (file_path, size, mtime_ms, sha256, duration_json, computed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256,
           duration_json = excluded.duration_json, computed_at = excluded.computed_at`
      )
      .run(filePath, stat.size, Math.trunc(stat.mtimeMs), fingerprint.sha256, JSON.stringify(fingerprint.duration), this.now());
    return fingerprint;
  }
}

type LocalBinding = {
  readonly filePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly extension: string;
};

function readBinding(binding: SourceBinding): LocalBinding {
  const { filePath, size, mtimeMs, sha256, extension } = binding;
  if (typeof filePath !== "string" || typeof size !== "number" || typeof mtimeMs !== "number" || typeof sha256 !== "string") {
    throw appError("invalid", "local_binding_corrupt");
  }
  return { filePath, size, mtimeMs, sha256, extension: typeof extension === "string" ? extension : "" };
}

/**
 * Local files. The recording identity is the file's content hash, so a
 * replaced file is a new revision; a handle never serves different bytes.
 */
export class LocalMediaSource implements MediaSourcePort {
  constructor(
    private readonly deps: {
      readonly rows: TrackRowReader;
      readonly sources: readonly string[];
      readonly fingerprints: LocalFingerprints;
      /** When set, only files inside this directory are served. */
      readonly libraryDir: string;
    }
  ) {}

  async resolve(ref: TrackRef, context: ResolveContext): Promise<ResolvedSource> {
    const row = this.deps.rows.get(ref.mediaId, this.deps.sources);
    if (!row) throw appError("unavailable", "track_not_found");
    if (!row.playable) throw appError("unavailable", "track_not_playable", "file format is not browser-playable");
    const filePath = path.resolve(row.filePath);
    if (this.deps.libraryDir && !isInside(path.resolve(this.deps.libraryDir), filePath)) {
      throw appError("unavailable", "local_file_outside_library");
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      throw appError("unavailable", "local_file_missing", "the local file no longer exists");
    }
    if (!stat.isFile()) throw appError("unavailable", "local_file_missing");
    const extension = row.extension || path.extname(filePath).slice(1);
    const fingerprint = await this.deps.fingerprints.get(filePath, stat, extension, context.signal);
    const binding: LocalBinding = { filePath, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), sha256: fingerprint.sha256, extension };
    return {
      recording: { recordingId: asId<RecordingId>(`local:${fingerprint.sha256.slice(0, 32)}`), confidence: "content-hash" },
      sourceRevision: asId<SourceRevision>(`lr-${fingerprint.sha256.slice(0, 40)}`),
      duration: fingerprint.duration,
      capabilities: { seekable: true, rangeRequests: true },
      expiresAt: null,
      binding
    };
  }

  async open(raw: SourceBinding, request: StreamRequest): Promise<MediaStream> {
    const binding = readBinding(raw);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(binding.filePath);
    } catch {
      throw appError("expired", "local_file_missing", "the bound file is gone; resolve again");
    }
    if (stat.size !== binding.size || Math.trunc(stat.mtimeMs) !== binding.mtimeMs) {
      throw appError("expired", "local_file_changed", "the bound file changed; resolve again");
    }
    return fileStream(binding.filePath, stat.size, contentTypeFor(binding.extension), request.range, request.signal);
  }
}

/** Lyrics only from a sidecar next to the bound file (same stem): .lrc timed, .txt plain. */
export class LocalSidecarLyrics implements LyricsSourcePort {
  async fetch(lookup: LyricsLookup, options: { readonly signal: AbortSignal }): Promise<RawLyrics> {
    const binding = readBinding(lookup.binding);
    try {
      const stat = await fs.promises.stat(binding.filePath);
      if (stat.size !== binding.size || Math.trunc(stat.mtimeMs) !== binding.mtimeMs) return { kind: "unmatched" };
    } catch {
      return { kind: "unmatched" };
    }
    const parsed = path.parse(binding.filePath);
    for (const [extension, format] of [[".lrc", "lrc"], [".LRC", "lrc"], [".txt", "plain"]] as const) {
      const candidate = path.join(parsed.dir, `${parsed.name}${extension}`);
      let bytes: Buffer;
      try {
        const stat = await fs.promises.stat(candidate);
        if (!stat.isFile() || stat.size > MAX_LYRIC_BYTES) continue;
        bytes = await fs.promises.readFile(candidate, { signal: options.signal });
      } catch {
        continue;
      }
      const text = bytes.toString("utf8").replace(/^﻿/, "");
      return { kind: "text", format, text, documentKey: `local-sidecar:${createHash("sha256").update(bytes).digest("hex")}` };
    }
    return { kind: "missing", reason: "not-found" };
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
