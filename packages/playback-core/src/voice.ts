import type { CueId, NarrationReplayBlock } from "@claudio/contracts";
import type { StepContext } from "./context.js";
import {
  cancelCue,
  cancelManualCue,
  isAssetExpired,
  isVoiceActive,
  isVoiceInUse,
  markCueReady,
  newCue,
  pauseCue,
  playCue,
  syncManualDuck
} from "./cue.js";
import { completeAndAdvance, duckUnderVoice, maybeCompleteOverlap, pauseTransport, releaseDuck } from "./program.js";
import { resumeAutoNarration } from "./transition.js";
import type { PlaybackState } from "./state.js";

/**
 * Manual voice controls. The UI picks one atomic command from the snapshot
 * (stop while a voice is in use, otherwise replay; pause/resume in the DJ
 * panel); there is no toggle command.
 */

/**
 * Why the retained narration of the current program cannot be replayed at
 * `now`, or null when it can. Permanent reasons come before transient ones.
 */
export function narrationReplayBlock(state: PlaybackState, now: number): NarrationReplayBlock | null {
  const program = state.program;
  const retained = state.retainedNarration;
  if (!program || !retained || retained.binding.toItemId !== program.item.itemId) return "no-narration";
  const itemId = program.item.itemId;
  const media = program.deck ? state.decks[program.deck].media : Object.prototype.hasOwnProperty.call(state.prep, itemId) ? (state.prep[itemId]?.media ?? null) : null;
  if (
    media &&
    (retained.binding.toRevision !== media.sourceRevision || retained.toRecordingId !== media.recording.recordingId)
  ) {
    return "recording-changed";
  }
  if (isAssetExpired(retained.asset, now)) return "expired";
  if (!program.started) return "not-started";
  if (isVoiceInUse(state.cue)) return "voice-active";
  if (state.transition && state.transition.phase !== "planned") return "transition-executing";
  if (state.intent !== "play" || state.blocked || !media) return "transport-not-playing";
  return null;
}

/**
 * Speak the program's retained narration again as a new manual cue. A
 * transition cue that is only generating/preloaded gives way: a request in
 * flight is parked, a loaded asset becomes reusable; both come back when the
 * replay ends. No receipt, no spokenPairs change.
 */
export function replayNarration(ctx: StepContext): void {
  const { s } = ctx;
  const block = narrationReplayBlock(s, ctx.now);
  const retained = s.retainedNarration;
  if (block !== null || !retained) return ctx.note("ignored", `narration replay unavailable: ${block ?? "no-narration"}`);
  yieldTransitionCue(ctx);
  const cue = newCue("manual", { ...retained.binding, cueId: ctx.id<CueId>("cue") }, null);
  s.cue = cue;
  markCueReady(ctx, retained.asset);
  playCue(ctx, cue);
  syncManualDuck(ctx);
}

function yieldTransitionCue(ctx: StepContext): void {
  const { s } = ctx;
  const cue = s.cue;
  const transition = s.transition;
  if (!cue || cue.origin !== "transition") return;
  if (cue.status === "requested" && cue.opId !== null && s.pending[cue.opId] && transition?.cueId === cue.binding.cueId) {
    s.parkedCue = { binding: cue.binding, opId: cue.opId };
    s.cue = null;
    ctx.note("decision", "narration request parked while the manual replay speaks");
    return;
  }
  cancelCue(ctx, { keepUnspokenAsset: true });
  if (transition) transition.cueId = null;
}

/**
 * Stop the voice in use. A manual replay just ends (the narration stays
 * replayable). Transition narration ends like a finished one: a sequential
 * talk hands over to B, an overlap brings B up; if it had spoken it is
 * retained for replay on B.
 */
export function stopVoice(ctx: StepContext): void {
  const { s } = ctx;
  const cue = s.cue;
  if (!isVoiceInUse(cue)) return ctx.note("ignored", "no voice to stop");
  if (cancelManualCue(ctx)) return resumeAutoNarration(ctx);
  stopTransitionVoice(ctx);
}

/** Shared with set-dj-enabled(false): end a talking/overlapping transition's voice now. */
export function stopTransitionVoice(ctx: StepContext): void {
  const transition = ctx.s.transition;
  cancelCue(ctx, { keepUnspokenAsset: false });
  if (transition?.phase === "talking") return completeAndAdvance(ctx);
  if (transition?.phase === "overlapping") {
    releaseDuck(ctx);
    maybeCompleteOverlap(ctx);
  }
}

/**
 * Pause only the voice; the music goes on at full gain. During a sequential
 * talk the voice is the program output, so this is a transport pause.
 */
export function pauseVoice(ctx: StepContext): void {
  const { s } = ctx;
  const cue = s.cue;
  if (!cue || !isVoiceInUse(cue)) return ctx.note("ignored", "no voice to pause");
  if (cue.origin === "transition" && s.transition?.phase === "talking") {
    if (s.intent !== "play") return ctx.note("ignored", "transport already paused");
    ctx.note("decision", "voice is the program output during a sequential talk; pausing the transport");
    return pauseTransport(ctx);
  }
  if (cue.status === "paused") {
    if (cue.pausedBy === "user") return ctx.note("ignored", "voice already paused");
    // Held by a transport pause: now the listener holds it too, so a transport resume leaves it.
    cue.pausedBy = "user";
  } else if (isVoiceActive(cue)) {
    pauseCue(ctx, "user");
  } else {
    return ctx.note("ignored", "voice not playing");
  }
  if (cue.origin === "manual") syncManualDuck(ctx);
  else if (s.transition?.phase === "overlapping") releaseDuck(ctx);
}

/**
 * Continue a voice the listener paused. Never resumes a paused transport:
 * then the voice is handed to the transport and continues with its resume.
 */
export function resumeVoice(ctx: StepContext): void {
  const { s } = ctx;
  const cue = s.cue;
  if (!cue || cue.status !== "paused" || cue.pausedBy !== "user") return ctx.note("ignored", "no voice paused by the listener");
  if (s.intent !== "play" || s.blocked) {
    cue.pausedBy = "transport";
    ctx.note("decision", "transport is paused; the voice continues when the transport resumes");
  } else {
    playCue(ctx, cue);
  }
  if (cue.origin === "manual") syncManualDuck(ctx);
  else if (s.transition?.phase === "overlapping") duckUnderVoice(ctx);
}
