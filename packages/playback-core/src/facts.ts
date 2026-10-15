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
import { isVoiceActive, isVoiceExpired, markCueReady, pauseCue, voiceRate } from "./cue.js";
import { deckPosition, unloadDeck } from "./decks.js";
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
      deck.status = "waiting";
      deck.clock = { positionMs: event.positionMs, observedAt: at, rate: 0 };
      return "applied";
    case "stalled":
      // Stalled may still have buffered data; not a pause.
      return "applied";
    case "paused":
      return onDeckPaused(ctx, deck, event.positionMs, event.atEnd);
    case "seeked":
      deck.clock = { positionMs: event.positionMs, observedAt: at, rate: deck.status === "playing" ? (deck.clock?.rate || 1) : 0 };
      return "applied";
    case "time":
      deck.clock = { positionMs: event.positionMs, observedAt: at, rate: deck.status === "playing" ? event.rate : 0 };
      if (deck.role === "program") maybeStartCrossfade(ctx);
      return "applied";
    case "ended":
      return onDeckEnded(ctx, deck);
    case "play-rejected":
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
    ctx.emit({ type: "deck.pause", deck: deck.id, loadId: deck.loadId });
    return duplicate(ctx, `deck ${deck.id} playing after ended`);
  }
  deck.status = "playing";
  deck.readiness = raiseReadiness(deck.readiness, "can-play");
  deck.clock = { positionMs, observedAt: ctx.now, rate: 1 };
  if (s.intent !== "play" && deck.loadId !== null) {
    // Late `playing` after a pause/stop intent: enforce the intent again.
    ctx.emit({ type: "deck.pause", deck: deck.id, loadId: deck.loadId });
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
  const transition = s.transition;
  if (deck.role === "standby" && transition?.phase === "prerolling" && transition.toItemId === deck.itemId) {
    commitOverlap(ctx);
  }
  // A standby deck playing outside a preroll is silent (gain 0) and never counts as started.
  return "applied";
}

function onDeckPaused(ctx: StepContext, deck: DeckState, positionMs: number, atEnd: boolean): FactResult {
  const { s } = ctx;
  if (deck.status === "ended") return duplicate(ctx, "paused after ended");
  if (atEnd) {
    // Natural end: the element pauses right before `ended`. Not an interruption; `ended` decides.
    deck.clock = { positionMs, observedAt: ctx.now, rate: 0 };
    return "applied";
  }
  const wasPlaying = deck.status === "playing" || deck.status === "waiting";
  deck.status = "paused";
  deck.clock = { positionMs, observedAt: ctx.now, rate: 0 };
  // An external pause of program output (OS/media interruption) becomes a transport pause,
  // so the voice stops with the music.
  if (wasPlaying && deck.role === "program" && s.intent === "play" && deck.wantPlaying) {
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
  else syncTransitionRevision(ctx, fact.itemId, fact.media);
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
 * A different (or unprovable) recording replaced the source: lyrics for the
 * old revision are dropped and any transition/cue bound to the item is cancelled.
 */
function onSourceChanged(ctx: StepContext, itemId: QueueItemId, media: ResolvedMedia): void {
  const { s } = ctx;
  ctx.note("decision", `source revision changed for ${itemId}`);
  dropLyrics(ctx, itemId);
  if (s.reusableCue && (s.reusableCue.fromItemId === itemId || s.reusableCue.toItemId === itemId)) s.reusableCue = null;
  const transition = s.transition;
  if (transition && (transition.fromItemId === itemId || transition.toItemId === itemId)) {
    cancelTransition(ctx, "source-changed", { keepUnspokenAsset: false });
  }
  for (const deck of Object.values(s.decks)) {
    // A preheated load of the old recording must not become program output.
    if (deck.itemId === itemId && deck.role === "standby" && deck.media?.sourceRevision !== media.sourceRevision) unloadDeck(ctx, deck);
  }
  planAhead(ctx);
}

function syncTransitionRevision(ctx: StepContext, itemId: QueueItemId, media: ResolvedMedia): void {
  const transition = ctx.s.transition;
  if (!transition) return;
  const revision = media.sourceRevision;
  if (transition.fromItemId === itemId && transition.fromRevision !== revision) {
    if (transition.fromRevision === null) {
      transition.fromRevision = revision;
      if (ctx.s.cue) ctx.s.cue.binding = { ...ctx.s.cue.binding, fromRevision: revision };
    } else {
      cancelTransition(ctx, "source-changed", { keepUnspokenAsset: false });
      planAhead(ctx);
      return;
    }
  }
  if (transition.toItemId === itemId) {
    if (transition.toRevision === null) {
      transition.toRevision = revision;
      if (ctx.s.cue) ctx.s.cue.binding = { ...ctx.s.cue.binding, toRevision: revision };
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

function onCueReady(ctx: StepContext, fact: Extract<PlaybackFact, { type: "cue.ready" }>): FactResult {
  const { s } = ctx;
  const cue = s.cue;
  const transition = s.transition;
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

function onCueSettled(ctx: StepContext, fact: Extract<PlaybackFact, { type: "cue.settled" }>): FactResult {
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
      // Natural end pauses before `ended`; an interruption of a voice that should
      // sound pauses the whole transport, like the program deck.
      if (!event.atEnd && isVoiceActive(cue) && s.intent === "play") {
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
    case "error":
      ctx.note("decision", `voice failed (${event.kind === "error" ? event.error.code : event.reason}); continuing music`);
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
