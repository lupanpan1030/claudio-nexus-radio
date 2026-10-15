import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { asId, type DurationInfo, type RecordingId, type TrackRef } from "@claudio/contracts";
import { appError, throwIfAborted } from "../../application/errors.js";
import { refScopedRevision } from "../../application/sources.js";
import type { RawLyrics, LyricsLookup, LyricsSourcePort } from "../../ports/lyrics.js";
import type { MediaSourcePort, MediaStream, ResolveContext, ResolvedSource, SourceBinding, StreamRequest } from "../../ports/media-source.js";
import { probeAudioFileDuration } from "../audio/duration.js";
import { contentTypeFor, fileHandleStream } from "../files/byte-range.js";
import type { TrackRow, TrackRowReader } from "../sqlite/track-catalog.js";

const MAX_LYRIC_BYTES = 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
/** Hash passes over a file that keeps changing before giving up (the read itself is retried once). */
const HASH_ATTEMPTS = 2;

/**
 * What the file system says about the exact file object behind an open
 * descriptor. Times stay decimal nanosecond strings: Number cannot hold them.
 * An atomic replace changes ino (and ctime); an in-place rewrite changes
 * ctime even when size and mtime are restored, and ctime cannot be set from
 * user space.
 */
export type FileIdentity = {
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
};

export type FileIdentityReader = (stat: fs.BigIntStats) => FileIdentity;

export const fileIdentity: FileIdentityReader = (stat) => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  size: Number(stat.size),
  mtimeNs: String(stat.mtimeNs),
  ctimeNs: String(stat.ctimeNs)
});

export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/**
 * True when the file system does not give fields that tell two file objects
 * or two writes apart (no inode number or no change time). Such files are
 * never trusted by metadata: they are hashed on every resolve and on every open.
 */
export function isWeakFileIdentity(identity: FileIdentity): boolean {
  return identity.ino === "0" || identity.ctimeNs === "0";
}

interface Fingerprint {
  readonly sha256: string;
  readonly duration: DurationInfo;
  readonly identity: FileIdentity;
}

async function openForRead(filePath: string): Promise<fs.promises.FileHandle> {
  try {
    return await fs.promises.open(filePath, "r");
  } catch {
    throw appError("unavailable", "local_file_missing", "the local file no longer exists");
  }
}

/** SHA-256 of exactly `size` bytes read from the open descriptor, chunk by chunk. */
async function hashOpenFile(handle: fs.promises.FileHandle, size: number, signal: AbortSignal): Promise<string | null> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, Math.max(1, size)));
  let position = 0;
  while (position < size) {
    throwIfAborted(signal);
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (bytesRead === 0) return null;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  // A file that grew while being read is not the file that was measured.
  const { bytesRead } = await handle.read(buffer, 0, 1, size);
  return bytesRead === 0 ? hash.digest("hex") : null;
}

function readerFor(handle: fs.promises.FileHandle, size: number) {
  return {
    size,
    async readAt(position: number, length: number): Promise<Uint8Array> {
      const bytes = Buffer.alloc(Math.max(0, Math.min(length, size - position)));
      if (bytes.length === 0) return bytes;
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, position);
      return bytes.subarray(0, bytesRead);
    }
  };
}

/**
 * Content hash per exact file identity, read from one open descriptor. The
 * descriptor's identity is checked before and after hashing; a file that
 * changed meanwhile is hashed again (bounded) or refused, never cached under
 * an identity it did not have.
 */
export class LocalFingerprints {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
    private readonly identityOf: FileIdentityReader = fileIdentity
  ) {}

  async get(filePath: string, extension: string, signal: AbortSignal): Promise<Fingerprint> {
    const handle = await openForRead(filePath);
    try {
      for (let attempt = 0; attempt < HASH_ATTEMPTS; attempt += 1) {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile()) throw appError("unavailable", "local_file_missing");
        const before = this.identityOf(stat);
        const cached = isWeakFileIdentity(before) ? null : this.cached(filePath, before);
        if (cached) return { ...cached, identity: before };

        const sha256 = await hashOpenFile(handle, before.size, signal);
        const duration = await probeAudioFileDuration(readerFor(handle, before.size), extension);
        throwIfAborted(signal);
        const after = this.identityOf(await handle.stat({ bigint: true }));
        if (sha256 === null || !sameFileIdentity(before, after)) continue;
        if (!isWeakFileIdentity(before)) this.store(filePath, before, sha256, duration);
        return { sha256, duration, identity: before };
      }
    } finally {
      await handle.close();
    }
    throw appError("retryable", "local_file_unstable", "the file kept changing while it was read");
  }

  private cached(filePath: string, identity: FileIdentity): { sha256: string; duration: DurationInfo } | null {
    const row = this.db
      .prepare(
        `SELECT sha256, duration_json FROM local_content_fingerprints
         WHERE file_path = ? AND size = ? AND dev = ? AND ino = ? AND mtime_ns = ? AND ctime_ns = ?`
      )
      .get(filePath, identity.size, identity.dev, identity.ino, identity.mtimeNs, identity.ctimeNs) as
      | { sha256: string; duration_json: string }
      | undefined;
    return row ? { sha256: row.sha256, duration: JSON.parse(row.duration_json) as DurationInfo } : null;
  }

  private store(filePath: string, identity: FileIdentity, sha256: string, duration: DurationInfo): void {
    this.db
      .prepare(
        `INSERT INTO local_content_fingerprints (file_path, size, mtime_ms, sha256, duration_json, computed_at, dev, ino, mtime_ns, ctime_ns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256,
           duration_json = excluded.duration_json, computed_at = excluded.computed_at, dev = excluded.dev, ino = excluded.ino,
           mtime_ns = excluded.mtime_ns, ctime_ns = excluded.ctime_ns`
      )
      .run(
        filePath,
        identity.size,
        Math.trunc(Number(BigInt(identity.mtimeNs) / 1_000_000n)),
        sha256,
        JSON.stringify(duration),
        this.now(),
        identity.dev,
        identity.ino,
        identity.mtimeNs,
        identity.ctimeNs
      );
  }
}

type LocalBinding = FileIdentity & {
  readonly filePath: string;
  readonly sha256: string;
  readonly extension: string;
};

/**
 * Bindings written before exact file identity existed (size + ms mtime only)
 * cannot vouch for the file any more: they are refused as expired so the
 * caller resolves again, never trusted under their old identity.
 */
function readBinding(binding: SourceBinding): LocalBinding {
  const { filePath, size, sha256, extension, dev, ino, mtimeNs, ctimeNs } = binding;
  if (typeof filePath !== "string" || typeof size !== "number" || typeof sha256 !== "string") {
    throw appError("invalid", "local_binding_corrupt");
  }
  if (typeof dev !== "string" || typeof ino !== "string" || typeof mtimeNs !== "string" || typeof ctimeNs !== "string") {
    throw appError("expired", "local_binding_outdated", "the binding predates exact file identity; resolve again");
  }
  return { filePath, size, sha256, dev, ino, mtimeNs, ctimeNs, extension: typeof extension === "string" ? extension : "" };
}

/**
 * Local files. The recording identity is the file's content hash, shared by
 * every catalog entry holding the same bytes; the revision is scoped to the
 * ref and the file, so two entries never share one, and a replaced or moved
 * file is a new revision.
 *
 * Each open checks the descriptor it is about to stream from against the
 * bound file identity (and, where the file system cannot tell writes apart,
 * the hash), so a file replaced or rewritten before the open is refused, and
 * an atomic replace during a response leaves that response reading the old
 * file object. What is checked is the state at open time, not a frozen copy:
 * a writer that keeps modifying the same file in place while it is being
 * streamed can still change the bytes later in that response. The next open
 * then sees the changed identity and is refused. Bytes are not copied into an
 * immutable store or re-hashed per Range request to close that gap.
 */
export class LocalMediaSource implements MediaSourcePort {
  private readonly identityOf: FileIdentityReader;

  constructor(
    private readonly deps: {
      readonly rows: TrackRowReader;
      readonly sources: readonly string[];
      readonly fingerprints: LocalFingerprints;
      /** When set, only files inside this directory are served. */
      readonly libraryDir: string;
      /** Test seam for file systems with weak identity fields. */
      readonly identityOf?: FileIdentityReader;
    }
  ) {
    this.identityOf = deps.identityOf ?? fileIdentity;
  }

  async resolve(ref: TrackRef, context: ResolveContext): Promise<ResolvedSource> {
    const { row, filePath } = this.locate(ref);
    const extension = row.extension || path.extname(filePath).slice(1);
    const fingerprint = await this.deps.fingerprints.get(filePath, extension, context.signal);
    const binding: LocalBinding = { filePath, ...fingerprint.identity, sha256: fingerprint.sha256, extension };
    return {
      recording: { recordingId: asId<RecordingId>(`local:${fingerprint.sha256.slice(0, 32)}`), confidence: "content-hash" },
      sourceRevision: refScopedRevision("lr-", ref, [filePath, fingerprint.sha256]),
      duration: fingerprint.duration,
      capabilities: { seekable: true, rangeRequests: true },
      expiresAt: null,
      binding
    };
  }

  /** Cheap list check: the row is playable and its file exists in the library. No hashing, no identity claim. */
  async checkPlayable(ref: TrackRef): Promise<boolean> {
    try {
      const { filePath } = this.locate(ref);
      return (await fs.promises.stat(filePath)).isFile();
    } catch {
      return false;
    }
  }

  async open(raw: SourceBinding, request: StreamRequest): Promise<MediaStream> {
    const binding = readBinding(raw);
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(binding.filePath, "r");
    } catch {
      throw appError("expired", "local_file_missing", "the bound file is gone; resolve again");
    }
    try {
      const current = this.identityOf(await handle.stat({ bigint: true }));
      if (!sameFileIdentity(current, binding)) throw appError("expired", "local_file_changed", "the bound file changed; resolve again");
      if (isWeakFileIdentity(current) && (await hashOpenFile(handle, current.size, request.signal)) !== binding.sha256) {
        throw appError("expired", "local_file_changed", "the bound file changed; resolve again");
      }
    } catch (error) {
      await handle.close();
      throw error;
    }
    return fileHandleStream(handle, binding.size, contentTypeFor(binding.extension), request.range, request.signal);
  }

  private locate(ref: TrackRef): { row: TrackRow; filePath: string } {
    const row = this.deps.rows.get(ref.mediaId, this.deps.sources);
    if (!row) throw appError("unavailable", "track_not_found");
    if (!row.playable) throw appError("unavailable", "track_not_playable", "file format is not browser-playable");
    const filePath = path.resolve(row.filePath);
    if (this.deps.libraryDir && !isInside(path.resolve(this.deps.libraryDir), filePath)) {
      throw appError("unavailable", "local_file_outside_library");
    }
    return { row, filePath };
  }
}

/** Lyrics only from a sidecar next to the bound file (same stem): .lrc timed, .txt plain. */
export class LocalSidecarLyrics implements LyricsSourcePort {
  async fetch(lookup: LyricsLookup, options: { readonly signal: AbortSignal }): Promise<RawLyrics> {
    let binding: LocalBinding;
    try {
      binding = readBinding(lookup.binding);
      if (!sameFileIdentity(fileIdentity(await fs.promises.stat(binding.filePath, { bigint: true })), binding)) return { kind: "unmatched" };
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
