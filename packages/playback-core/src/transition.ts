import {
  readinessAtLeast,
  type QueueItemId,
  type SourceRevision,
  type TransitionCancelReason,
  type TransitionId,
  type TransitionMode
} from "@claudio/contracts";
import type { StepContext } from "./context.js";
import { cancelCue, isCuePlayable, requestCue, startCue } from "./cue.js";
import { deckHoldingItem, deckPosition, deckWithRole, holdDeck, playDeck, setGain, unloadDeck } from "./decks.js";
import { pairKey, type TransitionState } from "./state.js";

/** Transition partition: plans and executes hand-overs between program items. */

export function modeFor(ctx: StepContext, fromItemId: QueueItemId, toItemId: QueueItemId): TransitionMode {
  if (!ctx.s.settings.djEnabled) return "direct";
  if (ctx.s.spokenPairs.includes(pairKey(fromItemId, toItemId))) return "direct";
  return ctx.s.config.preferredTalkMode;
}

export function planTransition(
  ctx: StepContext,
  from: { itemId: QueueItemId; revision: SourceRevision | null },
  to: { itemId: QueueItemId; revision: SourceRevision | null }
): TransitionState {
  const transition: TransitionState = {
    transitionId: ctx.id<TransitionId>("transition"),
    fromItemId: from.itemId,
    toItemId: to.itemId,
    fromRevision: from.revision,
    toRevision: to.revision,
    mode: modeFor(ctx, from.itemId, to.itemId),
    phase: "planned",
    cueId: null,
    anchorMs: null,
    cancelReason: null
  };
  ctx.s.transition = transition;
  if (transition.mode !== "direct") requestNarration(ctx, transition);
  return transition;
}

/**
 * True when the last seek put A at or past where this transition's narration
 * window opens: the window was jumped over, not reached by playing.
 * talk-over-intro is timed on B, so a seek of A never skips it.
 */
export function windowSkippedBySeek(ctx: StepContext, transition: TransitionState): boolean {
  const { s } = ctx;
  const program = s.program;
  if (!program || program.item.itemId !== transition.fromItemId || program.seekFloorMs === null) return false;
  const duration = program.deck ? s.decks[program.deck].duration : s.prep[transition.fromItemId]?.media?.duration;
  if (!duration || duration.kind !== "known") return false;
  switch (transition.mode) {
    case "talk-over-crossfade":
      return Math.max(0, duration.ms - s.config.crossfadeLeadMs) <= program.seekFloorMs;
    case "sequential-talk":
      return duration.ms <= program.seekFloorMs;
    default:
      return false;
  }
}

/** Ask for narration unless a seek already carried A past its window (no catch-up). */
export function requestNarration(ctx: StepContext, transition: TransitionState): void {
  if (windowSkippedBySeek(ctx, transition)) return skipSeekedWindow(ctx, transition);
  requestCue(ctx, transition);
}

/**
 * The window was skipped by a seek: this transition hands over directly. An
 * unspoken asset stays reusable for a later transition whose window is
 * reached by playing (e.g. after seeking back before it).
 */
function skipSeekedWindow(ctx: StepContext, transition: TransitionState): void {
  if (ctx.s.cue) cancelCue(ctx, { keepUnspokenAsset: true });
  transition.cueId = null;
  transition.mode = "direct";
  ctx.note("decision", "narration window skipped by seek; not caught up");
}

/**
 * Cancel the current transition and undo its side effects: stop/abort the
 * cue, return a prerolled B to silent standby, drop an outgoing A and restore
 * the program gain. Callers decide what plays next.
 */
export function cancelTransition(ctx: StepContext, reason: TransitionCancelReason, options: { keepUnspokenAsset: boolean }): void {
  const { s } = ctx;
  const transition = s.transition;
  if (!transition) return;
  cancelCue(ctx, options);
  if (transition.phase === "prerolling") {
    const standby = deckHoldingItem(ctx, transition.toItemId);
    if (standby && standby.role === "standby") holdDeck(ctx, standby);
  }
  if (transition.phase === "overlapping") {
    const outgoing = deckWithRole(ctx, "outgoing");
    if (outgoing) unloadDeck(ctx, outgoing);
    const program = deckWithRole(ctx, "program");
    if (program) setGain(ctx, program, 1, s.config.resumeRampMs);
  }
  transition.phase = "cancelled";
  transition.cancelReason = reason;
  s.transition = null;
  ctx.note("decision", `transition cancelled: ${reason}`);
}

/** Narration may no longer start (cue missing/late/off): remove it, keep the hand-over. */
export function degradeToDirect(ctx: StepContext, transition: TransitionState, reason: string): void {
  if (ctx.s.cue) {
    ctx.note("decision", `narration dropped: ${reason}`);
    cancelCue(ctx, { keepUnspokenAsset: false });
  }
  transition.cueId = null;
  transition.mode = "direct";
}

/**
 * Start a talk-over-crossfade when A reaches its anchor and both the cue and
 * B are ready. B prerolls at zero gain; it becomes program output only when
 * its own `playing` is confirmed. Unknown A duration ⇒ no anchor ⇒ the mode
 * degrades at A's end instead of guessing.
 */
export function maybeStartCrossfade(ctx: StepContext): void {
  const { s } = ctx;
  const transition = s.transition;
  const program = s.program;
  if (!transition || !program || transition.phase !== "planned" || transition.mode !== "talk-over-crossfade") return;
  if (s.intent !== "play" || program.deck === null) return;
  const deckA = s.decks[program.deck];
  if (deckA.status !== "playing" || deckA.duration.kind !== "known") return;
  transition.anchorMs = Math.max(0, deckA.duration.ms - s.config.crossfadeLeadMs);
  if (deckPosition(ctx, deckA) < transition.anchorMs) return;
  if (windowSkippedBySeek(ctx, transition)) return skipSeekedWindow(ctx, transition);
  if (!s.settings.djEnabled || !isCuePlayable(s.cue)) return;
  const deckB = deckHoldingItem(ctx, transition.toItemId);
  if (!deckB || deckB.role !== "standby" || !readinessAtLeast(deckB.readiness, "can-play")) return;
  transition.phase = "prerolling";
  setGain(ctx, deckB, 0, 0);
  playDeck(ctx, deckB);
}

/** B's preroll failed (rejected/error): keep A playing and fall back to talking at A's end. */
export function abortPreroll(ctx: StepContext, reason: string): void {
  const transition = ctx.s.transition;
  if (!transition || transition.phase !== "prerolling") return;
  const deckB = deckHoldingItem(ctx, transition.toItemId);
  if (deckB) holdDeck(ctx, deckB);
  transition.phase = "planned";
  transition.mode = "sequential-talk";
  ctx.note("decision", `crossfade preroll aborted (${reason}); degraded to sequential-talk`);
}

export function startTalking(ctx: StepContext, transition: TransitionState): void {
  transition.phase = "talking";
  if (transition.mode !== "sequential-talk") {
    ctx.note("decision", `${transition.mode} window missed; talking sequentially`);
    transition.mode = "sequential-talk";
  }
  startCue(ctx);
}
