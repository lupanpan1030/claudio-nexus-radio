import type {
  DeckId,
  DeckSnapshot,
  DisplayItem,
  LyricsView,
  PlaybackSnapshot,
  QueueItemId,
  SourceRevision,
  TransportStatus,
  VoiceSnapshot
} from "@claudio/contracts";
import type { PlaybackState } from "./state.js";

type DeckView = PlaybackState["decks"][DeckId];

function deckSnapshot(deck: DeckView): DeckSnapshot {
  return {
    deck: deck.id,
    role: deck.role,
    status: deck.status,
    loadId: deck.loadId,
    itemId: deck.itemId,
    sourceRevision: deck.media?.sourceRevision ?? null,
    recordingId: deck.media?.recording.recordingId ?? null,
    readiness: deck.readiness,
    clock: deck.clock,
    duration: deck.duration,
    gain: deck.gain
  };
}

export function transportOf(state: PlaybackState): TransportStatus {
  if (state.blocked) return "blocked";
  const program = state.program;
  if (!program) return state.lastFailure ? "failed" : "idle";
  if (state.intent === "pause") return "paused";
  if (state.transition?.phase === "talking" && state.cue?.status === "speaking") return "playing";
  if (program.deck === null) return "requested";
  switch (state.decks[program.deck].status) {
    case "playing":
      return "playing";
    case "waiting":
      return "waiting";
    default:
      return "loading";
  }
}

function lyricsFor(state: PlaybackState, itemId: QueueItemId, revision: SourceRevision | null): LyricsView {
  const entry = state.lyrics[itemId];
  if (!entry || revision === null || entry.sourceRevision !== revision) return { status: "none" };
  return entry.view;
}

function displayOf(state: PlaybackState): DisplayItem {
  const cue = state.cue;
  const phase = state.transition?.phase;
  if (cue && (cue.status === "speaking" || cue.status === "paused") && (phase === "talking" || phase === "overlapping")) {
    return {
      kind: "voice",
      cueId: cue.binding.cueId,
      transitionId: cue.binding.transitionId,
      subtitle: cue.asset?.script.subtitle ?? null,
      text: cue.asset?.script.text ?? null
    };
  }
  const program = state.program;
  if (!program) return { kind: "none" };
  const deck = program.deck ? state.decks[program.deck] : null;
  const revision = deck?.media?.sourceRevision ?? null;
  return {
    kind: "music",
    itemId: program.item.itemId,
    deck: deck?.id ?? null,
    loadId: deck?.loadId ?? null,
    sourceRevision: revision,
    lyrics: lyricsFor(state, program.item.itemId, revision)
  };
}

function voiceOf(state: PlaybackState): VoiceSnapshot | null {
  const cue = state.cue;
  if (!cue) return null;
  return {
    cueId: cue.binding.cueId,
    transitionId: cue.binding.transitionId,
    status: cue.status,
    voiceLoadId: cue.voiceLoadId,
    clock: cue.clock,
    scriptText: cue.asset?.script.text ?? null,
    subtitle: cue.asset?.script.subtitle ?? null
  };
}

/** Read-only projection for UI/stage/observers. */
export function toSnapshot(state: PlaybackState): PlaybackSnapshot {
  const program = state.program;
  const programDeck = program?.deck ? state.decks[program.deck] : null;
  return {
    version: state.version,
    transport: transportOf(state),
    program: program
      ? {
          item: program.item,
          deck: program.deck,
          loadId: programDeck?.loadId ?? null,
          sourceRevision: programDeck?.media?.sourceRevision ?? null,
          started: program.started,
          error: program.error
        }
      : null,
    decks: { A: deckSnapshot(state.decks.A), B: deckSnapshot(state.decks.B) },
    voice: voiceOf(state),
    transition: state.transition
      ? {
          transitionId: state.transition.transitionId,
          fromItemId: state.transition.fromItemId,
          toItemId: state.transition.toItemId,
          fromRevision: state.transition.fromRevision,
          toRevision: state.transition.toRevision,
          mode: state.transition.mode,
          phase: state.transition.phase,
          cueId: state.transition.cueId,
          anchorMs: state.transition.anchorMs,
          cancelReason: state.transition.cancelReason
        }
      : null,
    display: displayOf(state),
    queue: state.queue.map((entry) => ({ item: entry.item, reservation: entry.reservation, lastError: entry.lastError })),
    history: state.history,
    settings: state.settings,
    receipts: Object.entries(state.receipts).map(([itemId, status]) => ({ itemId: itemId as QueueItemId, status })),
    pending: Object.values(state.pending).map((op) => ({ opId: op.opId, kind: op.kind }))
  };
}
