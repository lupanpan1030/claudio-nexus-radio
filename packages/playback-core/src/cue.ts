import { extrapolatePosition, readinessAtLeast, type CueAsset, type CueBinding, type CueId, type VoiceLoadId } from "@claudio/contracts";
import type { StepContext } from "./context.js";
import { findEntry } from "./queue.js";
import { pairKey, type CueState, type TransitionState } from "./state.js";

/** Voice partition: one narration cue at a time, bound to a transition. */

/** Asset present AND the voice element reported it can play; a URL alone is not ready. */
export function isCuePlayable(cue: CueState | null): cue is CueState {
  return cue !== null && cue.status === "ready" && readinessAtLeast(cue.readiness, "can-play");
}

/**
 * A voice handle at/after its expiry must not back a new voice load. There is
 * no refresh: an expired asset is dropped like a missing one.
 */
export function isVoiceExpired(ctx: StepContext, asset: CueAsset): boolean {
  const expiresAt = asset.voice.stream.expiresAt;
  return expiresAt !== null && expiresAt <= ctx.now;
}

/** Create the cue for a planned transition, reusing an unspoken asset when the binding still matches and has not expired. */
export function requestCue(ctx: StepContext, transition: TransitionState): void {
  const { s } = ctx;
  const from = findEntry(s, transition.fromItemId)?.item ?? (s.program?.item.itemId === transition.fromItemId ? s.program.item : undefined);
  const to = findEntry(s, transition.toItemId)?.item;
  if (!from || !to) return;
  const cueId = ctx.id<CueId>("cue");
  const binding: CueBinding = {
    cueId,
    transitionId: transition.transitionId,
    fromItemId: transition.fromItemId,
    toItemId: transition.toItemId,
    fromRevision: transition.fromRevision,
    toRevision: transition.toRevision
  };
  transition.cueId = cueId;
  const reusable = s.reusableCue;
  s.reusableCue = null;
  if (
    reusable &&
    reusable.fromItemId === binding.fromItemId &&
    reusable.toItemId === binding.toItemId &&
    reusable.fromRevision === binding.fromRevision &&
    reusable.toRevision === binding.toRevision
  ) {
    if (isVoiceExpired(ctx, reusable.asset)) {
      ctx.note("decision", "unspoken narration asset expired; not reused");
    } else {
      s.cue = newCue(binding, null);
      ctx.note("decision", "reused unspoken narration asset for a new cue");
      markCueReady(ctx, reusable.asset);
      return;
    }
  }
  const opId = ctx.openOperation("cue");
  s.cue = newCue(binding, opId);
  ctx.emit({ type: "cue.request", opId, binding, from: from.track, to: to.track });
}

function newCue(binding: CueBinding, opId: CueState["opId"]): CueState {
  return { binding, opId, status: "requested", asset: null, voiceLoadId: null, readiness: "none", clock: null, everSpoke: false };
}

/** Asset arrived: preload it into the voice channel without playing. */
export function markCueReady(ctx: StepContext, asset: CueAsset): void {
  const cue = ctx.s.cue;
  if (!cue) return;
  cue.status = "ready";
  cue.asset = asset;
  cue.voiceLoadId = ctx.id<VoiceLoadId>("voice-load");
  ctx.emit({ type: "voice.load", cueId: cue.binding.cueId, voiceLoadId: cue.voiceLoadId, asset });
}

/** voice.play was asked for and not paused since: starting, speaking or buffering. */
export function isVoiceActive(cue: CueState | null): boolean {
  return cue !== null && (cue.status === "starting" || cue.status === "speaking" || cue.status === "waiting");
}

/** Rate the executor applies to this voice (contract: VoiceAsset.playbackRate). */
export function voiceRate(cue: CueState): number {
  return cue.asset?.voice.playbackRate ?? 1;
}

/**
 * The transition wants the voice heard. It is only `starting` until the
 * voice element confirms `playing`; under a transport pause it is held as
 * `paused` and resume asks for it.
 */
export function startCue(ctx: StepContext): void {
  const cue = ctx.s.cue;
  if (!cue || !cue.voiceLoadId) return;
  if (ctx.s.intent !== "play") {
    cue.status = "paused";
    return;
  }
  cue.status = "starting";
  ctx.emit({ type: "voice.play", cueId: cue.binding.cueId, voiceLoadId: cue.voiceLoadId });
}

/** Also stops a voice.play that has not produced `playing` yet; a late `playing` is then silenced. */
export function pauseCue(ctx: StepContext): void {
  const cue = ctx.s.cue;
  if (!cue || !cue.voiceLoadId || !isVoiceActive(cue)) return;
  cue.status = "paused";
  // Hold the subtitle clock where the voice is now; the `paused` fact then reports the exact position.
  if (cue.clock) cue.clock = { positionMs: extrapolatePosition(cue.clock, ctx.now), observedAt: ctx.now, rate: 0 };
  ctx.emit({ type: "voice.pause", cueId: cue.binding.cueId, voiceLoadId: cue.voiceLoadId });
}

export function resumeCue(ctx: StepContext): void {
  const cue = ctx.s.cue;
  if (!cue || !cue.voiceLoadId || cue.status !== "paused") return;
  cue.status = "starting";
  ctx.emit({ type: "voice.play", cueId: cue.binding.cueId, voiceLoadId: cue.voiceLoadId });
}

/**
 * Terminal cancel: abort generation, stop/release voice. An asset that never
 * spoke is kept for possible reuse by a later transition of the same pair;
 * one that already spoke is never replayed.
 */
export function cancelCue(ctx: StepContext, options: { keepUnspokenAsset: boolean }): void {
  const { s } = ctx;
  const cue = s.cue;
  if (!cue) return;
  ctx.cancelOperation(cue.opId);
  cue.opId = null;
  if (cue.voiceLoadId) ctx.emit({ type: "voice.stop", cueId: cue.binding.cueId, voiceLoadId: cue.voiceLoadId });
  if (cue.everSpoke) {
    rememberSpoken(ctx, cue);
  } else if (options.keepUnspokenAsset && cue.asset) {
    const { fromItemId, toItemId, fromRevision, toRevision } = cue.binding;
    s.reusableCue = { fromItemId, toItemId, fromRevision, toRevision, asset: cue.asset };
  }
  s.cue = null;
}

/** Cue reached a terminal status (ended/failed); release voice resources. */
export function finishCue(ctx: StepContext, status: "ended" | "failed"): void {
  const cue = ctx.s.cue;
  if (!cue) return;
  ctx.cancelOperation(cue.opId);
  cue.opId = null;
  if (cue.voiceLoadId) ctx.emit({ type: "voice.stop", cueId: cue.binding.cueId, voiceLoadId: cue.voiceLoadId });
  if (cue.everSpoke) rememberSpoken(ctx, cue);
  cue.status = status;
  ctx.s.cue = null;
}

function rememberSpoken(ctx: StepContext, cue: CueState): void {
  const key = pairKey(cue.binding.fromItemId, cue.binding.toItemId);
  if (!ctx.s.spokenPairs.includes(key)) ctx.s.spokenPairs.push(key);
  if (ctx.s.spokenPairs.length > ctx.s.config.historyLimit) ctx.s.spokenPairs.shift();
}
