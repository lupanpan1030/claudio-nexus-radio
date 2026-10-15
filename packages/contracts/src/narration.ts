import type { AssetId, CueId, QueueItemId, SourceRevision, StreamHandle, TransitionId } from "./ids.js";
import { checkInterval, timingProvenanceDecoder, type DurationInfo, type TimingProvenance } from "./timing.js";
import { array, id, number, object, optional, refine, string, type Decoder } from "./validation.js";

export interface SubtitleSegment {
  /** Relative to the start of the utterance; absent when timing is "plain-text". */
  readonly startMs?: number;
  readonly endMs?: number;
  readonly text: string;
}

/**
 * DJ subtitle timeline. Without trustworthy sentence boundaries this is one
 * "plain-text" segment holding the whole script; never fabricated per-char timing.
 * The server always stores plain text (the script exists before any audio).
 * An executor snapshot may show it as "estimated": sentences spread over the
 * voice's measured duration at rate 1 by text length. That is a labelled
 * guess, not an alignment, and the stored asset is never rewritten.
 */
export interface SubtitleTrack {
  readonly timing: TimingProvenance;
  readonly segments: readonly SubtitleSegment[];
}

/** Immutable script version; edits publish a new assetId/version. */
export interface NarrationScript {
  readonly assetId: AssetId;
  readonly version: number;
  readonly text: string;
  readonly subtitle: SubtitleTrack;
}

/** Synthesized speech for one script version. */
export interface VoiceAsset {
  readonly assetId: AssetId;
  readonly scriptAssetId: AssetId;
  readonly stream: { readonly handle: StreamHandle; readonly expiresAt: number | null };
  /** Media duration at rate 1, with its measurement source; may be unknown. */
  readonly duration: DurationInfo;
  /** Playback rate the executor will apply; spoken length = duration / rate. */
  readonly playbackRate: number;
}

/** Everything the executor needs to speak one cue. */
export interface CueAsset {
  readonly script: NarrationScript;
  readonly voice: VoiceAsset;
}

/**
 * What a cue is valid for. A cue is stale as soon as the transition, either
 * item, or either item's resolved recording revision changes.
 */
export interface CueBinding {
  readonly cueId: CueId;
  readonly transitionId: TransitionId;
  readonly fromItemId: QueueItemId;
  readonly toItemId: QueueItemId;
  readonly fromRevision: SourceRevision | null;
  readonly toRevision: SourceRevision | null;
}

/** Spoken length in ms, or null when the duration was not measured. */
export function spokenDurationMs(voice: VoiceAsset): number | null {
  if (voice.duration.kind !== "known" || voice.playbackRate <= 0) return null;
  return voice.duration.ms / voice.playbackRate;
}

/** Same interval rules as lyric lines: timed segments start, are ordered, never end before they start. */
export const subtitleTrackDecoder: Decoder<SubtitleTrack> = refine(
  object<SubtitleTrack>({
    timing: timingProvenanceDecoder,
    segments: array(
      object<SubtitleSegment>({
        startMs: optional(number({ min: 0 })),
        endMs: optional(number({ min: 0 })),
        text: string({ max: 2000 })
      }),
      { max: 200 }
    )
  }),
  (track, report) => {
    const timed = track.timing !== "plain-text";
    let previousStart = -Infinity;
    track.segments.forEach((segment, index) => {
      const at = `.segments[${index}]`;
      checkInterval(segment, at, timed, report);
      if (segment.startMs === undefined) return;
      if (segment.startMs < previousStart) report(`${at}.startMs`, "segments must be ordered by startMs");
      previousStart = segment.startMs;
    });
  }
);

export const narrationScriptDecoder: Decoder<NarrationScript> = object<NarrationScript>({
  assetId: id<AssetId>(),
  version: number({ min: 0, integer: true }),
  text: string({ min: 1, max: 4000 }),
  subtitle: subtitleTrackDecoder
});

/** Wire form of VoiceAsset: expiry as ISO string, converted by the runtime. */
export interface VoiceAssetWire extends Omit<VoiceAsset, "stream"> {
  readonly stream: { readonly handle: StreamHandle; readonly expiresAt: string | null };
}
