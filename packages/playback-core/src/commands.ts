import { DECK_IDS, type OperationId, type PlaybackCommand, type QueueItem, type QueueItemId, type QueueEntryRequest } from "@claudio/contracts";
import type { StepContext } from "./context.js";
import { cancelCue, cancelTransitionCue, resumeCue } from "./cue.js";
import { isReservableIdFactory } from "./ids.js";
import { holdDeck, requestPlay, seekDeck, setGain, unloadDeck } from "./decks.js";
import { dropLyrics } from "./lyrics.js";
import { dropPrep } from "./prep.js";
import { activateProgram, advance, departureOutcome, loadProgramIfResolved, pauseTransport, planAhead, retireProgram } from "./program.js";
import { findEntry, insertEntries, moveToFront, nextEntry, removeEntry } from "./queue.js";
import { cancelTransition, modeFor, requestNarration } from "./transition.js";
import type { CoreState, QueueEntry } from "./state.js";
import { pauseVoice, replayNarration, resumeVoice, stopTransitionVoice, stopVoice } from "./voice.js";

/** Applies one user intent. Local effects (pause/stop) never wait on the network. */
export function applyCommand(ctx: StepContext, command: PlaybackCommand): void {
  switch (command.type) {
    case "select":
      return select(ctx, command.target);
    case "enqueue":
      return enqueue(ctx, command.entries, command.position);
    case "replace-queue":
      return replaceQueue(ctx, command.entries, command.autoplay);
    case "remove":
      return remove(ctx, command.itemId);
    case "next":
      return next(ctx);
    case "pause":
      return pause(ctx);
    case "resume":
      return resume(ctx);
    case "seek":
      return seek(ctx, command.positionMs);
    case "stop":
      return stop(ctx);
    case "set-volume":
      return setVolume(ctx, command.channel, command.value);
    case "set-muted":
      ctx.s.settings.muted = command.muted;
      return emitVolume(ctx);
    case "set-dj-enabled":
      return setDjEnabled(ctx, command.enabled);
    case "voice.replay":
      return replayNarration(ctx);
    case "voice.stop":
      return stopVoice(ctx);
    case "voice.pause":
      return pauseVoice(ctx);
    case "voice.resume":
      return resumeVoice(ctx);
  }
}

function hasKey(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Whether the core still knows `itemId` anywhere (live partitions, receipts, history). */
function itemIdKnown(s: CoreState, itemId: QueueItemId): boolean {
  if (s.program?.item.itemId === itemId || findEntry(s, itemId)) return true;
  if (DECK_IDS.some((id) => s.decks[id].itemId === itemId)) return true;
  if (hasKey(s.prep, itemId) || hasKey(s.lyrics, itemId) || hasKey(s.receipts, itemId)) return true;
  const pairs = [s.transition, s.reusableCue, s.retainedNarration?.binding, s.cue?.binding, s.parkedCue?.binding];
  if (pairs.some((pair) => pair && (pair.fromItemId === itemId || pair.toItemId === itemId))) return true;
  return s.history.some((entry) => entry.item.itemId === itemId);
}

/**
 * Items for one command, or null (noted, nothing changed) when any supplied
 * id is unacceptable. The whole batch is checked before anything is claimed
 * or generated: unique within the batch, unknown to the core, and an
 * unclaimed reservation of the injected factory. Entries without an id get
 * a fresh one.
 */
function createItems(ctx: StepContext, requests: readonly QueueEntryRequest[]): QueueItem[] | null {
  const supplied = requests.flatMap((request) => (request.itemId === undefined ? [] : [request.itemId]));
  if (supplied.length > 0) {
    const ids = ctx.env.ids;
    if (!isReservableIdFactory(ids)) {
      ctx.note("ignored", "supplied itemId needs a reservable id factory");
      return null;
    }
    const seen = new Set<string>();
    for (const itemId of supplied) {
      const problem = seen.has(itemId)
        ? "repeated in the command"
        : itemIdKnown(ctx.s, itemId)
          ? "already used"
          : !ids.isReserved(itemId)
            ? "not an unclaimed reservation"
            : null;
      if (problem) {
        ctx.note("ignored", `supplied itemId ${itemId} ${problem}; command not applied`);
        return null;
      }
      seen.add(itemId);
    }
    for (const itemId of supplied) {
      if (!ids.claim(itemId)) throw new Error(`id factory refused to claim ${itemId} it reported as reserved`);
    }
  }
  return requests.map((request) => ({
    itemId: request.itemId ?? ctx.id<QueueItemId>("item"),
    track: request.track,
    display: request.display,
    origin: request.origin,
    enqueuedAt: ctx.now
  }));
}

/** Items that must stay ahead of "next" insertions. */
function lockedIds(ctx: StepContext): QueueItemId[] {
  const locked: QueueItemId[] = [];
  if (ctx.s.program) locked.push(ctx.s.program.item.itemId);
  const transition = ctx.s.transition;
  if (transition && transition.phase !== "planned") locked.push(transition.toItemId);
  return locked;
}

function select(ctx: StepContext, target: Extract<PlaybackCommand, { type: "select" }>["target"]): void {
  const { s } = ctx;
  let itemId: QueueItemId;
  if (target.kind === "track") {
    const item = createItems(ctx, [target.entry])?.[0];
    if (!item) return;
    s.queue.unshift({ item, reservation: "none", lastError: null });
    itemId = item.itemId;
  } else {
    if (s.program?.item.itemId === target.itemId) return ctx.note("ignored", "selected item is already program");
    if (!findEntry(s, target.itemId)) return ctx.note("ignored", "selected item is not queued");
    itemId = target.itemId;
  }
  s.intent = "play";
  s.blocked = false;
  const outcome = departureOutcome(ctx);
  // Retire first so the program entry disappears, then pull the target to the front.
  if (s.transition) cancelTransition(ctx, "skip", { keepUnspokenAsset: false, keepPreroll: s.transition.toItemId === itemId });
  const entry = moveToFront(s, itemId);
  if (!entry) return;
  if (s.program) advance(ctx, outcome, entry);
  else activateProgram(ctx, entry);
}

/**
 * Adds items. If the queue ran out while the listener still wants playback
 * (exhausted), the new head starts on its own; after an explicit pause/stop
 * it only waits in the queue.
 */
function enqueue(ctx: StepContext, requests: readonly QueueEntryRequest[], position: "next" | "end"): void {
  if (requests.length === 0) return ctx.note("ignored", "nothing to enqueue");
  const { s } = ctx;
  const items = createItems(ctx, requests);
  if (!items) return;
  insertEntries(s, items, position, lockedIds(ctx));
  if (!s.program && s.intent === "play") {
    const head = nextEntry(s);
    if (head) return activateProgram(ctx, head);
  }
  planAhead(ctx);
}

/**
 * One atomic queue replacement (see the contract). Load-only keeps the
 * program and an executing transition's target and never starts playback;
 * autoplay cancels any transition once and makes entries[0] the program.
 */
function replaceQueue(ctx: StepContext, requests: readonly QueueEntryRequest[], autoplay: boolean): void {
  const { s } = ctx;
  if (autoplay && requests.length === 0) return ctx.note("ignored", "nothing to play");
  const items = createItems(ctx, requests);
  if (!items) return;
  if (!autoplay) {
    dropWaiting(ctx, new Set(lockedIds(ctx)));
    insertEntries(s, items, "end", []);
    if (!s.program && s.intent === "play") {
      // Exhausted: loading a list is not a request to play it.
      s.intent = "stop";
      ctx.note("decision", "list loaded while exhausted; waits for resume");
    }
    return planAhead(ctx);
  }
  s.intent = "play";
  s.blocked = false;
  const outcome = departureOutcome(ctx);
  if (s.transition) cancelTransition(ctx, "skip", { keepUnspokenAsset: false });
  dropWaiting(ctx, new Set(s.program ? [s.program.item.itemId] : []));
  const entries = items.map((item): QueueEntry => ({ item, reservation: "none", lastError: null }));
  s.queue.unshift(...entries);
  const first = entries[0]!;
  if (s.program) advance(ctx, outcome, first);
  else activateProgram(ctx, first);
}

/** Drop every queued item not in `keep`, with its transition, standby deck, preparation, lyrics and narration. */
function dropWaiting(ctx: StepContext, keep: ReadonlySet<QueueItemId>): void {
  const { s } = ctx;
  const dropped = s.queue.filter((entry) => !keep.has(entry.item.itemId)).map((entry) => entry.item.itemId);
  if (dropped.length === 0) return;
  const gone = new Set(dropped);
  const transition = s.transition;
  if (transition && gone.has(transition.toItemId)) cancelTransition(ctx, "queue-changed", { keepUnspokenAsset: false });
  for (const itemId of dropped) {
    for (const id of DECK_IDS) {
      const deck = s.decks[id];
      if (deck.itemId === itemId && deck.role !== "program" && deck.role !== "outgoing") unloadDeck(ctx, deck);
    }
    removeEntry(s, itemId);
    dropPrep(ctx, itemId);
    dropLyrics(ctx, itemId);
  }
  const reusable = s.reusableCue;
  if (reusable && (gone.has(reusable.fromItemId) || gone.has(reusable.toItemId))) s.reusableCue = null;
  const retained = s.retainedNarration;
  if (retained && gone.has(retained.binding.toItemId)) s.retainedNarration = null;
}

function remove(ctx: StepContext, itemId: QueueItemId): void {
  const { s } = ctx;
  if (s.program?.item.itemId === itemId) return next(ctx);
  const entry = findEntry(s, itemId);
  if (!entry) return ctx.note("ignored", "item not queued");
  const transition = s.transition;
  const wasTalking = transition?.phase === "talking" && transition.toItemId === itemId;
  if (transition && transition.toItemId === itemId) cancelTransition(ctx, "queue-changed", { keepUnspokenAsset: false });
  for (const id of DECK_IDS) {
    const deck = s.decks[id];
    if (deck.itemId === itemId) unloadDeck(ctx, deck);
  }
  removeEntry(s, itemId);
  dropPrep(ctx, itemId);
  dropLyrics(ctx, itemId);
  if (wasTalking) return advance(ctx, "played");
  planAhead(ctx);
}

function next(ctx: StepContext): void {
  const { s } = ctx;
  if (!s.program && !nextEntry(s)) return ctx.note("ignored", "nothing to skip to");
  s.intent = "play";
  s.blocked = false;
  advance(ctx, departureOutcome(ctx));
}

function pause(ctx: StepContext): void {
  const { s } = ctx;
  if (s.intent !== "play") return ctx.note("ignored", "not playing");
  s.blocked = false;
  pauseTransport(ctx);
}

function resume(ctx: StepContext): void {
  const { s } = ctx;
  if (!s.program) {
    const head = nextEntry(s);
    if (!head) return ctx.note("ignored", "queue empty");
    s.intent = "play";
    s.blocked = false;
    return activateProgram(ctx, head);
  }
  if (s.intent === "play" && !s.blocked) return ctx.note("ignored", "already playing");
  s.intent = "play";
  s.blocked = false;
  for (const id of DECK_IDS) {
    const deck = s.decks[id];
    if (deck.loadId === null || !deck.wantPlaying) continue;
    requestPlay(ctx, deck);
    // Old gain automation was cancelled by pause; re-anchor to the current target.
    setGain(ctx, deck, deck.gain, s.config.resumeRampMs);
  }
  resumeCue(ctx);
  loadProgramIfResolved(ctx);
}

/**
 * Seek the program deck. Cancels the current transition and its cue whether
 * or not the voice started; nothing is replayed because of the seek. The
 * landing position becomes the program's seek floor: a narration window at or
 * before it was skipped and is not caught up, while one still ahead may run
 * when playback reaches it, reusing an asset that never spoke.
 */
function seek(ctx: StepContext, positionMs: number): void {
  const { s } = ctx;
  const program = s.program;
  if (!program || program.deck === null) return ctx.note("ignored", "no program deck");
  const deck = s.decks[program.deck];
  if (deck.loadId === null || !deck.media) return ctx.note("ignored", "program deck not loaded");
  if (!deck.media.capabilities.seekable) return ctx.note("ignored", "source is not seekable");
  if (!Number.isFinite(positionMs) || positionMs < 0) return ctx.note("ignored", "invalid seek position");
  const target = deck.duration.kind === "known" ? Math.min(positionMs, deck.duration.ms) : positionMs;
  if (s.transition) cancelTransition(ctx, "seek", { keepUnspokenAsset: true });
  program.seekFloorMs = target;
  seekDeck(ctx, deck, target);
  if (deck.status === "ended") {
    deck.status = "paused";
    deck.wantPlaying = true;
  }
  // The element may have reached its end (paused) without the core knowing yet; asking
  // again costs nothing on a rolling element and keeps the seek from landing paused.
  if (s.intent === "play" && deck.wantPlaying) requestPlay(ctx, deck);
  planAhead(ctx);
}

function stop(ctx: StepContext): void {
  const { s } = ctx;
  if (s.transition) cancelTransition(ctx, "stop", { keepUnspokenAsset: false });
  cancelCue(ctx, { keepUnspokenAsset: false });
  s.parkedCue = null;
  s.reusableCue = null;
  s.retainedNarration = null;
  const program = s.program;
  if (program) {
    if (program.started) retireProgram(ctx, "stopped");
    else s.program = null; // never became output: stays queued
  }
  for (const id of DECK_IDS) unloadDeck(ctx, s.decks[id]);
  for (const entry of s.queue) entry.reservation = "none";
  for (const prep of Object.values(s.prep)) prep.opId = null;
  for (const opId of Object.keys(s.pending)) ctx.cancelOperation(opId as OperationId);
  s.lyrics = {};
  s.intent = "stop";
  s.blocked = false;
}

function clampVolume(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function setVolume(ctx: StepContext, channel: "music" | "voice", value: number): void {
  const volume = clampVolume(value);
  if (volume === null) return ctx.note("ignored", "invalid volume");
  if (channel === "music") ctx.s.settings.musicVolume = volume;
  else ctx.s.settings.voiceVolume = volume;
  emitVolume(ctx);
}

function emitVolume(ctx: StepContext): void {
  const { musicVolume, voiceVolume, muted } = ctx.s.settings;
  ctx.emit({ type: "output.volume", music: musicVolume, voice: voiceVolume, muted });
}

function setDjEnabled(ctx: StepContext, enabled: boolean): void {
  const { s } = ctx;
  if (s.settings.djEnabled === enabled) return ctx.note("ignored", "dj setting unchanged");
  s.settings.djEnabled = enabled;
  const transition = s.transition;
  if (!transition) return;
  if (enabled) {
    if (transition.phase === "planned" && transition.cueId === null) {
      transition.mode = modeFor(ctx, transition.fromItemId, transition.toItemId);
      if (transition.mode !== "direct") requestNarration(ctx, transition);
    }
    return;
  }
  switch (transition.phase) {
    case "planned":
      // A manual replay is the listener's explicit request and keeps playing.
      cancelTransitionCue(ctx, { keepUnspokenAsset: true });
      transition.cueId = null;
      transition.mode = "direct";
      return;
    case "prerolling": {
      cancelTransitionCue(ctx, { keepUnspokenAsset: true });
      const standby = Object.values(s.decks).find((deck) => deck.itemId === transition.toItemId);
      if (standby) holdDeck(ctx, standby);
      transition.phase = "planned";
      transition.cueId = null;
      transition.mode = "direct";
      return;
    }
    case "talking":
    case "overlapping":
      return stopTransitionVoice(ctx);
    default:
      return;
  }
}
