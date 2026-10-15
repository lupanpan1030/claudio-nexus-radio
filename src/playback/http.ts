import { apiErrorV1Decoder, decode, type Decoder, type ErrorClass, type ErrorInfo } from "@claudio/contracts";
import { PortError } from "@claudio/playback-web";

/** Injected so adapters can be driven by tests and never reach a global. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface JsonRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  /** Caller cancellation (operation cancelled, page disposed). */
  readonly signal?: AbortSignal;
  /** Deadline covering connect, headers and body read. */
  readonly timeoutMs: number;
}

const STATUS_CLASS: ReadonlyArray<[(status: number) => boolean, ErrorClass]> = [
  [(status) => status === 401 || status === 403, "auth-required"],
  [(status) => status === 404 || status === 410 || status === 501, "unavailable"],
  [(status) => status === 400 || status === 409 || status === 422, "invalid"],
  [(status) => status === 408 || status === 429 || status >= 500, "retryable"]
];

function classifyStatus(status: number): ErrorClass {
  return STATUS_CLASS.find(([matches]) => matches(status))?.[1] ?? "unavailable";
}

export function portError(errorClass: ErrorClass, code: string, message?: string, userInitiated?: boolean): PortError {
  const info: ErrorInfo = { class: errorClass, code, ...(message ? { message: message.slice(0, 1000) } : {}), ...(userInitiated ? { userInitiated } : {}) };
  return new PortError(info);
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/**
 * One JSON exchange with a v1 endpoint. Every failure becomes a classified
 * PortError: caller abort → userInitiated, deadline → retryable/timeout,
 * non-2xx → the server's ApiErrorV1 when it sent one, otherwise by status.
 * A 2xx body that does not decode is `invalid/bad_response`, never trusted.
 */
export async function requestJson<T>(fetchFn: FetchLike, request: JsonRequest, decoder: Decoder<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  const onAbort = () => controller.abort();
  if (request.signal?.aborted) controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let response: Response;
    let raw: unknown;
    try {
      response = await fetchFn(request.path, {
        method: request.method,
        headers: request.body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
        cache: "no-store"
      });
      raw = await response.json().catch((error: unknown) => {
        if (isAbortError(error)) throw error;
        return undefined;
      });
    } catch (error) {
      if (timedOut) throw portError("retryable", "timeout", `${request.method} ${request.path} exceeded ${request.timeoutMs}ms`);
      if (request.signal?.aborted || isAbortError(error)) throw portError("retryable", "aborted", undefined, true);
      throw portError("retryable", "network", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      const apiError = decode(apiErrorV1Decoder, raw);
      if (apiError.ok) throw new PortError(apiError.value.error);
      throw portError(classifyStatus(response.status), `http_${response.status}`);
    }
    const decoded = decode(decoder, raw);
    if (!decoded.ok) {
      const first = decoded.issues[0];
      throw portError("invalid", "bad_response", first ? `${first.path}: ${first.message}` : "response did not match the contract");
    }
    return decoded.value;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

/** Fire-and-forget request with its own short deadline; failures are only logged by the caller. */
export function bestEffort(fetchFn: FetchLike, method: "DELETE" | "PUT", path: string, timeoutMs: number, body?: unknown): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchFn(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: controller.signal,
    keepalive: true
  })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

/** Resolves after `ms` unless aborted; rejects with the classified abort. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(portError("retryable", "aborted", undefined, true));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(portError("retryable", "aborted", undefined, true));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
