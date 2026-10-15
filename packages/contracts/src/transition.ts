import type { CueId, QueueItemId, SourceRevision, TransitionId } from "./ids.js";

/**
 * Hand-over modes. The model may suggest one; whether it can execute is
 * decided from current media state and measured budgets.
 *  - direct: no narration, B follows A.
 *  - sequential-talk: A ends (or fades) → complete short voice → B.
 *  - talk-over-crossfade: A ducks, voice starts, B enters low; needs a usable A tail.
 *  - talk-over-intro: voice over B's intro; needs a trusted first-vocal time
 *    and a measured voice length inside that budget.
 */
export type TransitionMode = "direct" | "sequential-talk" | "talk-over-crossfade" | "talk-over-intro";

/** Legacy `segue` values from the old model contract, read only as hints. */
export type LegacySegue = "direct" | "fade_in" | "talk_first";

/**
 * Explicit reinterpretation of the legacy names (they used to run a fixed
 * 3 s fade): talk_first = speak before B, fade_in = speak over a crossfade.
 */
export function legacySegueHint(segue: LegacySegue): TransitionMode {
  switch (segue) {
    case "direct":
      return "direct";
    case "talk_first":
      return "sequential-talk";
    case "fade_in":
      return "talk-over-crossfade";
  }
}

export type TransitionPhase =
  /** Planned; waiting for its window. */
  | "planned"
  /** B started at zero gain; not yet program output until B confirms playing. */
  | "prerolling"
  /** B committed; voice and/or A tail overlapping. */
  | "overlapping"
  /** A finished; voice speaking before B starts. */
  | "talking"
  | "completed"
  | "cancelled";

export type TransitionCancelReason =
  | "seek"
  | "skip"
  | "stop"
  | "queue-changed"
  | "source-changed"
  | "dj-disabled"
  | "failed";

/** Snapshot view of a transition; a plan is not proof it executed. */
export interface TransitionPlan {
  readonly transitionId: TransitionId;
  readonly fromItemId: QueueItemId;
  readonly toItemId: QueueItemId;
  readonly fromRevision: SourceRevision | null;
  readonly toRevision: SourceRevision | null;
  /** Mode the core intends; may degrade at execution time. */
  readonly mode: TransitionMode;
  readonly phase: TransitionPhase;
  readonly cueId: CueId | null;
  /** A media position (ms) at which an overlapping mode would start, when computable. */
  readonly anchorMs: number | null;
  readonly cancelReason: TransitionCancelReason | null;
}
