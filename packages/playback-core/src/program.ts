import { asId, type ErrorInfo, type HistoryOutcome, type IdempotencyKey, type QueueItemId } from "@claudio/contracts";
import type { StepContext } from "./context.js";
import { finishCue, isCuePlayable, pauseCue, startCue } from "./cue.js";
import { deckById, deckHoldingItem, deckWithRole, holdDeck, idleDeck, loadDeck, pauseDeck, playDeck, setGain, unloadDeck } from "./decks.js";
import { dropLyrics, requestLyrics } from "./lyrics.js";
import { dropPrep, ensureResolved } from "./prep.js";
import { findEntry, nextEntry, pushHistory, removeEntry } from "./queue.js";
import { cancelTransition, degradeToDirect, planTransition, startTalking, windowSkippedBySeek } from "./transition.js";
import type { DeckState, QueueEntry } from "./state.js";

/**
 * Program partition: which item is program output, when it counts as
 * started, and how the queue advances. The queue entry is only reserved
 * while loading; it is consumed when the program deck confirms playing.
 */

export function startedKey(itemId: QueueItemId): IdempotencyKey {
  return asId<IdempotencyKey>(`started:${itemId}`);
}

/** Make `entry` the program target. Previous program must already be retired. */
export function activateProgram(ctx: StepContext, entry: QueueEntry, options: { gain?: number; rampMs?: number } = {}): void {
  const { s } = ctx;
  s.program = { item: entry.item, deck: null, started: false, resumeAtMs: 0, seekFloorMs: null, error: null };
  entry.reservation = "program";
  const held = deckHoldingItem(ctx, entry.item.itemId);
  if (held) {
    held.role = "program";
    s.program.deck = held.id;
    setGain(ctx, held, options.gain ?? 1, options.rampMs ?? s.config.resumeRampMs);
    playDeck(ctx, held);
    if (held.media) requestLyrics(ctx, entry.item, held.media);
    checkStarted(ctx);
    return;
  }
  loadProgramIfResolved(ctx);
}

/** Load the program item once its source is resolved and a deck is free. */
export function loadProgramIfResolved(ctx: StepContext): void {
  const program = ctx.s.program;
  if (!program || program.deck !== null) return;
  const media = ensureResolved(ctx, program.item, "program");
  if (!media) return;
  const deck = idleDeck(ctx) ?? releaseStandbyDeck(ctx);
  if (!deck) return;
  loadDeck(ctx, deck, {
    itemId: program.item.itemId,
    media,
    role: "program",
    startAtMs: program.resumeAtMs,
    gain: 1,
    wantPlaying: true
  });
  program.deck = deck.id;
  playDeck(ctx, deck);
  requestLyrics(ctx, program.item, media);
}

function releaseStandbyDeck(ctx: StepContext): DeckState | null {
  const standby = deckWithRole(ctx, "standby");
  if (!standby) return null;
  if (standby.itemId) releaseReservation(ctx, standby.itemId);
  unloadDeck(ctx, standby);
  return standby;
}

function releaseReservation(ctx: StepContext, itemId: QueueItemId): void {
  const entry = findEntry(ctx.s, itemId);
  if (entry && entry.reservation === "standby") entry.reservation = "none";
  dropLyrics(ctx, itemId);
}

/**
 * Started rule: committed program item AND the same load confirmed playing
 * while the transport intends to play. Order of the two conditions is free.
 * A `playing` that predates a pause the core still awaits confirms nothing.
 * Emits at most one receipt per item and consumes its queue entry.
 */
export function checkStarted(ctx: StepContext): void {
  const { s } = ctx;
  const program = s.program;
  if (!program || program.started || program.deck === null || s.intent !== "play") return;
  const deck = deckById(ctx, program.deck);
  if (deck.role !== "program" || deck.status !== "playing" || deck.pauseAwaited || deck.itemId !== program.item.itemId) return;
  if (deck.loadId === null || deck.media === null) return;
  program.started = true;
  removeEntry(s, program.item.itemId);
  s.consecutiveFailures = 0;
  s.lastFailure = null;
  const itemId = program.item.itemId;
  if (s.receipts[itemId] === undefined) {
    s.receipts[itemId] = "pending";
    pruneReceipts(ctx);
    ctx.emit({
      type: "receipt.report",
      receipt: {
        idempotencyKey: startedKey(itemId),
        itemId,
        track: program.item.track,
        recordingId: deck.media.recording.recordingId,
        sourceRevision: deck.media.sourceRevision,
        loadId: deck.loadId,
        positionMs: deck.clock?.positionMs ?? 0,
        at: ctx.now
      }
    });
  }
  planAhead(ctx);
}

function pruneReceipts(ctx: StepContext): void {
  const keys = Object.keys(ctx.s.receipts);
  for (const key of keys.slice(0, Math.max(0, keys.length - ctx.s.config.receiptLimit))) delete ctx.s.receipts[key];
}

/**
 * Keep one transition planned from the started program item to the queue
 * head, and preheat that head on the idle deck. Re-plans when the head
 * changes; leaves an executing transition alone.
 */
export function planAhead(ctx: StepContext): void {
  const { s } = ctx;
  const program = s.program;
  if (!program || !program.started) return;
  const current = s.transition;
  if (current && current.phase !== "planned") return;
  const next = nextEntry(s);
  if (current && next && current.fromItemId === program.item.itemId && current.toItemId === next.item.itemId) {
    ensureStandby(ctx, next);
    return;
  }
  if (current) cancelTransition(ctx, "queue-changed", { keepUnspokenAsset: true });
  const standby = deckWithRole(ctx, "standby");
  if (standby && standby.itemId !== next?.item.itemId) releaseStandbyDeck(ctx);
  for (const entry of s.queue) {
    if (entry.reservation === "standby" && entry !== next) {
      entry.reservation = "none";
      dropPrep(ctx, entry.item.itemId);
    }
  }
  if (!next) return;
  const programDeck = program.deck ? deckById(ctx, program.deck) : null;
  planTransition(
    ctx,
    { itemId: program.item.itemId, revision: programDeck?.media?.sourceRevision ?? s.prep[program.item.itemId]?.media?.sourceRevision ?? null },
    { itemId: next.item.itemId, revision: s.prep[next.item.itemId]?.media?.sourceRevision ?? null }
  );
  ensureStandby(ctx, next);
}

/** Reserve and preheat the next item (silent, paused) when a deck is free. */
export function ensureStandby(ctx: StepContext, entry: QueueEntry): void {
  if (entry.lastError) return;
  entry.reservation = "standby";
  if (deckHoldingItem(ctx, entry.item.itemId)) return;
  const media = ensureResolved(ctx, entry.item, "standby");
  if (!media) return;
  const deck = idleDeck(ctx);
  if (!deck) return;
  loadDeck(ctx, deck, { itemId: entry.item.itemId, media, role: "standby", startAtMs: 0, gain: 0, wantPlaying: false });
  requestLyrics(ctx, entry.item, media);
}

/** Move the program to history; optionally keep its deck sounding as outgoing. */
export function retireProgram(ctx: StepContext, outcome: HistoryOutcome, options: { keepAsOutgoing?: boolean } = {}): void {
  const { s } = ctx;
  const program = s.program;
  if (!program) return;
  const itemId = program.item.itemId;
  pushHistory(s, program.item, outcome, program.started);
  removeEntry(s, itemId);
  if (program.deck !== null) {
    const deck = deckById(ctx, program.deck);
    if (options.keepAsOutgoing && deck.status !== "ended") deck.role = "outgoing";
    else unloadDeck(ctx, deck);
  }
  dropPrep(ctx, itemId);
  dropLyrics(ctx, itemId);
  s.program = null;
}

/** Outcome for leaving the current program by user action. */
export function departureOutcome(ctx: StepContext): HistoryOutcome {
  const program = ctx.s.program;
  if (!program || program.deck === null) return "skipped";
  return deckById(ctx, program.deck).status === "ended" ? "played" : "skipped";
}

/** Leave the program (after it ended or by user action) and start the next item. */
export function advance(ctx: StepContext, outcome: HistoryOutcome, target?: QueueEntry): void {
  const { s } = ctx;
  const transition = s.transition;
  if (transition && transition.phase !== "completed") {
    // Skipping to the very B that is prerolling promotes it as is.
    const keepPreroll = transition.phase === "prerolling" && (target ?? nextEntry(s))?.item.itemId === transition.toItemId;
    cancelTransition(ctx, outcome === "played" ? "queue-changed" : "skip", { keepUnspokenAsset: false, keepPreroll });
  }
  const outgoing = deckWithRole(ctx, "outgoing");
  if (outgoing) unloadDeck(ctx, outgoing);
  retireProgram(ctx, outcome);
  const next = target ?? nextEntry(s);
  if (!next) {
    // Running out is not a stop: the intent stays, so the next enqueue starts by itself.
    ctx.note("decision", "queue exhausted");
    return;
  }
  activateProgram(ctx, next);
}

/** Natural end of the program deck. */
export function onProgramEnded(ctx: StepContext): void {
  const { s } = ctx;
  const program = s.program;
  const transition = s.transition;
  if (!program) return;
  if (transition && transition.fromItemId === program.item.itemId) {
    if (transition.phase === "prerolling") {
      // A's end is the preroll deadline: B never confirmed playing within the lead.
      if (s.settings.djEnabled && isCuePlayable(s.cue)) {
        const deckB = deckHoldingItem(ctx, transition.toItemId);
        if (deckB) holdDeck(ctx, deckB);
        startTalking(ctx, transition);
        return;
      }
      // No voice to wait for: B, already asked to play, becomes program as it is.
      degradeToDirect(ctx, transition, "B not confirmed playing by A's end");
      completeAndAdvance(ctx);
      return;
    }
    if (transition.phase === "planned") {
      const cue = s.cue;
      const skipped = windowSkippedBySeek(ctx, transition);
      if (transition.mode !== "direct" && s.settings.djEnabled && isCuePlayable(cue) && !skipped) {
        startTalking(ctx, transition);
        return;
      }
      degradeToDirect(ctx, transition, skipped ? "window skipped by seek" : cue ? "voice not playable when the window opened" : "no cue");
      completeAndAdvance(ctx);
      return;
    }
  }
  advance(ctx, "played");
}

/** Hand over from an ended/talked-out A to the transition target. */
export function completeAndAdvance(ctx: StepContext): void {
  const { s } = ctx;
  const transition = s.transition;
  const target = transition ? findEntry(s, transition.toItemId) : undefined;
  if (transition) {
    transition.phase = "completed";
    s.transition = null;
  }
  advance(ctx, "played", target);
}

/** B confirmed playing during a crossfade preroll: commit it and overlap. */
export function commitOverlap(ctx: StepContext): void {
  const { s } = ctx;
  const transition = s.transition;
  if (!transition || transition.phase !== "prerolling") return;
  const target = findEntry(s, transition.toItemId);
  if (!target) return;
  const deckA = s.program?.deck ? deckById(ctx, s.program.deck) : null;
  retireProgram(ctx, "played", { keepAsOutgoing: true });
  transition.phase = "overlapping";
  const speaking = s.settings.djEnabled && isCuePlayable(s.cue);
  activateProgram(ctx, target, { gain: speaking ? s.config.underVoiceGain : 1, rampMs: s.config.fadeMs });
  if (deckA && deckA.role === "outgoing") setGain(ctx, deckA, speaking ? s.config.duckGain : 0, s.config.fadeMs);
  if (speaking) startCue(ctx);
  maybeCompleteOverlap(ctx);
}

/** Voice finished/failed during a transition. */
export function onCueFinished(ctx: StepContext, status: "ended" | "failed"): void {
  const { s } = ctx;
  finishCue(ctx, status);
  const transition = s.transition;
  if (!transition) return;
  if (transition.phase === "talking") {
    completeAndAdvance(ctx);
    return;
  }
  if (transition.phase === "overlapping") {
    releaseDuck(ctx);
    maybeCompleteOverlap(ctx);
  }
}

/** Voice gone: bring B to full and fade A out. */
export function releaseDuck(ctx: StepContext): void {
  const program = deckWithRole(ctx, "program");
  if (program) setGain(ctx, program, 1, ctx.s.config.fadeMs);
  const outgoing = deckWithRole(ctx, "outgoing");
  if (outgoing) setGain(ctx, outgoing, 0, ctx.s.config.fadeMs);
}

/** Overlap completes once no voice remains and the outgoing deck is gone. */
export function maybeCompleteOverlap(ctx: StepContext): void {
  const { s } = ctx;
  const transition = s.transition;
  if (!transition || transition.phase !== "overlapping") return;
  if (s.cue !== null || deckWithRole(ctx, "outgoing")) return;
  transition.phase = "completed";
  s.transition = null;
  planAhead(ctx);
}

/**
 * Transport pause: every deck that should sound and the voice are told to
 * pause (idempotent for the element that already did); resume restarts them.
 */
export function pauseTransport(ctx: StepContext): void {
  const { s } = ctx;
  s.intent = "pause";
  for (const deck of Object.values(s.decks)) {
    if (deck.loadId !== null && (deck.wantPlaying || deck.status === "playing" || deck.status === "waiting")) pauseDeck(ctx, deck);
  }
  pauseCue(ctx);
}

/** Program item cannot play: record terminal failure and auto-advance (bounded). */
export function failProgram(ctx: StepContext, error: ErrorInfo): void {
  const { s } = ctx;
  const program = s.program;
  if (!program) return;
  program.error = error;
  s.lastFailure = error;
  s.consecutiveFailures += 1;
  if (s.transition) cancelTransition(ctx, "failed", { keepUnspokenAsset: false });
  const outgoing = deckWithRole(ctx, "outgoing");
  if (outgoing) unloadDeck(ctx, outgoing);
  retireProgram(ctx, "failed");
  const next = nextEntry(s);
  if (s.intent !== "stop" && s.consecutiveFailures < s.config.maxConsecutiveFailures) {
    if (!next) return ctx.note("decision", `item failed (${error.code}); queue exhausted`);
    ctx.note("decision", `item failed (${error.code}); advancing`);
    activateProgram(ctx, next);
    return;
  }
  // The bound also covers refills: failures only reset on a started item.
  s.intent = "stop";
  ctx.note("decision", `item failed (${error.code}); stopping`);
}
