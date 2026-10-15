import { API_V1_PATHS, PROTOCOL_VERSION, isRecord } from "@claudio/contracts";
import { isAbortError, type FetchLike } from "./http";

/**
 * Endpoints this client uses. The shared contract fixes the core paths; the
 * extra ones (stream handles, cue cancel, history, catalog search, now stream)
 * are read from the server's handshake until the contract names them.
 */
export interface ProtocolPaths {
  readonly prepare: string;
  readonly preparation: string;
  readonly resolve: string;
  readonly narration: string;
  readonly lyrics: string;
  readonly started: string;
  readonly now: string;
  /** e.g. "/api/v1/playback/streams/:token"; null when the server did not announce it. */
  readonly streams: string | null;
  readonly narrationCue: string | null;
  readonly startedHistory: string | null;
  readonly catalogSearch: string | null;
}

export type ProtocolCheck =
  | { readonly status: "ready"; readonly serverInstanceId: string; readonly paths: ProtocolPaths }
  /** The server answered but does not run the v1 playback protocol this client speaks. */
  | { readonly status: "mismatch"; readonly detail: string }
  | { readonly status: "unreachable"; readonly detail: string };

export const PROTOCOL_PATH = "/api/v1/protocol";

function pathOrNull(paths: Record<string, unknown>, key: string): string | null {
  const value = paths[key];
  return typeof value === "string" && value.startsWith("/api/") ? value : null;
}

/** Pure decision on a handshake body; separated so tests do not need a server. */
export function interpretHandshake(httpStatus: number, body: unknown): ProtocolCheck {
  if (!isRecord(body)) return { status: httpStatus === 404 ? "mismatch" : "unreachable", detail: `HTTP ${httpStatus}` };
  if (body.protocolVersion !== PROTOCOL_VERSION) return { status: "mismatch", detail: `server protocol ${String(body.protocolVersion)}` };
  if (body.playbackProtocol !== "v1") return { status: "mismatch", detail: `server playback mode ${String(body.playbackProtocol)}` };
  if (typeof body.serverInstanceId !== "string" || body.serverInstanceId.length === 0) return { status: "mismatch", detail: "missing serverInstanceId" };
  const announced = isRecord(body.paths) ? body.paths : {};
  const core = Object.fromEntries(
    (Object.keys(API_V1_PATHS) as (keyof typeof API_V1_PATHS)[]).map((key) => [key, pathOrNull(announced, key) ?? API_V1_PATHS[key]])
  ) as Record<keyof typeof API_V1_PATHS, string>;
  for (const key of Object.keys(API_V1_PATHS) as (keyof typeof API_V1_PATHS)[]) {
    if (core[key] !== API_V1_PATHS[key]) return { status: "mismatch", detail: `path ${key} differs from the shared contract` };
  }
  return {
    status: "ready",
    serverInstanceId: body.serverInstanceId,
    paths: {
      ...core,
      streams: pathOrNull(announced, "streams"),
      narrationCue: pathOrNull(announced, "narrationCue"),
      startedHistory: pathOrNull(announced, "startedHistory"),
      catalogSearch: pathOrNull(announced, "catalogSearch")
    }
  };
}

export async function checkProtocol(fetchFn: FetchLike, signal: AbortSignal, timeoutMs = 8000): Promise<ProtocolCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchFn(PROTOCOL_PATH, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal, cache: "no-store" });
    const body: unknown = await response.json().catch(() => null);
    return interpretHandshake(response.status, body);
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: "unreachable", detail: isAbortError(error) ? "timeout" : error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** Fills a ":param" route template; values are URL-encoded. */
export function fillPath(template: string, param: string, value: string): string {
  return template.replace(`:${param}`, encodeURIComponent(value));
}
