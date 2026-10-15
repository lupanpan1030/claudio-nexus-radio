import { createHash, randomUUID } from "node:crypto";
import { asId, type MediaId, type ProviderId, type RecordingId, type TrackRef } from "@claudio/contracts";
import { appError, throwIfAborted } from "../application/errors.js";
import { refScopedRevision } from "../application/sources.js";
import { abortableDelay, raceAbort } from "../application/operations.js";
import { probeAudioDuration } from "../adapters/audio/duration.js";
import { bytesStream } from "../adapters/files/byte-range.js";
import type { CatalogEntry, CatalogPort } from "../ports/catalog.js";
import type { LyricsLookup, LyricsSourcePort, RawLyrics } from "../ports/lyrics.js";
import type { MediaSourcePort, MediaStream, ResolveContext, ResolvedSource, SourceBinding, StreamRequest } from "../ports/media-source.js";
import type { ScriptRequest, ScriptWriterPort, SpeechSynthesisPort, SpeechVoiceDescriptor, WrittenScript } from "../ports/narration.js";
import type { ProviderModule } from "../ports/providers.js";
import type { RadioCandidate, RadioCandidatePort, RadioCandidateRequest } from "../ports/radio.js";
import { makeWav } from "./wav.js";

export interface FakeTrack {
  readonly mediaId: string;
  readonly title: string;
  readonly artist: string;
  bytes: Uint8Array;
  lyrics?: { readonly format: "lrc" | "krc" | "plain"; readonly text: string };
  playable?: boolean;
  /** Resolution waits this long (abortable) — for deadline tests. */
  resolveDelayMs?: number;
  /**
   * The source cannot prove what it serves (no content hash): every
   * resolution, refreshes included, is a new revision of an unverified recording.
   */
  continuityUnprovable?: boolean;
}

/**
 * In-memory music provider used as the "second source": registered under any
 * provider id, served through the same use cases as the real adapters.
 */
export class FakeProvider implements CatalogPort, MediaSourcePort, LyricsSourcePort {
  readonly tracks = new Map<string, FakeTrack>();
  resolveCalls = 0;
  openCalls = 0;
  /** When set, open() waits for this gate before answering (a slow upstream). */
  openGate: Promise<void> | null = null;

  constructor(readonly providerId: ProviderId) {}

  add(track: FakeTrack): TrackRef {
    this.tracks.set(track.mediaId, track);
    return { providerId: this.providerId, mediaId: asId<MediaId>(track.mediaId) };
  }

  module(): ProviderModule {
    return { providerId: this.providerId, catalog: this, source: this, lyrics: this };
  }

  describe(ref: TrackRef): CatalogEntry | null {
    const track = ref.providerId === this.providerId ? this.tracks.get(ref.mediaId) : undefined;
    return track ? this.entry(track) : null;
  }

  search(query: string, limit: number): readonly CatalogEntry[] {
    return [...this.tracks.values()]
      .filter((track) => !query || `${track.title} ${track.artist}`.includes(query))
      .slice(0, limit)
      .map((track) => this.entry(track));
  }

  private entry(track: FakeTrack): CatalogEntry {
    return {
      ref: { providerId: this.providerId, mediaId: asId<MediaId>(track.mediaId) },
      display: { title: track.title, artist: track.artist },
      playable: track.playable !== false,
      legacyTrackId: null
    };
  }

  async resolve(ref: TrackRef, context: ResolveContext): Promise<ResolvedSource> {
    this.resolveCalls += 1;
    const track = this.tracks.get(ref.mediaId);
    if (!track) throw appError("unavailable", "track_not_found");
    if (track.resolveDelayMs) await abortableDelay(track.resolveDelayMs, context.signal);
    throwIfAborted(context.signal);
    const hash = createHash("sha256").update(track.bytes).digest("hex");
    if (track.continuityUnprovable) {
      return {
        recording: { recordingId: asId<RecordingId>(`${this.providerId}:entry:${track.mediaId}`), confidence: "unverified" },
        sourceRevision: refScopedRevision(`${this.providerId}-u-`, ref, [randomUUID()]),
        duration: probeAudioDuration(track.bytes, "wav"),
        capabilities: { seekable: true, rangeRequests: true },
        expiresAt: null,
        binding: { mediaId: track.mediaId, hash }
      };
    }
    return {
      recording: { recordingId: asId<RecordingId>(`${this.providerId}:${hash.slice(0, 24)}`), confidence: "content-hash" },
      sourceRevision: refScopedRevision(`${this.providerId}-`, ref, [hash]),
      duration: probeAudioDuration(track.bytes, "wav"),
      capabilities: { seekable: true, rangeRequests: true },
      expiresAt: null,
      binding: { mediaId: track.mediaId, hash }
    };
  }

  async open(binding: SourceBinding, request: StreamRequest): Promise<MediaStream> {
    this.openCalls += 1;
    if (this.openGate) await raceAbort(this.openGate, request.signal);
    const track = this.tracks.get(String(binding.mediaId));
    const hash = track ? createHash("sha256").update(track.bytes).digest("hex") : "";
    // Same bytes or nothing: never substitute another recording.
    if (!track || hash !== binding.hash) throw appError("expired", "fake_source_changed");
    return bytesStream(track.bytes, "audio/wav", request.range);
  }

  async fetch(lookup: LyricsLookup): Promise<RawLyrics> {
    const track = this.tracks.get(String(lookup.binding.mediaId));
    if (!track || createHash("sha256").update(track.bytes).digest("hex") !== lookup.binding.hash) return { kind: "unmatched" };
    if (!track.lyrics) return { kind: "missing", reason: "not-found" };
    return { kind: "text", format: track.lyrics.format, text: track.lyrics.text, documentKey: `fake:${track.mediaId}` };
  }
}

/** Second TTS: deterministic WAV whose length follows the text, with call accounting. */
export class FakeSpeech implements SpeechSynthesisPort {
  readonly descriptor: SpeechVoiceDescriptor;
  readonly configured = true;
  calls = 0;
  aborted = 0;
  /** When set, synthesis waits for this gate (abortable). */
  gate: Promise<void> | null = null;

  constructor(name = "fake-tts", private readonly msPerChar = 40) {
    this.descriptor = { provider: name, model: "fake-model", voice: "fake-voice", format: "wav", options: "{}" };
  }

  async synthesize(text: string, options: { readonly signal: AbortSignal }): Promise<Uint8Array> {
    this.calls += 1;
    try {
      if (this.gate) await raceAbort(this.gate, options.signal);
      throwIfAborted(options.signal);
    } catch (error) {
      this.aborted += 1;
      throw error;
    }
    return makeWav(Math.max(200, text.length * this.msPerChar));
  }
}

/** Script writer whose completion the test controls. */
export class ControlledWriter implements ScriptWriterPort {
  readonly requests: ScriptRequest[] = [];
  private pending: Array<{ resolve: (value: WrittenScript) => void; reject: (error: unknown) => void }> = [];
  /** When set, writes complete immediately with this text. */
  immediate: string | null = null;

  write(request: ScriptRequest): Promise<WrittenScript> {
    this.requests.push(request);
    if (this.immediate !== null) return Promise.resolve({ text: `${this.immediate} ${request.to.display.title}`, writer: "fake" });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  /** Resolves every waiting write (including ones whose cue was already cancelled). */
  release(text = "下一首，慢慢进来。"): number {
    const waiting = this.pending;
    this.pending = [];
    for (const entry of waiting) entry.resolve({ text, writer: "fake" });
    return waiting.length;
  }

  get waiting(): number {
    return this.pending.length;
  }
}

/** Radio policy fake: first catalog entry not excluded; records the requests it saw. */
export class FakeRadio implements RadioCandidatePort {
  readonly requests: RadioCandidateRequest[] = [];

  constructor(private readonly entries: () => readonly CatalogEntry[]) {}

  async pick(request: RadioCandidateRequest): Promise<RadioCandidate | null> {
    this.requests.push(request);
    const excluded = new Set(request.exclude.map((ref) => `${ref.providerId}/${ref.mediaId}`));
    const recent = new Set(request.recent.map((ref) => `${ref.providerId}/${ref.mediaId}`));
    const pool = this.entries().filter((entry) => !excluded.has(`${entry.ref.providerId}/${entry.ref.mediaId}`));
    const entry = pool.find((item) => !recent.has(`${item.ref.providerId}/${item.ref.mediaId}`)) ?? pool[0];
    return entry ? { entry, reason: "fake radio", policy: "fake", considered: pool.map((item) => ({ ref: item.ref, score: 1 })) } : null;
  }
}

export function fakeTrack(mediaId: string, seed: number, extra: Partial<FakeTrack> = {}): FakeTrack {
  return { mediaId, title: `Song ${mediaId}`, artist: "Fixture Artist", bytes: makeWav(1500, { seed }), ...extra };
}
