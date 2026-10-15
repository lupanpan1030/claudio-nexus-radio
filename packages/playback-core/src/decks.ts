import { DECK_IDS, extrapolatePosition, readinessAtLeast, type DeckId, type DeckRole, type LoadId, type PlayRequestId, type QueueItemId, type ResolvedMedia } from "@claudio/contracts";
import type { StepContext } from "./context.js";
import { resetDeck, type DeckState } from "./state.js";

/** Deck partition: owns load epochs, roles and gain targets of A/B. */

export function deckById(ctx: StepContext, id: DeckId): DeckState {
  return ctx.s.decks[id];
}

export function deckWithRole(ctx: StepContext, role: DeckRole): DeckState | undefined {
  return DECK_IDS.map((id) => ctx.s.decks[id]).find((deck) => deck.role === role);
}

export function deckHoldingItem(ctx: StepContext, itemId: QueueItemId): DeckState | undefined {
  return DECK_IDS.map((id) => ctx.s.decks[id]).find((deck) => deck.itemId === itemId && deck.loadId !== null);
}

/** Last confirmed position extrapolated to now, or 0 without any sample. */
export function deckPosition(ctx: StepContext, deck: DeckState): number {
  return deck.clock ? extrapolatePosition(deck.clock, ctx.now) : 0;
}

export function unloadDeck(ctx: StepContext, deck: DeckState): void {
  if (deck.loadId !== null) ctx.emit({ type: "deck.unload", deck: deck.id, loadId: deck.loadId });
  resetDeck(deck);
}

/** An idle deck, or null. Never steals the program or outgoing deck. */
export function idleDeck(ctx: StepContext): DeckState | null {
  return DECK_IDS.map((id) => ctx.s.decks[id]).find((deck) => deck.role === "idle") ?? null;
}

export function loadDeck(
  ctx: StepContext,
  deck: DeckState,
  options: { itemId: QueueItemId; media: ResolvedMedia; role: DeckRole; startAtMs: number; gain: number; wantPlaying: boolean }
): LoadId {
  if (deck.loadId !== null) unloadDeck(ctx, deck);
  const loadId = ctx.id<LoadId>("load");
  Object.assign(deck, {
    role: options.role,
    status: "loading",
    loadId,
    itemId: options.itemId,
    media: options.media,
    readiness: "none",
    clock: null,
    duration: options.media.duration,
    gain: options.gain,
    wantPlaying: options.wantPlaying,
    playId: null,
    pausesAwaited: 0,
    seekPendingMs: null
  } satisfies Partial<DeckState>);
  ctx.emit({ type: "deck.load", deck: deck.id, loadId, itemId: options.itemId, media: options.media, startAtMs: options.startAtMs });
  ctx.emit({ type: "deck.gain", deck: deck.id, loadId, gain: options.gain, rampMs: 0 });
  return loadId;
}

export function playDeck(ctx: StepContext, deck: DeckState): void {
  if (deck.loadId === null) return;
  deck.wantPlaying = true;
  if (ctx.s.intent === "play") requestPlay(ctx, deck);
}

export function requestPlay(ctx: StepContext, deck: DeckState): void {
  if (deck.loadId === null) return;
  deck.playId = ctx.id<PlayRequestId>("play");
  ctx.emit({ type: "deck.play", deck: deck.id, loadId: deck.loadId, playId: deck.playId });
}

export function pauseDeck(ctx: StepContext, deck: DeckState): void {
  if (deck.loadId === null) return;
  // Every deck.pause is acknowledged once; until then playing/waiting predate it.
  deck.pausesAwaited += 1;
  ctx.emit({ type: "deck.pause", deck: deck.id, loadId: deck.loadId });
}

export function seekDeck(ctx: StepContext, deck: DeckState, positionMs: number): void {
  if (deck.loadId === null) return;
  // Without metadata the element fires no `seeked` to wait for (nothing has played yet either).
  deck.seekPendingMs = readinessAtLeast(deck.readiness, "metadata") ? positionMs : null;
  deck.clock = { positionMs, observedAt: ctx.now, rate: 0 };
  ctx.emit({ type: "deck.seek", deck: deck.id, loadId: deck.loadId, positionMs });
}

export function setGain(ctx: StepContext, deck: DeckState, gain: number, rampMs: number): void {
  if (deck.loadId === null) return;
  deck.gain = gain;
  ctx.emit({ type: "deck.gain", deck: deck.id, loadId: deck.loadId, gain, rampMs });
}

/** Return a prerolled/held deck to silent standby at its start. */
export function holdDeck(ctx: StepContext, deck: DeckState): void {
  if (deck.loadId === null) return;
  deck.wantPlaying = false;
  deck.role = "standby";
  pauseDeck(ctx, deck);
  setGain(ctx, deck, 0, 0);
  seekDeck(ctx, deck, 0);
}
