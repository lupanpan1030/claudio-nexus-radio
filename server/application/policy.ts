import { PLAYBACK_BUDGETS, PREPARATION_DEFAULTS } from "@claudio/contracts";

/**
 * Preparation/asset policy. TTL, active limit and GC age come from the shared
 * R1 defaults; stage deadlines and long-poll holds come from the shared
 * playback budget that clients derive their timeouts from.
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
  /** Re-picks after the picked radio candidate was reserved by another item meanwhile; then no_candidate. */
  readonly candidateReservationRetries: number;
  /** How long a "playable" list answer from a real resolve is reused (per ref + provider scope). */
  readonly playabilityMemoMs: number;
  /** How long a "not playable" list answer is reused. */
  readonly playabilityNegativeMemoMs: number;
  /** Most remembered playability answers (oldest dropped first). */
  readonly playabilityMemoEntries: number;
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
  candidateDeadlineMs: PLAYBACK_BUDGETS.candidateMs,
  sourceDeadlineMs: PLAYBACK_BUDGETS.sourceMs,
  lyricsDeadlineMs: PLAYBACK_BUDGETS.lyricsMs,
  scriptDeadlineMs: PLAYBACK_BUDGETS.scriptMs,
  voiceDeadlineMs: PLAYBACK_BUDGETS.voiceMs,
  failedCandidateCooldownMs: 10 * 60_000,
  candidateReservationRetries: 2,
  playabilityMemoMs: 5 * 60_000,
  playabilityNegativeMemoMs: 30_000,
  playabilityMemoEntries: 1000,
  streamGraceMs: 3 * 3600_000,
  voiceRetentionMs: 30 * 24 * 3600_000,
  voicePlaybackRate: 0.86,
  prepareResponseWaitMs: PLAYBACK_BUDGETS.longPollMs,
  maxLongPollMs: PLAYBACK_BUDGETS.longPollMs
});

/**
 * Policy fields bounded by the shared budget. Clients size their timeouts
 * from that budget without asking the server, so these may be configured
 * lower but never higher: a longer server deadline would let the client give
 * up first and cancel work that was still within its budget.
 */
export const BUDGET_BOUNDS = Object.freeze({
  candidateDeadlineMs: PLAYBACK_BUDGETS.candidateMs,
  sourceDeadlineMs: PLAYBACK_BUDGETS.sourceMs,
  lyricsDeadlineMs: PLAYBACK_BUDGETS.lyricsMs,
  scriptDeadlineMs: PLAYBACK_BUDGETS.scriptMs,
  voiceDeadlineMs: PLAYBACK_BUDGETS.voiceMs,
  prepareResponseWaitMs: PLAYBACK_BUDGETS.longPollMs,
  maxLongPollMs: PLAYBACK_BUDGETS.longPollMs
} satisfies Partial<Record<keyof PlaybackPolicy, number>>);

export type BudgetBoundedKey = keyof typeof BUDGET_BOUNDS;

/** Defaults plus overrides, with every budget-bounded field capped at its shared bound. */
export function resolvePolicy(overrides: Partial<PlaybackPolicy> = {}): PlaybackPolicy {
  const policy: { -readonly [K in keyof PlaybackPolicy]: PlaybackPolicy[K] } = { ...DEFAULT_PLAYBACK_POLICY, ...overrides };
  for (const [key, bound] of Object.entries(BUDGET_BOUNDS) as [BudgetBoundedKey, number][]) {
    policy[key] = Math.min(policy[key], bound);
  }
  return policy;
}
