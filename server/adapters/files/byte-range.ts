import fs from "node:fs";
import type { MediaStream } from "../../ports/media-source.js";

export type ByteRange = { readonly start: number; readonly end: number } | "unsatisfiable" | null;

/** Single "bytes=a-b" / "bytes=a-" / "bytes=-n" range; multi-ranges are served whole (null). */
export function parseByteRange(header: string | null, size: number): ByteRange {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return header.includes(",") ? null : "unsatisfiable";
  const [, startText = "", endText = ""] = match;
  if (!startText && !endText) return "unsatisfiable";
  if (!startText) {
    const suffix = Number(endText);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  const end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

export function contentTypeFor(extension: string): string {
  switch (extension.toLowerCase()) {
    case "mp3":
      return "audio/mpeg";
    case "flac":
      return "audio/flac";
    case "m4a":
    case "aac":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "ogg":
    case "opus":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

/** Serves a file (or a byte range of it) as a MediaStream with 200/206/416 semantics. */
export function fileStream(filePath: string, size: number, contentType: string, rangeHeader: string | null, signal: AbortSignal): MediaStream {
  const range = parseByteRange(rangeHeader, size);
  if (range === "unsatisfiable") {
    return { status: 416, headers: { "Content-Range": `bytes */${size}` }, body: null };
  }
  if (range === null) {
    return {
      status: 200,
      headers: { "Content-Type": contentType, "Content-Length": String(size), "Accept-Ranges": "bytes" },
      body: fs.createReadStream(filePath, { signal })
    };
  }
  return {
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(range.end - range.start + 1),
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Accept-Ranges": "bytes"
    },
    body: fs.createReadStream(filePath, { start: range.start, end: range.end, signal })
  };
}

/** Same semantics over an in-memory buffer (fixtures and fake providers). */
export function bytesStream(bytes: Uint8Array, contentType: string, rangeHeader: string | null): MediaStream {
  const range = parseByteRange(rangeHeader, bytes.length);
  if (range === "unsatisfiable") return { status: 416, headers: { "Content-Range": `bytes */${bytes.length}` }, body: null };
  const slice = range === null ? bytes : bytes.subarray(range.start, range.end + 1);
  const headers: Record<string, string> = { "Content-Type": contentType, "Content-Length": String(slice.length), "Accept-Ranges": "bytes" };
  if (range !== null) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${bytes.length}`;
  return {
    status: range === null ? 200 : 206,
    headers,
    body: (async function* () {
      yield slice;
    })()
  };
}
