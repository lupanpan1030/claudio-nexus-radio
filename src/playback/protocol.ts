import { API_V1_EXTRA_PATHS, API_V1_PATHS, decode, protocolHandshakeV1Decoder, type ProtocolHandshakeV1 } from "@claudio/contracts";
import { isAbortError, type FetchLike } from "./http";

/** Every endpoint this client uses: exactly the shared contract's path tables. */
export type ProtocolPaths = ProtocolHandshakeV1["paths"];

export const SHARED_PATHS: ProtocolPaths = Object.freeze({ ...API_V1_PATHS, ...API_V1_EXTRA_PATHS });

export type ProtocolCheck =
  | { readonly status: "ready"; readonly serverInstanceId: string; readonly paths: ProtocolPaths }
  /** The server answered but does not run the v1 playback protocol this client speaks. */
  | { readonly status: "mismatch"; readonly detail: string }
  | { readonly status: "unreachable"; readonly detail: string };

export const PROTOCOL_PATH = API_V1_EXTRA_PATHS.protocol;

/**
 * Pure decision on a handshake answer; separated so tests do not need a
 * server. Only a 2xx body that decodes as ProtocolHandshakeV1, runs the v1
 * playback protocol and announces exactly the shared paths starts a player.
 * A non-2xx answer never passes, whatever its body says.
 */
export function interpretHandshake(httpStatus: number, body: unknown): ProtocolCheck {
  if (httpStatus < 200 || httpStatus >= 300) {
    // No such route (an older server) is a version mismatch; anything else is the server being unwell.
    return { status: httpStatus === 404 || httpStatus === 410 || httpStatus === 501 ? "mismatch" : "unreachable", detail: `HTTP ${httpStatus}` };
  }
  const decoded = decode(protocolHandshakeV1Decoder, body);
  if (!decoded.ok) {
    const first = decoded.issues[0];
    return { status: "mismatch", detail: first ? `handshake ${first.path}: ${first.message}` : "handshake does not match the contract" };
  }
  const handshake = decoded.value;
  if (handshake.playbackProtocol !== "v1") return { status: "mismatch", detail: `server playback mode ${handshake.playbackProtocol}` };
  for (const key of Object.keys(SHARED_PATHS) as (keyof ProtocolPaths)[]) {
    if (handshake.paths[key] !== SHARED_PATHS[key]) return { status: "mismatch", detail: `path ${key} differs from the shared contract` };
  }
  return { status: "ready", serverInstanceId: handshake.serverInstanceId, paths: SHARED_PATHS };
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
