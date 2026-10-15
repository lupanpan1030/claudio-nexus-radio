import type { PlaybackSnapshot } from "@claudio/contracts";
import type { MusicSample } from "../playback/clock";
import type { FoliaDisplayLike, FoliaInputLike } from "./folia-types";

/**
 * Pure mapping from one executor snapshot (+ a clock sample of the displayed
 * music) to the stage's read-only input, without the version (the controller
 * owns a strictly increasing per-mount sequence).
 *
 * - music: identity of the displayed deck; recordingId only when that deck
 *   still holds the displayed load; lyrics as the core bound them.
 * - voice (the DJ is the program output): the stage hides its canvas and
 *   Claudio draws the subtitle itself.
 * - clock: only a sample of exactly the displayed load; an observer passes
 *   the executor's sample untouched (original observedAt) so a silent
 *   executor freezes the lyrics instead of letting them run on.
 */
export function toFoliaInput(snapshot: PlaybackSnapshot | null, sample: MusicSample | null, seekEpoch: number): Omit<FoliaInputLike, "version"> {
  if (!snapshot) return { display: { kind: "none" }, clock: null, transport: "idle" };
  const shown = snapshot.display;
  let display: FoliaDisplayLike = { kind: "none" };
  let clock: FoliaInputLike["clock"] = null;
  if (shown.kind === "music") {
    const deck = shown.deck ? snapshot.decks[shown.deck] : null;
    const sameLoad = deck !== null && shown.loadId !== null && deck.loadId === shown.loadId;
    display = {
      kind: "music",
      itemId: shown.itemId,
      loadId: shown.loadId,
      sourceRevision: shown.sourceRevision,
      recordingId: sameLoad ? deck.recordingId : null,
      lyrics: shown.lyrics
    };
    if (sameLoad && sample && sample.loadId === shown.loadId) {
      clock = { loadId: sample.loadId, positionMs: sample.positionMs, observedAt: sample.observedAt, rate: sample.rate, seekEpoch };
    }
  } else if (shown.kind === "voice") {
    display = { kind: "voice", cueId: shown.cueId };
  }
  return { display, clock, transport: snapshot.transport };
}
