import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import type { MediaStream } from "../ports/media-source.js";
import { sendError } from "./errors.js";

/** AbortSignal tied to the client connection: closing the request cancels upstream work. */
export function requestSignal(req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    if (!res.writableFinished) controller.abort(new Error("client disconnected"));
  };
  req.once("aborted", abort);
  res.once("close", abort);
  return controller.signal;
}

/** Copies a MediaStream to the response; client disconnects abort the source. */
export async function pipeMediaStream(open: (signal: AbortSignal) => Promise<MediaStream>, req: Request, res: Response): Promise<void> {
  const signal = requestSignal(req, res);
  let stream: MediaStream;
  try {
    stream = await open(signal);
  } catch (error) {
    if (!signal.aborted) sendError(res, error);
    return;
  }
  if (signal.aborted) {
    // The client left while the source was opening: nobody will read this body.
    releaseBody(stream.body);
    return;
  }
  res.status(stream.status);
  for (const [name, value] of Object.entries(stream.headers)) res.setHeader(name, value);
  res.setHeader("Cache-Control", "no-store");
  if (!stream.body || req.method === "HEAD") {
    releaseBody(stream.body);
    res.end();
    return;
  }
  try {
    await pipeline(Readable.from(stream.body), res, { signal });
  } catch {
    // Client went away or upstream broke mid-body; the connection is already closed.
    if (!res.destroyed) res.destroy();
  }
}

/**
 * A body that will never be read still holds its file or connection; let it
 * go. A Node stream is destroyed (closing its file descriptor); a fetch body
 * (a WHATWG ReadableStream, which has no `return`) is cancelled, closing the
 * upstream connection; any other async iterable is ended through its
 * iterator. Failures are ignored: the body is being discarded either way.
 */
function releaseBody(body: MediaStream["body"]): void {
  if (!body) return;
  if (body instanceof Readable) {
    body.destroy();
    return;
  }
  const web = body as { cancel?: () => Promise<void>; locked?: boolean };
  if (typeof web.cancel === "function") {
    if (!web.locked) web.cancel().catch(ignore);
    return;
  }
  const iterator = body[Symbol.asyncIterator]();
  Promise.resolve()
    .then(() => iterator.return?.())
    .catch(ignore);
}

function ignore(): void {}
