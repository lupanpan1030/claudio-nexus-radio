import { DECK_IDS, type OperationId, type PlaybackCommand, type QueueItem, type QueueItemId, type QueueEntryRequest } from "@claudio/contracts";
import type { StepContext } from "./context.js";
import { cancelCue, resumeCue } from "./cue.js";
import { holdDeck, requestPlay, seekDeck, setGain, unloadDeck } from "./decks.js";
import { dropLyrics } from "./lyrics.js";
import { dropPrep } from "./prep.js";
import {
  activateProgram,
  advance,
  completeAndAdvance,
  departureOutcome,
  loadProgramIfResolved,
  maybeCompleteOverlap,
  pauseTransport,
  planAhead,
  releaseDuck,
  retireProgram
} from "./program.js";
import { findEntry, insertEntries, moveToFront, nextEntry, removeEntry } from "./queue.js";
import { cancelTransition, modeFor, requestNarration } from "./transition.js";

/** Applies one user intent. Local effects (pause/stop) never wait on the network. */
export function applyCommand(ctx: StepContext, command: PlaybackCommand): void {
  switch (command.type) {
    case "select":
      return select(ctx, command.target);
    case "enqueue":
      return enqueue(ctx, command.entries, command.position);
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
  }
}

function createItem(ctx: StepContext, request: QueueEntryRequest): QueueItem {
  return {
    itemId: ctx.id<QueueItemId>("item"),
    track: request.track,
    display: request.display,
    origin: request.origin,
    enqueuedAt: ctx.now
  };
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
    const item = createItem(ctx, target.entry);
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
  insertEntries(s, requests.map((request) => createItem(ctx, request)), position, lockedIds(ctx));
  if (!s.program && s.intent === "play") {
    const head = nextEntry(s);
    if (head) return activateProgram(ctx, head);
  }
  planAhead(ctx);
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
    if (s.intent === "play") requestPlay(ctx, deck);
  }
  planAhead(ctx);
}

function stop(ctx: StepContext): void {
  const { s } = ctx;
  if (s.transition) cancelTransition(ctx, "stop", { keepUnspokenAsset: false });
  cancelCue(ctx, { keepUnspokenAsset: false });
  s.reusableCue = null;
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
      cancelCue(ctx, { keepUnspokenAsset: true });
      transition.cueId = null;
      transition.mode = "direct";
      return;
    case "prerolling": {
      cancelCue(ctx, { keepUnspokenAsset: true });
      const standby = Object.values(s.decks).find((deck) => deck.itemId === transition.toItemId);
      if (standby) holdDeck(ctx, standby);
      transition.phase = "planned";
      transition.cueId = null;
      transition.mode = "direct";
      return;
    }
    case "talking":
      cancelCue(ctx, { keepUnspokenAsset: false });
      return completeAndAdvance(ctx);
    case "overlapping":
      cancelCue(ctx, { keepUnspokenAsset: false });
      releaseDuck(ctx);
      return maybeCompleteOverlap(ctx);
    default:
      return;
  }
}
