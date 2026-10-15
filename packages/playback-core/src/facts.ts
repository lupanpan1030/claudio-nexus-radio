import {
  isSameSource,
  lyricsResultMatches,
  preferDuration,
  raiseReadiness,
  sameTrack,
  type DeckId,
  type ErrorInfo,
  type LoadId,
  type MediaEvent,
  type PlaybackFact,
  type QueueItemId,
  type ResolvedMedia
} from "@claudio/contracts";
import type { StepContext } from "./context.js";
import { cancelManualCue, clearRetainedFor, isVoiceActive, isVoiceExpired, markCueReady, pauseCue, syncRetainedNarration, voiceRate } from "./cue.js";
import { deckPosition, holdDeck, pauseDeck, requestPlay, unloadDeck } from "./decks.js";
import { dropLyrics } from "./lyrics.js";
import { refreshSource } from "./prep.js";
import {
  checkStarted,
  commitOverlap,
  ensureStandby,
  failProgram,
  loadProgramIfResolved,
  maybeCompleteOverlap,
  onCueFinished,
  onProgramEnded,
  pauseTransport,
  planAhead
} from "./program.js";
import { findEntry } from "./queue.js";
import { abortPreroll, cancelTransition, maybeStartCrossfade } from "./transition.js";
import type { DeckState } from "./state.js";

export type FactResult = "applied" | "stale";

/** Applies one fact. Facts whose identity is no longer current are rejected without side effects. */
export function applyFact(ctx: StepContext, fact: PlaybackFact): FactResult {
  switch (fact.type) {
    case "deck.media":
      return onDeckMedia(ctx, fact.deck, fact.loadId, fact.event);
    case "voice.media":
      return onVoiceMedia(ctx, fact);
    case "prepare.resolved":
      return onPrepareResolved(ctx, fact);
    case "prepare.settled":
      return onPrepareSettled(ctx, fact);
    case "cue.ready":
      return onCueReady(ctx, fact);
    case "cue.settled":
      return onCueSettled(ctx, fact);
    case "lyrics.result":
    case "lyrics.settled":
      return onLyrics(ctx, fact);
    case "receipt.settled": {
      if (ctx.s.receipts[fact.itemId] === undefined) return stale(ctx, "receipt for unknown item");
      ctx.s.receipts[fact.itemId] = fact.outcome;
      return "applied";
    }
  }
}

function stale(ctx: StepContext, reason: string): FactResult {
  ctx.note("stale", reason);
  return "stale";
}

function duplicate(ctx: StepContext, reason: string): FactResult {
  ctx.note("duplicate", reason);
  return "applied";
}

// ---------------------------------------------------------------- decks

function onDeckMedia(ctx: StepContext, deckId: DeckId, loadId: LoadId, event: MediaEvent): FactResult {
  const deck = ctx.s.decks[deckId];
  if (deck.loadId !== loadId) return stale(ctx, `deck ${deckId} event for old load`);
  const at = ctx.now;
  switch (event.kind) {
    case "metadata":
      deck.readiness = raiseReadiness(deck.readiness, "metadata");
      // The element's own measurement outranks provider metadata; unknown/weaker never overwrite it.
      deck.duration = preferDuration(deck.duration, event.duration);
      maybeStartCrossfade(ctx);
      return "applied";
    case "can-play":
      deck.readiness = raiseReadiness(deck.readiness, event.through ? "can-play-through" : "can-play");
      if (deck.status === "loading") deck.status = "ready";
      maybeStartCrossfade(ctx);
      return "applied";
    case "playing":
      return onDeckPlaying(ctx, deck, event.positionMs);
    case "waiting":
      if (deck.status === "ended") return duplicate(ctx, "waiting after ended");
      if (deck.pausesAwaited > 0) return stale(ctx, `deck ${deckId} waiting from before the requested pause`);
      deck.status = "waiting";
      deck.clock = { positionMs: deck.seekPendingMs ?? event.positionMs, observedAt: at, rate: 0 };
      return "applied";
    case "stalled":
      // Stalled may still have buffered data; not a pause.
      return "applied";
    case "paused":
      return onDeckPaused(ctx, deck, event);
    case "seeked":
      deck.seekPendingMs = null;
      deck.clock = { positionMs: event.positionMs, observedAt: at, rate: deck.status === "playing" ? (deck.clock?.rate || 1) : 0 };
      return "applied";
    case "time":
      // A position from before the pending seek must not reopen a window the seek left.
      if (deck.seekPendingMs !== null) return stale(ctx, `deck ${deckId} time from before the pending seek`);
      deck.clock = { positionMs: event.positionMs, observedAt: at, rate: deck.status === "playing" ? event.rate : 0 };
      if (deck.role === "program") maybeStartCrossfade(ctx);
      return "applied";
    case "ended":
      // Seeking clears `ended`; an end reported before the seek landed is the old position's.
      if (deck.seekPendingMs !== null) return stale(ctx, `deck ${deckId} ended from before the pending seek`);
      return onDeckEnded(ctx, deck);
    case "play-rejected":
      // A promise answers one play() call: a rejection of an earlier call says nothing about the latest.
      if (event.playId !== deck.playId) return stale(ctx, `deck ${deckId} rejection of a superseded play`);
      return onDeckRejected(ctx, deck, event.reason);
    case "error":
      return onDeckError(ctx, deck, event.error);
  }
}

function onDeckPlaying(ctx: StepContext, deck: DeckState, positionMs: number): FactResult {
  const { s } = ctx;
  if (deck.status === "ended" && deck.loadId !== null) {
    // Only a seek or a new load revives an ended deck; a stray `playing` (late
    // event, media key on the finished element) is silenced, not made program output.
    pauseDeck(ctx, deck);
    return duplicate(ctx, `deck ${deck.id} playing after ended`);
  }
  // Per-element order: this happened before a pause the core asked for, so it confirms nothing,
  // also for a play that was never confirmed (hold → promote → late playing of the first play).
  if (deck.pausesAwaited > 0) return stale(ctx, `deck ${deck.id} playing from before the requested pause`);
  deck.status = "playing";
  deck.readiness = raiseReadiness(deck.readiness, "can-play");
  const pending = deck.seekPendingMs;
  deck.clock = { positionMs: pending ?? positionMs, observedAt: ctx.now, rate: pending === null ? 1 : 0 };
  const transition = s.transition;
  const prerolled = deck.wantPlaying && transition?.phase === "prerolling" && transition.toItemId === deck.itemId;
  if (deck.role === "standby" && !prerolled) {
    // Nobody asked this standby to play: silence and rewind it, so it cannot
    // drift on unheard and later be promoted mid-track as if it had started.
    ctx.note("decision", `unrequested playing on standby deck ${deck.id}; held at its start`);
    holdDeck(ctx, deck);
    return "applied";
  }
  if (s.intent !== "play") {
    // Late `playing` after a pause/stop intent: enforce the intent again.
    pauseDeck(ctx, deck);
    return "applied";
  }
  if (deck.role === "program") {
    s.blocked = false;
    const prep = deck.itemId ? s.prep[deck.itemId] : undefined;
    if (prep) prep.refreshAttempts = 0;
    checkStarted(ctx);
    maybeStartCrossfade(ctx);
    return "applied";
  }
  if (prerolled) commitOverlap(ctx);
  return "applied";
}

function onDeckPaused(ctx: StepContext, deck: DeckState, event: Extract<MediaEvent, { kind: "paused" }>): FactResult {
  const { s } = ctx;
  if (event.requested) deck.pausesAwaited = Math.max(0, deck.pausesAwaited - 1);
  if (deck.status === "ended") return duplicate(ctx, "paused after ended");
  const clock = { positionMs: deck.seekPendingMs ?? event.positionMs, observedAt: ctx.now, rate: 0 };
  if (event.atEnd) {
    // Natural end: the element pauses right before `ended`. Not an interruption; `ended` decides.
    deck.clock = clock;
    return "applied";
  }
  deck.status = "paused";
  deck.clock = clock;
  // The core's own pause may land after a later play request (hold → promote → play):
  // it answers a superseded request and is never an interruption.
  if (event.requested) return "applied";
  if (deck.role === "program" && s.intent === "play" && deck.wantPlaying && deck.seekPendingMs !== null) {
    // A seek raced the natural end: the end's `pause` was dispatched after the seek cleared
    // element.ended, so it reads as unrequested. The listener just sought: play on.
    ctx.note("decision", "pause while a seek is pending; playing on from the seek target");
    requestPlay(ctx, deck);
    return "applied";
  }
  // An external pause of output that should sound (OS/media interruption) becomes a
  // transport pause, so the voice stops with the music and resume restarts both.
  if (deck.role === "program" && s.intent === "play" && deck.wantPlaying) {
    ctx.note("decision", "external pause of program deck; pausing transport");
    pauseTransport(ctx);
  }
  return "applied";
}

function onDeckEnded(ctx: StepContext, deck: DeckState): FactResult {
  if (deck.status === "ended") return duplicate(ctx, `deck ${deck.id} ended twice`);
  deck.status = "ended";
  deck.wantPlaying = false;
  if (deck.clock) deck.clock = { ...deck.clock, rate: 0 };
  if (deck.role === "program") onProgramEnded(ctx);
  else if (deck.role === "outgoing") {
    unloadDeck(ctx, deck);
    maybeCompleteOverlap(ctx);
  }
  return "applied";
}

function onDeckRejected(ctx: StepContext, deck: DeckState, reason: string): FactResult {
  const { s } = ctx;
  if (reason === "aborted") {
    // AbortError means a pause()/load()/end interrupted the play; that interruption
    // arrives as its own fact and decides the state. Nothing to block on here.
    ctx.note("decision", `deck ${deck.id} play aborted`);
    return "applied";
  }
  if (deck.role === "program") {
    // Needs a user gesture; nothing pretends to be playing.
    s.blocked = true;
    s.intent = "pause";
    pauseCue(ctx);
    ctx.note("decision", `program play rejected (${reason})`);
    return "applied";
  }
  if (deck.role === "standby") abortStandbyPreroll(ctx, reason);
  if (deck.role === "outgoing") {
    unloadDeck(ctx, deck);
    maybeCompleteOverlap(ctx);
  }
  return "applied";
}

function onDeckError(ctx: StepContext, deck: DeckState, error: ErrorInfo): FactResult {
  const { s } = ctx;
  if (deck.role === "outgoing" || deck.status === "ended") {
    const wasOutgoing = deck.role === "outgoing";
    if (wasOutgoing) unloadDeck(ctx, deck);
    if (wasOutgoing) maybeCompleteOverlap(ctx);
    return "applied";
  }
  if (deck.role === "standby") {
    const itemId = deck.itemId;
    unloadDeck(ctx, deck);
    const entry = itemId ? findEntry(s, itemId) : undefined;
    if (entry) {
      entry.lastError = error;
      entry.reservation = "none";
    }
    abortStandbyPreroll(ctx, error.code);
    return "applied";
  }
  const program = s.program;
  if (deck.role !== "program" || !program) return "applied";
  const prep = s.prep[program.item.itemId];
  const refreshable = error.class === "expired" || error.class === "retryable";
  if (refreshable && prep && prep.refreshAttempts < s.config.maxRefreshAttempts) {
    program.resumeAtMs = deckPosition(ctx, deck);
    unloadDeck(ctx, deck);
    program.deck = null;
    ctx.note("decision", `program media ${error.code}; refreshing source`);
    refreshSource(ctx, program.item);
    return "applied";
  }
  failProgram(ctx, error);
  return "applied";
}

/**
 * B failed during a crossfade preroll. If A already ended meanwhile, run the
 * end-of-A hand-over again (talk or direct) instead of stalling.
 */
function abortStandbyPreroll(ctx: StepContext, reason: string): void {
  if (ctx.s.transition?.phase !== "prerolling") return;
  abortPreroll(ctx, reason);
  const program = ctx.s.program;
  if (program?.deck && ctx.s.decks[program.deck].status === "ended") onProgramEnded(ctx);
}

// ---------------------------------------------------------------- preparation

function onPrepareResolved(ctx: StepContext, fact: Extract<PlaybackFact, { type: "prepare.resolved" }>): FactResult {
  const { s } = ctx;
  const prep = s.prep[fact.itemId];
  if (!prep || prep.opId !== fact.opId || !ctx.closeOperation(fact.opId, "prepare")) {
    return stale(ctx, "prepare result for a cancelled/unknown operation");
  }
  prep.opId = null;
  const item = s.program?.item.itemId === fact.itemId ? s.program.item : findEntry(s, fact.itemId)?.item;
  if (!item) return stale(ctx, "prepare result for an item no longer queued");
  if (!sameTrack(item.track, fact.media.track)) {
    // A resolver must not swap in another catalog entry.
    return onPrepareFailure(ctx, fact.itemId, { class: "invalid", code: "resolved_track_mismatch" });
  }
  const previous = prep.media;
  prep.media = fact.media;
  if (previous && !isSameSource(previous, fact.media)) onSourceChanged(ctx, fact.itemId, fact.media);
  else {
    syncRetainedNarration(ctx, fact.itemId, fact.media);
    syncTransitionRevision(ctx, fact.itemId, fact.media);
  }
  const program = s.program;
  if (program && program.item.itemId === fact.itemId) {
    if (previous && !isSameSource(previous, fact.media)) program.resumeAtMs = 0;
    loadProgramIfResolved(ctx);
    return "applied";
  }
  const entry = findEntry(s, fact.itemId);
  if (entry && entry.reservation === "standby") ensureStandby(ctx, entry);
  return "applied";
}

/**
 * Another recording id or revision replaced the source: lyrics for the old
 * one are dropped and any transition/cue bound to the item is cancelled.
 */
function onSourceChanged(ctx: StepContext, itemId: QueueItemId, media: ResolvedMedia): void {
  const { s } = ctx;
  ctx.note("decision", `source revision changed for ${itemId}`);
  dropLyrics(ctx, itemId);
  // Narration spoken for the old recording is neither replayed nor kept on.
  if (s.cue?.origin === "manual" && s.cue.binding.toItemId === itemId) cancelManualCue(ctx);
  clearRetainedFor(ctx, itemId);
  if (s.reusableCue && (s.reusableCue.fromItemId === itemId || s.reusableCue.toItemId === itemId)) s.reusableCue = null;
  const transition = s.transition;
  if (transition && (transition.fromItemId === itemId || transition.toItemId === itemId)) {
    cancelTransition(ctx, "source-changed", { keepUnspokenAsset: false });
  }
  for (const deck of Object.values(s.decks)) {
    // A preheated load of the old recording must not become program output.
    if (deck.itemId === itemId && deck.role === "standby" && deck.media && !isSameSource(deck.media, media)) unloadDeck(ctx, deck);
  }
  // Cancelling a transition retains narration that spoke; never for the recording that just changed.
  clearRetainedFor(ctx, itemId);
  planAhead(ctx);
}

function syncTransitionRevision(ctx: StepContext, itemId: QueueItemId, media: ResolvedMedia): void {
  const transition = ctx.s.transition;
  if (!transition) return;
  const revision = media.sourceRevision;
  const { s } = ctx;
  const cueOfTransition = s.cue?.origin === "transition" ? s.cue : null;
  if (transition.fromItemId === itemId && transition.fromRevision !== revision) {
    if (transition.fromRevision === null) {
      transition.fromRevision = revision;
      if (cueOfTransition) cueOfTransition.binding = { ...cueOfTransition.binding, fromRevision: revision };
      if (s.parkedCue) s.parkedCue = { ...s.parkedCue, binding: { ...s.parkedCue.binding, fromRevision: revision } };
      if (s.reusableCue && s.reusableCue.fromItemId === itemId && s.reusableCue.fromRevision === null) s.reusableCue = { ...s.reusableCue, fromRevision: revision };
    } else {
      cancelTransition(ctx, "source-changed", { keepUnspokenAsset: false });
      planAhead(ctx);
      return;
    }
  }
  if (transition.toItemId === itemId) {
    if (transition.toRevision === null) {
      transition.toRevision = revision;
      if (cueOfTransition) cueOfTransition.binding = { ...cueOfTransition.binding, toRevision: revision };
      if (s.parkedCue) s.parkedCue = { ...s.parkedCue, binding: { ...s.parkedCue.binding, toRevision: revision } };
      if (s.reusableCue && s.reusableCue.toItemId === itemId && s.reusableCue.toRevision === null) s.reusableCue = { ...s.reusableCue, toRevision: revision };
    } else if (transition.toRevision !== revision) {
      cancelTransition(ctx, "source-changed", { keepUnspokenAsset: false });
      planAhead(ctx);
    }
  }
}

function onPrepareSettled(ctx: StepContext, fact: Extract<PlaybackFact, { type: "prepare.settled" }>): FactResult {
  const prep = ctx.s.prep[fact.itemId];
  if (!prep || prep.opId !== fact.opId || !ctx.closeOperation(fact.opId, "prepare")) {
    return stale(ctx, "prepare settlement for a cancelled/unknown operation");
  }
  prep.opId = null;
  const error: ErrorInfo = fact.error ?? { class: fact.outcome === "timed-out" ? "retryable" : "unavailable", code: `prepare_${fact.outcome}` };
  return onPrepareFailure(ctx, fact.itemId, error);
}

function onPrepareFailure(ctx: StepContext, itemId: QueueItemId, error: ErrorInfo): FactResult {
  const { s } = ctx;
  const program = s.program;
  if (program && program.item.itemId === itemId) {
    if (program.deck === null) failProgram(ctx, error);
    return "applied";
  }
  const entry = findEntry(s, itemId);
  if (entry) {
    entry.lastError = error;
    entry.reservation = "none";
  }
  return "applied";
}

// ---------------------------------------------------------------- narration

function isParked(ctx: StepContext, fact: { readonly opId: string; readonly cueId: string }): boolean {
  const parked = ctx.s.parkedCue;
  return parked !== null && parked.opId === fact.opId && parked.binding.cueId === fact.cueId;
}

function onCueReady(ctx: StepContext, fact: Extract<PlaybackFact, { type: "cue.ready" }>): FactResult {
  const { s } = ctx;
  const cue = s.cue;
  const transition = s.transition;
  if (isParked(ctx, fact)) return onParkedCueReady(ctx, fact);
  if (!cue || cue.binding.cueId !== fact.cueId || cue.opId !== fact.opId || cue.binding.transitionId !== fact.transitionId) {
    return stale(ctx, "cue result for a cancelled/unknown cue");
  }
  if (!ctx.closeOperation(fact.opId, "cue")) return stale(ctx, "cue operation already settled");
  cue.opId = null;
  if (!transition || transition.transitionId !== fact.transitionId) return stale(ctx, "cue for a finished transition");
  if (isVoiceExpired(ctx, fact.asset)) {
    ctx.note("decision", "narration asset arrived already expired; handing over directly");
    s.cue = null;
    transition.cueId = null;
    transition.mode = "direct";
    return "applied";
  }
  markCueReady(ctx, fact.asset);
  maybeStartCrossfade(ctx);
  return "applied";
}

/**
 * Narration generated while a manual replay held the voice: keep it as an
 * unspoken reusable asset for its pair; it is loaded when the channel frees.
 */
function onParkedCueReady(ctx: StepContext, fact: Extract<PlaybackFact, { type: "cue.ready" }>): FactResult {
  const { s } = ctx;
  const parked = s.parkedCue;
  const transition = s.transition;
  if (!parked || parked.binding.transitionId !== fact.transitionId || !ctx.closeOperation(fact.opId, "cue")) {
    return stale(ctx, "cue result for a cancelled/unknown parked cue");
  }
  s.parkedCue = null;
  if (!transition || transition.transitionId !== fact.transitionId) return "applied";
  transition.cueId = null;
  if (isVoiceExpired(ctx, fact.asset)) {
    ctx.note("decision", "parked narration arrived already expired; handing over directly");
    transition.mode = "direct";
    return "applied";
  }
  const { fromItemId, toItemId, fromRevision, toRevision } = parked.binding;
  s.reusableCue = { fromItemId, toItemId, fromRevision, toRevision, asset: fact.asset };
  ctx.note("decision", "narration ready while a manual replay speaks; kept for when the voice is free");
  return "applied";
}

function onCueSettled(ctx: StepContext, fact: Extract<PlaybackFact, { type: "cue.settled" }>): FactResult {
  if (isParked(ctx, fact)) {
    if (!ctx.closeOperation(fact.opId, "cue")) return stale(ctx, "cue settlement for a cancelled parked cue");
    ctx.s.parkedCue = null;
    ctx.note("decision", `parked narration ${fact.outcome}${fact.error ? ` (${fact.error.code})` : ""}`);
    const parkedTransition = ctx.s.transition;
    if (parkedTransition && parkedTransition.cueId === fact.cueId) {
      parkedTransition.cueId = null;
      parkedTransition.mode = "direct";
    }
    return "applied";
  }
  const cue = ctx.s.cue;
  if (!cue || cue.binding.cueId !== fact.cueId || cue.opId !== fact.opId || !ctx.closeOperation(fact.opId, "cue")) {
    return stale(ctx, "cue settlement for a cancelled/unknown cue");
  }
  cue.opId = null;
  ctx.note("decision", `narration ${fact.outcome}${fact.error ? ` (${fact.error.code})` : ""}`);
  const transition = ctx.s.transition;
  ctx.s.cue = null;
  if (transition) {
    transition.cueId = null;
    transition.mode = "direct";
  }
  return "applied";
}

function onVoiceMedia(ctx: StepContext, fact: Extract<PlaybackFact, { type: "voice.media" }>): FactResult {
  const { s } = ctx;
  const cue = s.cue;
  if (!cue || cue.binding.cueId !== fact.cueId || cue.voiceLoadId !== fact.voiceLoadId) {
    return stale(ctx, "voice event for an old cue/load");
  }
  const event = fact.event;
  const at = ctx.now;
  switch (event.kind) {
    case "metadata":
      cue.readiness = raiseReadiness(cue.readiness, "metadata");
      return "applied";
    case "can-play":
      cue.readiness = raiseReadiness(cue.readiness, event.through ? "can-play-through" : "can-play");
      maybeStartCrossfade(ctx);
      return "applied";
    case "playing":
      if (!isVoiceActive(cue)) {
        // Not asked to play, or paused before its play() took effect: silence it.
        ctx.emit({ type: "voice.pause", cueId: cue.binding.cueId, voiceLoadId: fact.voiceLoadId });
        return "applied";
      }
      cue.status = "speaking";
      cue.everSpoke = true;
      cue.clock = { positionMs: event.positionMs, observedAt: at, rate: voiceRate(cue) };
      return "applied";
    case "time":
      cue.clock = { positionMs: event.positionMs, observedAt: at, rate: cue.status === "speaking" ? event.rate : 0 };
      return "applied";
    case "waiting":
      // Buffering before the first `playing` stays `starting`: nothing is audible yet.
      if (cue.status === "speaking") cue.status = "waiting";
      cue.clock = { positionMs: event.positionMs, observedAt: at, rate: 0 };
      return "applied";
    case "seeked":
      cue.clock = { positionMs: event.positionMs, observedAt: at, rate: cue.status === "speaking" ? voiceRate(cue) : 0 };
      return "applied";
    case "paused":
      cue.clock = { positionMs: event.positionMs, observedAt: at, rate: 0 };
      // Natural end pauses before `ended`, and the core's own pause may land after a
      // resume; only an interruption of a voice that should sound pauses the whole
      // transport, like the program deck.
      if (!event.atEnd && !event.requested && isVoiceActive(cue) && s.intent === "play") {
        ctx.note("decision", "external pause of the voice; pausing transport");
        pauseTransport(ctx);
      }
      return "applied";
    case "stalled":
      return "applied";
    case "ended":
      if (!isVoiceActive(cue) && cue.status !== "paused") return duplicate(ctx, "voice ended while not speaking");
      onCueFinished(ctx, "ended");
      return "applied";
    case "play-rejected":
      // Only the pending voice.play can be refused; anything else answers a superseded request.
      if (cue.status !== "starting" || event.playId !== cue.playId) return stale(ctx, `voice play rejection (${event.reason}) for a superseded play`);
      ctx.note("decision", `voice failed (${event.reason}); continuing music`);
      onCueFinished(ctx, "failed");
      return "applied";
    case "error":
      ctx.note("decision", `voice failed (${event.error.code}); continuing music`);
      onCueFinished(ctx, "failed");
      return "applied";
  }
}

// ---------------------------------------------------------------- lyrics

function onLyrics(ctx: StepContext, fact: Extract<PlaybackFact, { type: "lyrics.result" | "lyrics.settled" }>): FactResult {
  const entry = ctx.s.lyrics[fact.itemId];
  if (!entry || entry.opId !== fact.opId || !ctx.closeOperation(fact.opId, "lyrics")) {
    return stale(ctx, "lyrics for a cancelled/unknown request");
  }
  entry.opId = null;
  if (fact.type === "lyrics.settled") {
    entry.view = { status: "failed" };
    return "applied";
  }
  const result = fact.result;
  if (fact.sourceRevision !== entry.sourceRevision || !lyricsResultMatches(result, entry)) {
    // Lyrics for another recording are never shown, even under the same revision or title.
    entry.view = { status: "unmatched" };
    ctx.note("decision", "lyrics recording/revision mismatch");
    return "applied";
  }
  if (result.status === "available") entry.view = { status: "available", asset: result.asset };
  else if (result.status === "missing") entry.view = { status: "missing", reason: result.reason };
  else entry.view = { status: "unmatched" };
  return "applied";
}
