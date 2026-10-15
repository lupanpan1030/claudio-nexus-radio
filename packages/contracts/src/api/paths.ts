/**
 * Fixed v1 endpoint paths. Old side-effecting routes (e.g. /api/radio/next)
 * are not part of this protocol.
 */
export const API_V1_PATHS = {
  /** POST PrepareRequestV1 → PreparedItemV1. Never records "played". */
  prepare: "/api/v1/playback/prepare",
  /** GET → PreparedItemV1 (latest published version). */
  preparation: "/api/v1/playback/preparations/:preparationId",
  /** POST ResolveRequestV1 → ResolveResponseV1 (refresh/retry a source). */
  resolve: "/api/v1/playback/resolve",
  /** POST NarrationRequestV1 → NarrationResponseV1. */
  narration: "/api/v1/playback/narration",
  /** POST LyricsRequestV1 → LyricsResponseV1. */
  lyrics: "/api/v1/playback/lyrics",
  /** POST StartedRequestV1 → StartedResponseV1. Idempotent by key. */
  started: "/api/v1/playback/started",
  /** GET → NowProjectionV1. Observation only; never advances playback. */
  now: "/api/v1/now"
} as const;

export type ApiV1PathName = keyof typeof API_V1_PATHS;

export function preparationPath(preparationId: string): string {
  return API_V1_PATHS.preparation.replace(":preparationId", encodeURIComponent(preparationId));
}

/**
 * Default preparation policy fixed for R1. These are configuration defaults,
 * not measured optima; R3 tests restart/expiry/GC against them.
 */
export const PREPARATION_DEFAULTS = Object.freeze({
  /** Upper bound for a preparation's expiresAt; source expiry may be earlier. */
  maxTtlMs: 15 * 60_000,
  /** Only the current and the next item are actively prepared. */
  activeItemLimit: 2,
  /** Completed records without active references are GC-eligible after this. */
  gcAfterMs: 24 * 3600_000
});
