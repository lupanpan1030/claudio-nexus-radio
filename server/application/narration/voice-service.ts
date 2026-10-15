import { createHash } from "node:crypto";
import { asId, type AssetId, type VoiceAssetWire } from "@claudio/contracts";
import type { MediaStream, SourceBinding } from "../../ports/media-source.js";
import type { AudioDurationProbe, SpeechSynthesisPort, VoiceFileStore } from "../../ports/narration.js";
import type { Clock, IdSource } from "../../ports/runtime.js";
import type { StreamHandleStore, VoiceCacheEntry, VoiceCacheStore } from "../../ports/stores.js";
import { appError, throwIfAborted } from "../errors.js";
import { raceAbort, SharedFlight, withDeadline } from "../operations.js";
import type { PlaybackPolicy } from "../policy.js";
import type { StreamHandles } from "../sources.js";

const VOICE_CACHE_NAMESPACE = "claudio.voice.v2";
const MAX_VOICE_TEXT = 500;
/** Shorter outputs are treated as provider failures (kept from the existing Fish integration). */
const MIN_AUDIO_BYTES = 128;

/**
 * Turns a script into a cached, measured voice asset. The cache key covers
 * provider/model/voice/format/options and text, so any change produces new
 * audio. Concurrent requests for the same key share one synthesis; each
 * caller can cancel without stopping the others.
 */
export class VoiceService {
  private readonly flights = new SharedFlight<VoiceCacheEntry>();

  constructor(
    private readonly deps: {
      readonly tts: SpeechSynthesisPort;
      readonly cache: VoiceCacheStore;
      readonly files: VoiceFileStore;
      readonly probe: AudioDurationProbe;
      readonly handles: StreamHandleStore;
      readonly handleFormat: StreamHandles;
      readonly clock: Clock;
      readonly ids: IdSource;
      readonly policy: PlaybackPolicy;
    }
  ) {}

  contentKey(text: string): string {
    const descriptor = this.deps.tts.descriptor;
    return createHash("sha256")
      .update(JSON.stringify({ ns: VOICE_CACHE_NAMESPACE, ...descriptor, text }))
      .digest("hex");
  }

  async synthesize(input: { readonly scriptAssetId: AssetId; readonly text: string }, signal: AbortSignal): Promise<VoiceAssetWire> {
    const { tts, cache, files, clock, policy } = this.deps;
    const text = input.text.trim();
    if (!text) throw appError("invalid", "voice_text_empty");
    if (text.length > MAX_VOICE_TEXT) throw appError("invalid", "voice_text_too_long");
    if (!tts.configured) throw appError("unavailable", "tts_not_configured", "speech synthesis is not configured");

    const key = this.contentKey(text);
    const cached = cache.get(key);
    let entry: VoiceCacheEntry;
    if (cached && files.size(cached.fileName) === cached.bytes) {
      cache.touch(key, clock.now());
      entry = cached;
    } else {
      entry = await this.flights.run(key, (flightSignal) => this.produce(key, text, flightSignal), signal);
    }
    throwIfAborted(signal);

    const now = clock.now();
    const { token, handle } = this.deps.handleFormat.issue();
    this.deps.handles.insert({
      token,
      kind: "voice",
      providerId: null,
      sourceRevision: null,
      binding: { fileName: entry.fileName, contentKey: entry.contentKey, format: tts.descriptor.format },
      expiresAt: null,
      retainUntil: now + policy.maxTtlMs + policy.gcAfterMs,
      createdAt: now
    });
    return {
      assetId: asId<AssetId>(this.deps.ids.next("va")),
      scriptAssetId: input.scriptAssetId,
      stream: { handle, expiresAt: null },
      duration: entry.duration,
      playbackRate: policy.voicePlaybackRate
    };
  }

  private async produce(key: string, text: string, signal: AbortSignal): Promise<VoiceCacheEntry> {
    const { tts, cache, files, probe, clock, policy } = this.deps;
    const scoped = withDeadline(signal, policy.voiceDeadlineMs);
    try {
      // The deadline settles the synthesis even when the provider ignores its signal.
      const bytes = await raceAbort(tts.synthesize(text, { signal: scoped.signal }), scoped.signal);
      throwIfAborted(scoped.signal);
      if (bytes.byteLength < MIN_AUDIO_BYTES) throw appError("retryable", "tts_empty_audio", "speech provider returned no audio");
      const format = tts.descriptor.format;
      const fileName = `${key}.${format}`;
      await files.writeAtomic(fileName, bytes);
      const now = clock.now();
      const entry: VoiceCacheEntry = {
        contentKey: key,
        fileName,
        bytes: bytes.byteLength,
        duration: probe(bytes, format),
        descriptor: JSON.stringify(tts.descriptor),
        createdAt: now,
        lastUsedAt: now
      };
      cache.put(entry);
      return entry;
    } finally {
      scoped.dispose();
    }
  }

  open(binding: SourceBinding, range: string | null, signal: AbortSignal): Promise<MediaStream> {
    const fileName = typeof binding.fileName === "string" ? binding.fileName : "";
    if (!/^[a-f0-9]{64}\.(mp3|wav|ogg)$/.test(fileName)) throw appError("invalid", "voice_handle_corrupt");
    if (this.deps.files.size(fileName) === null) throw appError("expired", "voice_asset_collected", "voice asset is gone; request the cue again");
    return this.deps.files.open(fileName, range, signal);
  }

  /** Removes unused cache files older than the retention window that no live handle points to. */
  collect(now: number): number {
    const referenced = this.deps.handles.referencedVoiceKeys();
    let removed = 0;
    for (const entry of this.deps.cache.listUnusedSince(now - this.deps.policy.voiceRetentionMs)) {
      if (referenced.has(entry.contentKey)) continue;
      this.deps.files.remove(entry.fileName);
      this.deps.cache.remove(entry.contentKey);
      removed += 1;
    }
    return removed;
  }
}
