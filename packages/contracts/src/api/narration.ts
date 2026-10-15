import { trackRefDecoder, type TrackRef } from "../catalog.js";
import type { CueId, PreparationId, QueueItemId, SourceRevision, TransitionId } from "../ids.js";
import { narrationScriptDecoder, type NarrationScript, type VoiceAssetWire } from "../narration.js";
import { stageDecoder, type Stage } from "../preparation.js";
import { id, nullable, number, object, refine, type Decoder } from "../validation.js";
import { protocolVersionDecoder, voiceAssetWireDecoder, type ProtocolVersion } from "./common.js";

export interface NarrationEndpointV1 {
  readonly itemId: QueueItemId;
  readonly track: TrackRef;
  readonly sourceRevision: SourceRevision | null;
}

/**
 * Script + voice for one cue. Results are stored by cue/preparation identity,
 * never by track id, so an earlier play of the same track is not rewritten.
 */
export interface NarrationRequestV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly cueId: CueId;
  readonly transitionId: TransitionId;
  readonly preparationId: PreparationId | null;
  readonly from: NarrationEndpointV1;
  readonly to: NarrationEndpointV1;
}

export interface NarrationResponseV1 {
  readonly protocolVersion: ProtocolVersion;
  readonly cueId: CueId;
  readonly transitionId: TransitionId;
  readonly version: number;
  readonly script: Stage<NarrationScript>;
  readonly voice: Stage<VoiceAssetWire>;
}

const endpointDecoder: Decoder<NarrationEndpointV1> = object<NarrationEndpointV1>({
  itemId: id<QueueItemId>(),
  track: trackRefDecoder,
  sourceRevision: nullable(id<SourceRevision>())
});

export const narrationRequestV1Decoder: Decoder<NarrationRequestV1> = object<NarrationRequestV1>({
  protocolVersion: protocolVersionDecoder,
  cueId: id<CueId>(),
  transitionId: id<TransitionId>(),
  preparationId: nullable(id<PreparationId>()),
  from: endpointDecoder,
  to: endpointDecoder
});

/**
 * When one payload carries both a ready script and a ready voice, the voice
 * must be the synthesis of that script. Whether the cue is still current is
 * the core's question, not the decoder's.
 */
export function checkVoiceMatchesScript(
  script: Stage<NarrationScript>,
  voice: Stage<VoiceAssetWire>,
  at: string,
  report: (subPath: string, message: string) => void
): void {
  if (script.status === "ready" && voice.status === "ready" && voice.value.scriptAssetId !== script.value.assetId) {
    report(`${at}.voice.value.scriptAssetId`, "voice was synthesized from a different script asset");
  }
}

export const narrationResponseV1Decoder: Decoder<NarrationResponseV1> = refine(
  object<NarrationResponseV1>({
    protocolVersion: protocolVersionDecoder,
    cueId: id<CueId>(),
    transitionId: id<TransitionId>(),
    version: number({ min: 0, integer: true }),
    script: stageDecoder(narrationScriptDecoder),
    voice: stageDecoder(voiceAssetWireDecoder)
  }),
  (response, report) => checkVoiceMatchesScript(response.script, response.voice, "", report)
);
