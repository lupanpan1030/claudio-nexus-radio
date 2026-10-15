import {
  PROTOCOL_VERSION,
  isStageSettled,
  lyricsMatchRecording,
  lyricsResponseV1Decoder,
  narrationResponseV1Decoder,
  startedRequestFromReceipt,
  startedResponseV1Decoder,
  voiceAssetFromWire,
  type CueAsset,
  type ExecutorInstanceId,
  type LyricsAvailability,
  type LyricsRequestV1,
  type NarrationRequestV1,
  type NarrationResponseV1,
  type PlaybackReceipt,
  type StreamHandle
} from "@claudio/contracts";
import type { CuePort, CueRequest, LyricsPort, LyricsRequest, MediaSourceSpec, ReceiptPort, StreamUrlPort } from "@claudio/playback-web";
import { bestEffort, portError, requestJson, type FetchLike } from "./http";
import { stageFailure, type PreparationTimings, DEFAULT_PREPARATION_TIMINGS, type HttpPreparePort } from "./preparation";
import { fillPath, type ProtocolPaths } from "./protocol";

/**
 * Narration for one cue: POST starts (idempotent per cueId on the server),
 * repeated POSTs long-poll newer versions until script and voice settle.
 * Cancelling sends a best-effort DELETE for the cue when the server announced
 * that path; the core has already dropped the cue either way.
 */
export class HttpCuePort implements CuePort {
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly paths: ProtocolPaths,
    private readonly preparations: Pick<HttpPreparePort, "preparationFor">,
    private readonly timings: PreparationTimings = DEFAULT_PREPARATION_TIMINGS
  ) {}

  async request(request: CueRequest, signal: AbortSignal): Promise<CueAsset> {
    const { binding } = request;
    const body: NarrationRequestV1 = {
      protocolVersion: PROTOCOL_VERSION,
      cueId: binding.cueId,
      transitionId: binding.transitionId,
      preparationId: this.preparations.preparationFor(binding.toItemId),
      from: { itemId: binding.fromItemId, track: request.from, sourceRevision: binding.fromRevision },
      to: { itemId: binding.toItemId, track: request.to, sourceRevision: binding.toRevision }
    };
    const onAbort = () => {
      if (this.paths.narrationCue) void bestEffort(this.fetchFn, "DELETE", fillPath(this.paths.narrationCue, "cueId", binding.cueId), this.timings.cancelTimeoutMs);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      let afterVersion = -1;
      let latest: NarrationResponseV1 | null = null;
      for (;;) {
        const path = `${this.paths.narration}?afterVersion=${afterVersion}&waitMs=${this.timings.waitMs}`;
        const response = await requestJson(this.fetchFn, { method: "POST", path, body, signal, timeoutMs: this.timings.requestTimeoutMs }, narrationResponseV1Decoder);
        if (response.cueId !== binding.cueId || response.transitionId !== binding.transitionId) throw portError("invalid", "cue_identity_mismatch");
        if (latest === null || response.version > latest.version) latest = response;
        afterVersion = latest.version;
        const scriptError = stageFailure(latest.script, "script");
        if (scriptError) throw scriptError;
        const voiceError = stageFailure(latest.voice, "voice");
        if (voiceError) throw voiceError;
        if (latest.script.status === "ready" && latest.voice.status === "ready") {
          return { script: latest.script.value, voice: voiceAssetFromWire(latest.voice.value) };
        }
        if (isStageSettled(latest.script) && isStageSettled(latest.voice)) throw portError("unavailable", "cue_incomplete");
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export class HttpLyricsPort implements LyricsPort {
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly paths: ProtocolPaths,
    private readonly timeoutMs = 12_000
  ) {}

  async lookup(request: LyricsRequest, signal: AbortSignal): Promise<LyricsAvailability> {
    const body: LyricsRequestV1 = {
      protocolVersion: PROTOCOL_VERSION,
      itemId: request.itemId,
      track: request.track,
      recordingId: request.recordingId,
      sourceRevision: request.sourceRevision
    };
    const response = await requestJson(this.fetchFn, { method: "POST", path: this.paths.lyrics, body, signal, timeoutMs: this.timeoutMs }, lyricsResponseV1Decoder);
    if (response.itemId !== request.itemId || !lyricsMatchRecording(response, request)) throw portError("invalid", "lyrics_identity_mismatch");
    return response.result;
  }
}

/** Started receipts; the wall time is the runtime clock (epoch-aligned) rendered as ISO. */
export class HttpReceiptPort implements ReceiptPort {
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly paths: ProtocolPaths,
    private readonly executorInstanceId: ExecutorInstanceId,
    private readonly timeoutMs = 10_000
  ) {}

  async report(receipt: PlaybackReceipt, signal: AbortSignal): Promise<"recorded" | "duplicate"> {
    const body = startedRequestFromReceipt(receipt, this.executorInstanceId, new Date(receipt.at).toISOString());
    const response = await requestJson(this.fetchFn, { method: "POST", path: this.paths.started, body, signal, timeoutMs: this.timeoutMs }, startedResponseV1Decoder);
    if (response.idempotencyKey !== receipt.idempotencyKey) throw portError("invalid", "receipt_key_mismatch");
    return response.status;
  }
}

/**
 * Stream handles are opaque; today the server issues same-origin paths under
 * its announced streams route. Anything else is refused rather than loaded,
 * so a handle can never point the media element somewhere unexpected.
 */
export function createStreamUrls(paths: ProtocolPaths, origin: string): StreamUrlPort {
  const prefix = paths.streams ? paths.streams.slice(0, paths.streams.indexOf(":token")) : null;
  const toSpec = (handle: StreamHandle): MediaSourceSpec => {
    const value = String(handle);
    if (prefix && value.startsWith(prefix) && !value.startsWith("//")) return { url: new URL(value, origin).href, crossOrigin: null };
    throw portError("invalid", "unsupported_stream_handle");
  };
  return { music: toSpec, voice: toSpec };
}
