import {
  extrapolatePosition,
  readinessAtLeast,
  type CueAsset,
  type CueBinding,
  type CueId,
  type CueOrigin,
  type PlayRequestId,
  type QueueItemId,
  type ResolvedMedia,
  type VoiceLoadId,
  type VoicePausedBy
} from "@claudio/contracts";
import type { StepContext } from "./context.js";
import { setGain } from "./decks.js";
import { findEntry } from "./queue.js";
import { pairKey, type CoreState, type CueState, type TransitionState } from "./state.js";

/**
 * Voice partition: one voice channel. It holds either a transition's
 * narration cue or the listener's manual replay of the narration retained
 * for the current program, never both.
 */

/** Transition narration with an asset the voice element reported it can play; a URL alone is not ready. */
export function isCuePlayable(cue: CueState | null): cue is CueState {
  return cue !== null && cue.origin === "transition" && cue.status === "ready" && readinessAtLeast(cue.readiness, "can-play");
}

/**
 * A voice handle at/after its expiry must not back a new voice load. There is
 * no refresh: an expired asset is dropped like a missing one.
 */
export function isVoiceExpired(ctx: StepContext, asset: CueAsset): boolean {
  return isAssetExpired(asset, ctx.now);
}

export function isAssetExpired(asset: CueAsset, now: number): boolean {
  const expiresAt = asset.voice.stream.expiresAt;
  return expiresAt !== null && expiresAt <= now;
}

/**
 * Create the cue for a planned transition, reusing an unspoken asset when the
 * binding still matches and has not expired. While a manual replay holds the
 * voice channel nothing is loaded over it: a matching reusable asset waits,
 * otherwise the request is sent and parked (see ParkedCueRequest).
 */
export function requestCue(ctx: StepContext, transition: TransitionState): void {
  const { s } = ctx;
  const from = findEntry(s, transition.fromItemId)?.item ?? (s.program?.item.itemId === transition.fromItemId ? s.program.item : undefined);
  const to = findEntry(s, transition.toItemId)?.item;
  if (!from || !to) return;
  const manualBusy = s.cue?.origin === "manual";
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
    } else if (manualBusy) {
      s.reusableCue = reusable;
      transition.cueId = null;
      ctx.note("decision", "manual narration holds the voice; reusable narration waits for it");
      return;
    } else {
      s.cue = newCue("transition", binding, null);
      ctx.note("decision", "reused unspoken narration asset for a new cue");
      markCueReady(ctx, reusable.asset);
      return;
    }
  }
  const opId = ctx.openOperation("cue");
  if (manualBusy) s.parkedCue = { binding, opId };
  else s.cue = newCue("transition", binding, opId);
  ctx.emit({ type: "cue.request", opId, binding, from: from.track, to: to.track });
}

export function newCue(origin: CueOrigin, binding: CueBinding, opId: CueState["opId"]): CueState {
  return { origin, binding, opId, status: "requested", asset: null, voiceLoadId: null, readiness: "none", clock: null, everSpoke: false, pausedBy: null, playId: null };
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
export function isVoiceActive(cue: { readonly status: CueState["status"] } | null): boolean {
  return cue !== null && (cue.status === "starting" || cue.status === "speaking" || cue.status === "waiting");
}

/**
 * The voice channel is in use by something the listener can stop/pause: a
 * manual replay in any state, or transition narration that was asked to
 * play. A transition cue still generating/preloaded is not in use.
 */
export function isVoiceInUse(cue: { readonly origin: CueOrigin; readonly status: CueState["status"] } | null): boolean {
  if (cue === null) return false;
  return cue.origin === "manual" || isVoiceActive(cue) || cue.status === "paused";
}

/** Rate the executor applies to this voice (contract: VoiceAsset.playbackRate). */
export function voiceRate(cue: CueState): number {
  return cue.asset?.voice.playbackRate ?? 1;
}

/** Ask the loaded voice to play; under a transport pause it is held as paused and resume asks for it. */
export function startCue(ctx: StepContext): void {
  const cue = ctx.s.cue;
  if (!cue || !cue.voiceLoadId) return;
  if (ctx.s.intent !== "play" || ctx.s.blocked) {
    cue.status = "paused";
    cue.pausedBy = "transport";
    return;
  }
  playCue(ctx, cue);
}

/** voice.play with a fresh play identity; `starting` until the element confirms `playing`. */
export function playCue(ctx: StepContext, cue: CueState): void {
  if (!cue.voiceLoadId) return;
  cue.status = "starting";
  cue.pausedBy = null;
  cue.playId = ctx.id<PlayRequestId>("play");
  ctx.emit({ type: "voice.play", cueId: cue.binding.cueId, voiceLoadId: cue.voiceLoadId, playId: cue.playId });
}

/** Also stops a voice.play that has not produced `playing` yet; a late `playing` is then silenced. */
export function pauseCue(ctx: StepContext, by: VoicePausedBy = "transport"): void {
  const cue = ctx.s.cue;
  if (!cue || !cue.voiceLoadId || !isVoiceActive(cue)) return;
  cue.status = "paused";
  cue.pausedBy = by;
  // Hold the subtitle clock where the voice is now; the `paused` fact then reports the exact position.
  if (cue.clock) cue.clock = { positionMs: extrapolatePosition(cue.clock, ctx.now), observedAt: ctx.now, rate: 0 };
  ctx.emit({ type: "voice.pause", cueId: cue.binding.cueId, voiceLoadId: cue.voiceLoadId });
}

/** Transport resume: continues only a voice the transport paused, never one the listener paused. */
export function resumeCue(ctx: StepContext): void {
  const cue = ctx.s.cue;
  if (!cue || !cue.voiceLoadId || cue.status !== "paused" || cue.pausedBy !== "transport") return;
  playCue(ctx, cue);
}

/**
 * Terminal cancel: abort generation, stop/release voice. An automatic asset
 * that never spoke is kept for possible reuse by a later transition of the
 * same pair; one that spoke is never replayed automatically, but is retained
 * for an explicit replay on its target item.
 */
export function cancelCue(ctx: StepContext, options: { keepUnspokenAsset: boolean }): void {
  const { s } = ctx;
  const cue = s.cue;
  if (!cue) return;
  ctx.cancelOperation(cue.opId);
  cue.opId = null;
  if (cue.voiceLoadId) ctx.emit({ type: "voice.stop", cueId: cue.binding.cueId, voiceLoadId: cue.voiceLoadId });
  if (cue.origin === "transition") {
    if (cue.everSpoke) {
      rememberSpoken(ctx, cue);
      retainSpoken(ctx, cue);
    } else if (options.keepUnspokenAsset && cue.asset) {
      const { fromItemId, toItemId, fromRevision, toRevision } = cue.binding;
      s.reusableCue = { fromItemId, toItemId, fromRevision, toRevision, asset: cue.asset };
    }
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
  if (cue.origin === "transition" && cue.everSpoke) {
    rememberSpoken(ctx, cue);
    retainSpoken(ctx, cue);
  }
  cue.status = status;
  ctx.s.cue = null;
}

/** Abort a parked narration request (its transition is gone or goes direct). */
export function dropParkedCue(ctx: StepContext): void {
  const parked = ctx.s.parkedCue;
  if (!parked) return;
  ctx.cancelOperation(parked.opId);
  ctx.s.parkedCue = null;
}

/** Cancel only what belongs to the transition: its cue (if it holds the channel) and a parked request. */
export function cancelTransitionCue(ctx: StepContext, options: { keepUnspokenAsset: boolean }): void {
  if (ctx.s.cue?.origin === "transition") cancelCue(ctx, options);
  dropParkedCue(ctx);
}

function rememberSpoken(ctx: StepContext, cue: CueState): void {
  const key = pairKey(cue.binding.fromItemId, cue.binding.toItemId);
  if (!ctx.s.spokenPairs.includes(key)) ctx.s.spokenPairs.push(key);
  if (ctx.s.spokenPairs.length > ctx.s.config.historyLimit) ctx.s.spokenPairs.shift();
}

/** The target's resolved source as the core currently knows it. */
export function actualMedia(s: CoreState, itemId: QueueItemId): ResolvedMedia | null {
  const prepared = Object.prototype.hasOwnProperty.call(s.prep, itemId) ? s.prep[itemId]?.media : null;
  if (prepared) return prepared;
  for (const deck of Object.values(s.decks)) if (deck.itemId === itemId && deck.media) return deck.media;
  return null;
}

/**
 * Keep narration that really spoke for its target item, bound to the
 * target's actual recording when known. A cue whose target already moved to
 * another revision is not retained. A manual replay never overwrites it.
 */
function retainSpoken(ctx: StepContext, cue: CueState): void {
  const asset = cue.asset;
  if (!asset) return;
  const binding = cue.binding;
  const media = actualMedia(ctx.s, binding.toItemId);
  if (!media) {
    ctx.s.retainedNarration = { binding, toRecordingId: null, asset };
    return;
  }
  if (binding.toRevision !== null && binding.toRevision !== media.sourceRevision) {
    ctx.note("decision", "spoken narration not retained: its target changed recording");
    return;
  }
  ctx.s.retainedNarration = { binding: { ...binding, toRevision: media.sourceRevision }, toRecordingId: media.recording.recordingId, asset };
}

/** The target resolved: bind retained narration to that recording, or drop it if it names another one. */
export function syncRetainedNarration(ctx: StepContext, itemId: QueueItemId, media: ResolvedMedia): void {
  const retained = ctx.s.retainedNarration;
  if (!retained || retained.binding.toItemId !== itemId) return;
  const revisionMatches = retained.binding.toRevision === null || retained.binding.toRevision === media.sourceRevision;
  const recordingMatches = retained.toRecordingId === null || retained.toRecordingId === media.recording.recordingId;
  if (!revisionMatches || !recordingMatches) {
    ctx.s.retainedNarration = null;
    ctx.note("decision", "retained narration dropped: target recording changed");
    return;
  }
  if (retained.binding.toRevision === null || retained.toRecordingId === null) {
    ctx.s.retainedNarration = {
      binding: { ...retained.binding, toRevision: media.sourceRevision },
      toRecordingId: media.recording.recordingId,
      asset: retained.asset
    };
  }
}

export function clearRetainedFor(ctx: StepContext, itemId: QueueItemId): void {
  if (ctx.s.retainedNarration?.binding.toItemId === itemId) ctx.s.retainedNarration = null;
}

/** Program gain multiplier a manual replay asks for: ducked while it sounds or is held by the transport. */
export function manualDuckTarget(s: CoreState): number {
  const cue = s.cue;
  if (cue?.origin !== "manual") return 1;
  return isVoiceActive(cue) || (cue.status === "paused" && cue.pausedBy === "transport") ? s.config.duckGain : 1;
}

/**
 * Bring the program deck to the gain the manual voice implies. Only while no
 * transition executes (those own the gains); the multiplier sits on top of
 * the user volume, so releasing to 1 lands on the latest volume.
 */
export function syncManualDuck(ctx: StepContext): void {
  const { s } = ctx;
  if (s.transition && s.transition.phase !== "planned") return;
  const deck = s.program?.deck ? s.decks[s.program.deck] : null;
  if (!deck || deck.role !== "program" || deck.loadId === null) return;
  const target = manualDuckTarget(s);
  if (deck.gain !== target) setGain(ctx, deck, target, s.config.fadeMs);
}

/** Stop a manual replay (if one holds the channel) and release its duck. True if one was stopped. */
export function cancelManualCue(ctx: StepContext): boolean {
  if (ctx.s.cue?.origin !== "manual") return false;
  cancelCue(ctx, { keepUnspokenAsset: false });
  syncManualDuck(ctx);
  return true;
}
