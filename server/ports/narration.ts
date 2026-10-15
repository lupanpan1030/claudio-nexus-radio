import type { DurationInfo } from "@claudio/contracts";
import type { CatalogEntry } from "./catalog.js";
import type { MediaStream } from "./media-source.js";

export interface ScriptRequest {
  /** The item the narration leads into. */
  readonly to: CatalogEntry;
  /** The item playing before the hand-over, when known. */
  readonly from: CatalogEntry | null;
  /** Catalog entries of recently *started* items, newest first (confirmed listening, never mere selections). */
  readonly recentStarted: readonly CatalogEntry[];
  /**
   * Recently generated narration texts, newest first. Generated is not aired
   * (a cue may have been cancelled or skipped): use them to avoid repeating
   * wording, never as things the listener heard.
   */
  readonly recentGenerated: readonly string[];
  readonly signal: AbortSignal;
}

export interface WrittenScript {
  readonly text: string;
  /** Short writer label kept with the stored script (e.g. "model", "rules"). */
  readonly writer: string;
}

export interface ScriptWriterPort {
  write(request: ScriptRequest): Promise<WrittenScript>;
}

export type SpeechFormat = "mp3" | "wav" | "ogg";

/**
 * Everything that changes the produced audio. Part of the voice cache key, so
 * switching provider/model/voice/format/options never reuses stale audio.
 */
export interface SpeechVoiceDescriptor {
  readonly provider: string;
  readonly model: string;
  readonly voice: string;
  readonly format: SpeechFormat;
  /** Other output-affecting options, serialized (e.g. latency mode). */
  readonly options: string;
}

export interface SpeechSynthesisPort {
  readonly descriptor: SpeechVoiceDescriptor;
  /** False when credentials/endpoint are missing; callers report it instead of calling. */
  readonly configured: boolean;
  /** Returns encoded audio in descriptor.format. Must honour the signal for body reads too. */
  synthesize(text: string, options: { readonly signal: AbortSignal }): Promise<Uint8Array>;
}

/** Content-addressed voice files. Writes are atomic: a name either has complete bytes or nothing. */
export interface VoiceFileStore {
  /** Size in bytes, or null when absent. */
  size(fileName: string): number | null;
  writeAtomic(fileName: string, bytes: Uint8Array): Promise<void>;
  open(fileName: string, range: string | null, signal: AbortSignal): Promise<MediaStream>;
  remove(fileName: string): void;
}

/** Measures encoded audio length from its bytes; "unknown" when it cannot. */
export type AudioDurationProbe = (bytes: Uint8Array, format: SpeechFormat) => DurationInfo;
