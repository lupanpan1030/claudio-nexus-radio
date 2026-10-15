import { PREPARATION_DEFAULTS } from "@claudio/contracts";

/**
 * Preparation/asset policy. TTL, active limit and GC age come from the shared
 * R1 defaults; deadlines are configuration defaults, not measured optima.
 */
export interface PlaybackPolicy {
  readonly maxTtlMs: number;
  readonly activeItemLimit: number;
  readonly gcAfterMs: number;
  readonly candidateDeadlineMs: number;
  readonly sourceDeadlineMs: number;
  readonly lyricsDeadlineMs: number;
  readonly scriptDeadlineMs: number;
  readonly voiceDeadlineMs: number;
  /** How long a source that failed to resolve stays excluded from radio candidates. */
  readonly failedCandidateCooldownMs: number;
  /** Range requests on an already loaded handle keep working this long past its load deadline. */
  readonly streamGraceMs: number;
  /** Unused voice cache files older than this may be removed by GC. */
  readonly voiceRetentionMs: number;
  /** Rate the executor applies to voice assets (kept from the existing UI's Fish pace). */
  readonly voicePlaybackRate: number;
  /** POST prepare waits at most this long for the source stage before answering. */
  readonly prepareResponseWaitMs: number;
  /** Upper bound for long-poll waits on GET preparation / narration. */
  readonly maxLongPollMs: number;
}

export const DEFAULT_PLAYBACK_POLICY: PlaybackPolicy = Object.freeze({
  maxTtlMs: PREPARATION_DEFAULTS.maxTtlMs,
  activeItemLimit: PREPARATION_DEFAULTS.activeItemLimit,
  gcAfterMs: PREPARATION_DEFAULTS.gcAfterMs,
  candidateDeadlineMs: 15_000,
  sourceDeadlineMs: 20_000,
  lyricsDeadlineMs: 15_000,
  scriptDeadlineMs: 90_000,
  voiceDeadlineMs: 60_000,
  failedCandidateCooldownMs: 10 * 60_000,
  streamGraceMs: 3 * 3600_000,
  voiceRetentionMs: 30 * 24 * 3600_000,
  voicePlaybackRate: 0.86,
  prepareResponseWaitMs: 20_000,
  maxLongPollMs: 25_000
});
