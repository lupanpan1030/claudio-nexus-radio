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

/**
 * Further v1 routes the server already serves and the web app calls. Shapes
 * are fixed by the response schemas in ./protocol.ts; route behaviour is the
 * server's.
 */
export const API_V1_EXTRA_PATHS = {
  /** GET → ProtocolHandshakeV1. Answers even when the server runs the legacy protocol. */
  protocol: "/api/v1/protocol",
  /** GET (Range) → media bytes. A StreamHandle is this prefix + an opaque token. */
  streams: "/api/v1/playback/streams/:token",
  /** DELETE → NarrationResponseV1 of the cancelled cue. */
  narrationCue: "/api/v1/playback/narration/:cueId",
  /** GET text/event-stream; each `event: now` carries one NowProjectionV1. */
  nowStream: "/api/v1/now/stream",
  /** GET ?limit → StartedHistoryResponseV1 (confirmed started facts only). */
  startedHistory: "/api/v1/history/started",
  /** GET ?limit → CandidateHistoryResponseV1 (selection audit; never listening history). */
  candidateHistory: "/api/v1/history/candidates",
  /** GET ?q&limit → CatalogSearchResponseV1. */
  catalogSearch: "/api/v1/catalog/search"
} as const;

export type ApiV1ExtraPathName = keyof typeof API_V1_EXTRA_PATHS;

/** Every path a v1 handshake announces. */
export type ApiV1AnnouncedPathName = ApiV1PathName | ApiV1ExtraPathName;

/** Stream handles issued by the server start with this prefix. */
export const API_V1_STREAM_HANDLE_PREFIX = API_V1_EXTRA_PATHS.streams.replace(":token", "");

/** SSE event name used by the now stream. */
export const NOW_STREAM_EVENT = "now" as const;

export function preparationPath(preparationId: string): string {
  return API_V1_PATHS.preparation.replace(":preparationId", encodeURIComponent(preparationId));
}

export function narrationCuePath(cueId: string): string {
  return API_V1_EXTRA_PATHS.narrationCue.replace(":cueId", encodeURIComponent(cueId));
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

/**
 * The one time budget (ms) of the v1 playback chain. The server's stage
 * deadlines default to these and a deployment may only lower them; every
 * client timeout below is derived from them, so a client never gives up
 * before the server has had its full budget to settle a stage. Configuration
 * starting points, not measured optima.
 */
export const PLAYBACK_BUDGETS = Object.freeze({
  /** Radio candidate pick, all reservation retries included. */
  candidateMs: 15_000,
  /** One source resolution. */
  sourceMs: 20_000,
  /** One lyrics lookup for a resolved revision. */
  lyricsMs: 15_000,
  /** DJ script writing. */
  scriptMs: 90_000,
  /** Speech synthesis of one script. */
  voiceMs: 60_000,
  /** Longest the server holds one long-poll (GET preparation, POST narration) or a POST prepare. */
  longPollMs: 8_000,
  /** Network and serialization slack on top of the server's bound for one HTTP exchange. */
  httpMarginMs: 4_000
});

/** Client deadline for one HTTP exchange: the server's bound for that exchange plus the margin. */
export const PLAYBACK_HTTP_TIMEOUTS = Object.freeze({
  /** POST prepare, GET preparation and POST narration: the server answers within longPollMs. */
  longPollRequestMs: PLAYBACK_BUDGETS.longPollMs + PLAYBACK_BUDGETS.httpMarginMs,
  /** POST resolve: the server resolves synchronously within sourceMs. */
  resolveRequestMs: PLAYBACK_BUDGETS.sourceMs + PLAYBACK_BUDGETS.httpMarginMs,
  /** POST lyrics: the server answers within lyricsMs. */
  lyricsRequestMs: PLAYBACK_BUDGETS.lyricsMs + PLAYBACK_BUDGETS.httpMarginMs
});

/**
 * Executor guards per operation kind: the server stages on the operation's
 * path plus two long-poll rounds (one in flight when the stage settles, one
 * to observe it). They only catch a hung port; by then the server has
 * already settled the stage as timed-out.
 *  prepare: candidate (radio) then source, observed by long-polls
 *  cue:     script then voice, observed by long-polls
 *  lyrics:  one POST answered within lyricsMs
 */
export const PLAYBACK_OPERATION_BUDGETS = Object.freeze({
  prepare: PLAYBACK_BUDGETS.candidateMs + PLAYBACK_BUDGETS.sourceMs + 2 * PLAYBACK_BUDGETS.longPollMs,
  cue: PLAYBACK_BUDGETS.scriptMs + PLAYBACK_BUDGETS.voiceMs + 2 * PLAYBACK_BUDGETS.longPollMs,
  lyrics: PLAYBACK_BUDGETS.lyricsMs + 2 * PLAYBACK_BUDGETS.longPollMs
});
