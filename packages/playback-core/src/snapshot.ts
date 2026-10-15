import type {
  CueAsset,
  DeckId,
  DeckSnapshot,
  DisplayItem,
  LyricsView,
  NarrationSnapshot,
  PlaybackSnapshot,
  QueueItemId,
  ResolvedMedia,
  SubtitleTrack,
  TransportStatus,
  VoiceSnapshot
} from "@claudio/contracts";
import { spokenDurationMs } from "@claudio/contracts";
import type { PlaybackState } from "./state.js";
import { projectedSubtitle } from "./subtitle-estimate.js";
import { narrationReplayBlock } from "./voice.js";

/** Subtitle shown for an asset: estimated sentence timing when enabled, the stored track otherwise (the asset is never edited). */
function subtitleOf(state: PlaybackState, asset: CueAsset): SubtitleTrack {
  return state.config.estimateNarrationTiming ? projectedSubtitle(asset) : asset.script.subtitle;
}

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
    gain: deck.gain,
    seekEpoch: deck.seekEpoch
  };
}

export function transportOf(state: PlaybackState): TransportStatus {
  if (state.blocked) return "blocked";
  const program = state.program;
  if (!program) {
    // Ran out while playback is still wanted: "played out, waiting for more", never a fake loading.
    if (state.intent === "play" && state.queue.length === 0) return "exhausted";
    return state.lastFailure ? "failed" : "idle";
  }
  if (state.intent === "pause") return "paused";
  const cue = state.cue;
  // While A is over and the DJ talks, the voice element is program output: only its confirmed `playing` is playing.
  if (state.transition?.phase === "talking" && cue) return cue.status === "speaking" ? "playing" : cue.status === "waiting" ? "waiting" : "loading";
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

function lyricsFor(state: PlaybackState, itemId: QueueItemId, media: ResolvedMedia | null): LyricsView {
  const entry = state.lyrics[itemId];
  if (!entry || !media || entry.sourceRevision !== media.sourceRevision || entry.recordingId !== media.recording.recordingId) return { status: "none" };
  return entry.view;
}

function displayOf(state: PlaybackState): DisplayItem {
  const cue = state.cue;
  const phase = state.transition?.phase;
  // Subtitles switch to the voice once it was confirmed playing, not when voice.play was issued.
  // A manual replay never takes the display: lyrics keep following the music, the DJ panel reads `voice`.
  const voiceHeard = cue !== null && cue.origin === "transition" && cue.everSpoke && (cue.status === "speaking" || cue.status === "waiting" || cue.status === "paused");
  if (cue && voiceHeard && (phase === "talking" || phase === "overlapping")) {
    return {
      kind: "voice",
      cueId: cue.binding.cueId,
      transitionId: cue.binding.transitionId,
      subtitle: cue.asset ? subtitleOf(state, cue.asset) : null,
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
    lyrics: lyricsFor(state, program.item.itemId, deck?.media ?? null)
  };
}

function voiceOf(state: PlaybackState): VoiceSnapshot | null {
  const cue = state.cue;
  if (!cue) return null;
  return {
    cueId: cue.binding.cueId,
    transitionId: cue.binding.transitionId,
    origin: cue.origin,
    status: cue.status,
    pausedBy: cue.status === "paused" ? cue.pausedBy : null,
    voiceLoadId: cue.voiceLoadId,
    clock: cue.clock,
    scriptText: cue.asset?.script.text ?? null,
    subtitle: cue.asset ? subtitleOf(state, cue.asset) : null
  };
}

function narrationOf(state: PlaybackState, now: number): NarrationSnapshot {
  const retained = state.retainedNarration;
  const block = narrationReplayBlock(state, now);
  const view =
    retained && state.program && retained.binding.toItemId === state.program.item.itemId
      ? {
          itemId: retained.binding.toItemId,
          cueId: retained.binding.cueId,
          transitionId: retained.binding.transitionId,
          scriptText: retained.asset.script.text,
          subtitle: subtitleOf(state, retained.asset),
          spokenMs: spokenDurationMs(retained.asset.voice),
          expiresAt: retained.asset.voice.stream.expiresAt
        }
      : null;
  return { retained: view, replay: block === null ? { available: true } : { available: false, reason: block } };
}

/**
 * Read-only projection for UI/stage/observers. Expiry-dependent fields
 * (narration.replay) are judged at `now`, by default the clock of the latest
 * accepted input.
 */
export function toSnapshot(state: PlaybackState, now: number = state.steppedAt): PlaybackSnapshot {
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
    narration: narrationOf(state, now),
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
