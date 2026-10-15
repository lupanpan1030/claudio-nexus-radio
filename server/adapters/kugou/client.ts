import { createHash } from "node:crypto";
import { appError } from "../../application/errors.js";

export interface KuGouCredentials {
  readonly cookie: string;
  readonly userid: string;
  readonly loggedInAt: string;
}

const LOGIN_CODES = /"(?:error_code|errcode)"\s*:\s*(20010|20028|30705|30706)/i;

/** Tolerates KuGou's tagged/HTML-wrapped JSON bodies. */
export function parseKuGouBody(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const tagged = /<!--KG_TAG_RES_START-->([\s\S]*?)<!--KG_TAG_RES_END-->/.exec(text)?.[1] ?? /\{[\s\S]*\}/.exec(text)?.[0] ?? "";
    try {
      return tagged ? JSON.parse(tagged) : text;
    } catch {
      return text;
    }
  }
}

/**
 * HTTP client for the KuGouMusicApi-compatible service. The caller's signal
 * covers connect, headers and the body read; failures are classified.
 */
export class KuGouClient {
  constructor(
    private readonly deps: {
      readonly baseUrl: string;
      readonly credentials: () => KuGouCredentials | null;
      readonly fetch?: typeof fetch;
    }
  ) {}

  /** Changes whenever the signed-in account (or its login) changes; null when signed out. */
  accountRevision(): string | null {
    const credentials = this.deps.credentials();
    if (!credentials) return null;
    return createHash("sha256").update(`${credentials.userid}\n${credentials.loggedInAt}`).digest("hex").slice(0, 16);
  }

  hasCredentials(): boolean {
    return this.deps.credentials() !== null;
  }

  async get(pathname: string, params: Record<string, string | number | boolean | undefined>, options: { auth: boolean; signal: AbortSignal }): Promise<unknown> {
    const url = new URL(`${this.deps.baseUrl.replace(/\/+$/, "")}${pathname}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const credentials = options.auth ? this.deps.credentials() : null;
    if (options.auth && !credentials) throw appError("auth-required", "kugou_login_required");
    const doFetch = this.deps.fetch ?? fetch;
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        headers: { Accept: "application/json", ...(credentials ? { Cookie: credentials.cookie, Authorization: credentials.cookie } : {}) },
        signal: options.signal
      });
      text = await response.text();
    } catch (error) {
      if (options.signal.aborted) throw error;
      throw appError("retryable", "kugou_unreachable", error instanceof Error ? error.message : "KuGou API unreachable", error);
    }
    const body = parseKuGouBody(text);
    if (LOGIN_CODES.test(text)) throw appError("auth-required", "kugou_login_required");
    if (!response.ok) {
      throw appError(response.status >= 500 || response.status === 429 ? "retryable" : "unavailable", "kugou_http_error", `KuGou API ${response.status}`);
    }
    return body;
  }
}
