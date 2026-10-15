import { trackDisplayDecoder, trackRefDecoder, type TrackDisplay, type TrackRef } from "../catalog.js";
import type { CueId, PreparationId, QueueItemId, SourceRevision, TransitionId } from "../ids.js";
import { lyricsAvailabilityDecoder, type LyricsAvailability } from "../lyrics.js";
import { narrationScriptDecoder, type NarrationScript, type VoiceAssetWire } from "../narration.js";
import { stageDecoder, type Stage } from "../preparation.js";
import { boolean, id, isoTimestamp, literal, nullable, number, object, optional, refine, string, tagged, type Decoder } from "../validation.js";
import { checkVoiceMatchesScript } from "./narration.js";
import {
  protocolVersionDecoder,
  resolvedMediaWireDecoder,
  voiceAssetWireDecoder,
  type ProtocolVersion,
  type ResolvedMediaWire
} from "./common.js";

/** What to prepare: an explicit track, or a server-chosen radio candidate. */
export type PrepareTargetV1 =
  | { readonly kind: "track"; readonly track: TrackRef }
  | { readonly kind: "radio-candidate"; readonly afterItemId: QueueItemId | null };

/** Optional narration for the hand-over into this item. */
export interface PrepareNarrationV1 {
  readonly transitionId: TransitionId;
  readonly cueId: CueId;
  readonly fromItemId: QueueItemId;
  readonly fromTrack: TrackRef;
  readonly fromRevision: SourceRevision | null;
}

/**
 * Prepare request. Preparing writes candidate audit only; it never records
 * a play and never rewrites another item's script.
 */
export interface PrepareRequestV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly itemId: QueueItemId;
  readonly purpose: "program" | "standby";
  readonly target: PrepareTargetV1;
  readonly narration: PrepareNarrationV1 | null;
  readonly wantLyrics: boolean;
}

export interface CandidateV1 {
  readonly track: TrackRef;
  readonly display: TrackDisplay | null;
  readonly reason?: string;
}

export type PreparationStatusV1 = "active" | "ready" | "failed" | "cancelled" | "interrupted" | "expired";

/**
 * Staged preparation result. Music may become playable while script/voice
 * are still pending. Each publication increments `version`; clients ignore
 * versions older than one they already applied.
 */
export interface PreparedItemV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly preparationId: PreparationId;
  readonly version: number;
  readonly itemId: QueueItemId;
  readonly status: PreparationStatusV1;
  readonly expiresAt: string;
  readonly stages: {
    readonly candidate: Stage<CandidateV1>;
    readonly source: Stage<ResolvedMediaWire>;
    readonly lyrics: Stage<LyricsAvailability>;
    readonly script: Stage<NarrationScript>;
    readonly voice: Stage<VoiceAssetWire>;
  };
}

export const prepareRequestV1Decoder: Decoder<PrepareRequestV1> = object<PrepareRequestV1>({
  protocolVersion: protocolVersionDecoder,
  itemId: id<QueueItemId>(),
  purpose: literal("program", "standby"),
  target: tagged<PrepareTargetV1, "kind">("kind", {
    track: object({ kind: literal("track"), track: trackRefDecoder }),
    "radio-candidate": object({ kind: literal("radio-candidate"), afterItemId: nullable(id<QueueItemId>()) })
  }),
  narration: nullable(
    object<PrepareNarrationV1>({
      transitionId: id<TransitionId>(),
      cueId: id<CueId>(),
      fromItemId: id<QueueItemId>(),
      fromTrack: trackRefDecoder,
      fromRevision: nullable(id<SourceRevision>())
    })
  ),
  wantLyrics: boolean
});

const candidateV1Decoder: Decoder<CandidateV1> = object<CandidateV1>({
  track: trackRefDecoder,
  display: nullable(trackDisplayDecoder),
  reason: optional(string({ max: 1000 }))
});

/**
 * Besides shape, rejects stages of one version that contradict each other:
 * a ready voice for another script, or ready lyrics bound to a different
 * recording/revision than the ready source. Not judged here: whether the
 * preparation still exists, has expired, or belongs to the current queue item,
 * nor whether candidate.track may differ from source.track.
 */
export const preparedItemV1Decoder: Decoder<PreparedItemV1> = refine(
  object<PreparedItemV1>({
    protocolVersion: protocolVersionDecoder,
    preparationId: id<PreparationId>(),
    version: number({ min: 0, integer: true }),
    itemId: id<QueueItemId>(),
    status: literal("active", "ready", "failed", "cancelled", "interrupted", "expired"),
    expiresAt: isoTimestamp,
    stages: object<PreparedItemV1["stages"]>({
      candidate: stageDecoder(candidateV1Decoder),
      source: stageDecoder(resolvedMediaWireDecoder),
      lyrics: stageDecoder(lyricsAvailabilityDecoder),
      script: stageDecoder(narrationScriptDecoder),
      voice: stageDecoder(voiceAssetWireDecoder)
    })
  }),
  ({ stages }, report) => {
    checkVoiceMatchesScript(stages.script, stages.voice, ".stages", report);
    if (stages.source.status !== "ready" || stages.lyrics.status !== "ready" || stages.lyrics.value.status !== "available") return;
    const source = stages.source.value;
    const asset = stages.lyrics.value.asset;
    if (asset.sourceRevision !== source.sourceRevision || asset.recordingId !== source.recording.recordingId) {
      report(".stages.lyrics.value.asset", "lyrics are bound to a different recording/revision than the ready source");
    }
  }
);

/** True when `next` may replace `current` (same preparation, newer version). */
export function isNewerPreparation(current: PreparedItemV1 | null, next: PreparedItemV1): boolean {
  if (current === null) return true;
  return current.preparationId === next.preparationId && next.version > current.version;
}
