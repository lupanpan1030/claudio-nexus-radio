import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TrackRef } from "@claudio/contracts";
import { PlaybackGc } from "./application/gc.js";
import { StartedService } from "./application/history/started-service.js";
import { LyricsService } from "./application/lyrics/lyrics-service.js";
import { CueService } from "./application/narration/cue-service.js";
import { VoiceService } from "./application/narration/voice-service.js";
import { NowService } from "./application/now/now-service.js";
import { DEFAULT_PLAYBACK_POLICY, type PlaybackPolicy } from "./application/policy.js";
import { PreparationService } from "./application/preparation/preparation-service.js";
import { SourceResolver, StreamAccess, StreamHandles } from "./application/sources.js";
import { probeAudioDuration } from "./adapters/audio/duration.js";
import { DiskVoiceFileStore } from "./adapters/files/voice-files.js";
import { runMigrations } from "./adapters/sqlite/migrations.js";
import { createSqlitePlaybackStores } from "./adapters/sqlite/playback-stores.js";
import { STREAM_HANDLE_PREFIX, type PlaybackServices } from "./http/v1-routes.js";
import type { ScriptWriterPort, SpeechSynthesisPort } from "./ports/narration.js";
import { ProviderRegistry, type ProviderModule } from "./ports/providers.js";
import type { RadioCandidatePort } from "./ports/radio.js";
import { systemClock, type Clock, type IdSource } from "./ports/runtime.js";

export interface PlaybackAssemblyInput {
  readonly db: DatabaseSync;
  readonly providers: readonly ProviderModule[];
  readonly radio: RadioCandidatePort;
  readonly writer: ScriptWriterPort;
  readonly tts: SpeechSynthesisPort;
  /** Directory for v2 voice files (separate namespace from the legacy tts/ cache). */
  readonly voiceDir: string;
  /** Maps a legacy plays/tracks row to its provider ref (composition rule). */
  readonly legacyRef: (row: { id: string; source: string }) => TrackRef | null;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  readonly policy?: Partial<PlaybackPolicy>;
  readonly serverInstanceId?: string;
}

export interface PlaybackAssembly {
  readonly services: PlaybackServices;
  readonly gc: PlaybackGc;
  readonly stores: ReturnType<typeof createSqlitePlaybackStores>;
  /** Restart recovery: unfinished preparations/cues become "interrupted". */
  readonly recovered: { readonly preparations: number; readonly cues: number };
  close(): void;
}

export const randomIds: IdSource = { next: (prefix) => `${prefix}_${randomUUID()}` };

/** Wires the playback use cases from ports. Runs migrations; never listens or scans. */
export function assemblePlayback(input: PlaybackAssemblyInput): PlaybackAssembly {
  runMigrations(input.db);
  const clock = input.clock ?? systemClock;
  const ids = input.ids ?? randomIds;
  const policy: PlaybackPolicy = { ...DEFAULT_PLAYBACK_POLICY, ...input.policy };
  const serverInstanceId = input.serverInstanceId ?? `srv_${randomUUID()}`;
  const stores = createSqlitePlaybackStores(input.db, input.legacyRef);
  const providers = new ProviderRegistry(input.providers);
  const handleFormat = new StreamHandles(STREAM_HANDLE_PREFIX);

  const sources = new SourceResolver({ providers, resolvedSources: stores.resolvedSources, handles: stores.handles, handleFormat, clock, policy });
  const voices = new VoiceService({
    tts: input.tts,
    cache: stores.voiceCache,
    files: new DiskVoiceFileStore(input.voiceDir),
    probe: probeAudioDuration,
    handles: stores.handles,
    handleFormat,
    clock,
    ids,
    policy
  });
  const streams = new StreamAccess({
    providers,
    handles: stores.handles,
    clock,
    openVoice: (binding, range, signal) => voices.open(binding, range, signal)
  });
  const lyrics = new LyricsService({ providers, resolvedSources: stores.resolvedSources, store: stores.lyrics, clock, policy });
  const cues = new CueService({ store: stores.cues, scripts: stores.scripts, writer: input.writer, voices, providers, clock, ids, policy });
  const preparations = new PreparationService({
    store: stores.preparations,
    reservations: stores.reservations,
    audits: stores.audits,
    history: stores.history,
    providers,
    radio: input.radio,
    sources,
    lyrics,
    cues,
    clock,
    ids,
    policy,
    ownerInstance: serverInstanceId
  });
  const started = new StartedService({ store: stores.started, resolvedSources: stores.resolvedSources, reservations: stores.reservations, providers, clock });
  const now = new NowService();
  const gc = new PlaybackGc({
    preparations,
    preparationStore: stores.preparations,
    cueStore: stores.cues,
    handles: stores.handles,
    reservations: stores.reservations,
    voices,
    now,
    clock,
    policy
  });

  const recovered = { preparations: preparations.recoverAfterRestart(), cues: cues.recoverAfterRestart() };
  return {
    services: { preparations, cues, sources, streams, lyrics, started, now, audits: stores.audits, providers, policy, serverInstanceId },
    gc,
    stores,
    recovered,
    close() {
      preparations.close();
      cues.close();
    }
  };
}
