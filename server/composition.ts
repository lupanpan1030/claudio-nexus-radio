import path from "node:path";
import { asId, type MediaId, type ProviderId, type TrackRef } from "@claudio/contracts";
import type { PlaybackPolicy } from "./application/policy.js";
import { FishSpeechSynthesis } from "./adapters/fish/fish-tts.js";
import { KuGouClient } from "./adapters/kugou/client.js";
import { KuGouLyrics, KuGouMediaSource } from "./adapters/kugou/kugou-source.js";
import { LegacyModelScriptWriter, LegacyRulesRadioCandidates, type LegacyDjLineGenerator, type LegacyDjTrack } from "./adapters/legacy/legacy-planning.js";
import { LocalFingerprints, LocalMediaSource, LocalSidecarLyrics } from "./adapters/local/local-source.js";
import { LegacyTrackCatalog, TrackRowReader } from "./adapters/sqlite/track-catalog.js";
import type { AppDeps } from "./http/app.js";
import type { LegacyApi, LegacyV1Hooks } from "./http/legacy-routes.js";
import { assemblePlayback, type PlaybackAssembly } from "./playback-assembly.js";
import type { ProviderModule } from "./ports/providers.js";
import type { Track } from "./types.js";

/** Composition rule mapping legacy tracks.source to provider ids; the only place these ids are named. */
export const LOCAL_PROVIDER = asId<ProviderId>("local");
export const KUGOU_PROVIDER = asId<ProviderId>("kugou");
const LOCAL_SOURCES = ["main", "kugou-cache"] as const;
const KUGOU_SOURCES = ["kugou-api"] as const;

/**
 * The one legacy row → TrackRef rule (library, recent history, radio, hooks).
 * It names the same source lists each provider's catalog is built from, so a
 * ref exists exactly when that catalog describes the row; any other stored
 * source maps to null.
 */
export function legacyRefFor(row: { id: string; source: string }): TrackRef | null {
  const providerId = (KUGOU_SOURCES as readonly string[]).includes(row.source)
    ? KUGOU_PROVIDER
    : (LOCAL_SOURCES as readonly string[]).includes(row.source)
      ? LOCAL_PROVIDER
      : null;
  return providerId ? { providerId, mediaId: asId<MediaId>(row.id) } : null;
}

/**
 * A catalog entry without a legacy row, described to the legacy DJ writer by
 * its metadata. Only title/artist/album reach the prompt; it is never stored.
 */
function promptOnlyTrack(track: LegacyDjTrack): Track {
  return {
    id: `catalog:${track.title}:${track.artist}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    filePath: "",
    folder: "",
    extension: "",
    source: "main",
    playable: true,
    size: 0,
    addedAt: ""
  };
}

/**
 * The v1 writer's line generator: the legacy model-first DJ writer, always in
 * dry-run, told about the track by its legacy row when there is one and by
 * catalog metadata otherwise.
 */
export function legacyDjLineGenerator(deps: {
  readonly getTrack: (legacyTrackId: string) => Track | undefined;
  readonly generate: typeof import("./dj.js").generateDjLineForTrack;
}): LegacyDjLineGenerator {
  return (input) =>
    deps.generate({
      track: (input.track.legacyTrackId ? deps.getTrack(input.track.legacyTrackId) : undefined) ?? promptOnlyTrack(input.track),
      handover: input.handover,
      dryRun: true,
      signal: input.signal
    });
}

export interface PlaybackSettings {
  readonly protocol: "v1" | "legacy";
  readonly kugouUrlTtlMs: number;
  readonly gcIntervalMs: number;
  readonly policy: Partial<PlaybackPolicy>;
}

function numberFrom(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = env[key];
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** v1 settings from the environment. Protocol defaults to v1 (single switch, chosen at startup). */
export function readPlaybackSettings(env: NodeJS.ProcessEnv): PlaybackSettings {
  const policy: Partial<{ -readonly [K in keyof PlaybackPolicy]: PlaybackPolicy[K] }> = {};
  const map: Array<[keyof PlaybackPolicy, string]> = [
    ["sourceDeadlineMs", "CLAUDIO_SOURCE_DEADLINE_MS"],
    ["lyricsDeadlineMs", "CLAUDIO_LYRICS_DEADLINE_MS"],
    ["scriptDeadlineMs", "CLAUDIO_SCRIPT_DEADLINE_MS"],
    ["voiceDeadlineMs", "CLAUDIO_VOICE_DEADLINE_MS"],
    ["voicePlaybackRate", "CLAUDIO_VOICE_PLAYBACK_RATE"]
  ];
  for (const [key, envKey] of map) {
    const value = numberFrom(env, envKey);
    if (value !== undefined) policy[key] = value;
  }
  return {
    protocol: env.CLAUDIO_PLAYBACK_PROTOCOL === "legacy" ? "legacy" : "v1",
    kugouUrlTtlMs: numberFrom(env, "CLAUDIO_KUGOU_URL_TTL_MS") ?? 20 * 60_000,
    gcIntervalMs: numberFrom(env, "CLAUDIO_GC_INTERVAL_MS") ?? 10 * 60_000,
    policy
  };
}

export interface ClaudioServices {
  readonly appDeps: AppDeps;
  readonly playback: PlaybackAssembly;
  readonly settings: PlaybackSettings;
  readonly listen: { readonly port: number; readonly host: string };
  /** Startup library scan when the catalog is empty (bootstrap decides whether to call it). */
  scanIfEmpty(): Promise<string | null>;
  close(): void;
}

/**
 * Real assembly. Legacy modules read .env/DATA_DIR and open the database when
 * imported, so they are imported here — only when services are requested.
 */
export async function createServices(env: NodeJS.ProcessEnv = process.env): Promise<ClaudioServices> {
  const { config } = await import("./config.js");
  const db = await import("./db.js");
  const kugou = await import("./kugou.js");
  const kugouLibrary = await import("./kugou-library.js");
  const library = await import("./library.js");
  const now = await import("./now.js");
  const playlist = await import("./playlist.js");
  const radio = await import("./radio.js");
  const playbackSource = await import("./playback-source.js");
  const trackDto = await import("./track-dto.js");
  const tts = await import("./tts.js");
  const userProfile = await import("./userProfile.js");
  const weather = await import("./weather.js");
  const calendar = await import("./calendar.js");
  const chat = await import("./chat.js");
  const dj = await import("./dj.js");
  const djSamples = await import("./dj-samples.js");
  const llm = await import("./llm.js");

  const settings = readPlaybackSettings(env);
  const rows = new TrackRowReader(db.db);
  const kugouClient = new KuGouClient({
    baseUrl: config.kugouApiBaseUrl,
    credentials: kugou.getKuGouSessionCredentials,
    // Same starter as the legacy routes: KUGOU_API_AUTOSTART decides, disabled never launches.
    ensureReady: (signal) => kugou.bundledKuGouApi.ensure(signal)
  });
  const providers: ProviderModule[] = [
    {
      providerId: LOCAL_PROVIDER,
      catalog: new LegacyTrackCatalog(rows, LOCAL_PROVIDER, LOCAL_SOURCES),
      source: new LocalMediaSource({ rows, sources: LOCAL_SOURCES, fingerprints: new LocalFingerprints(db.db), libraryDir: config.libraryDir }),
      lyrics: new LocalSidecarLyrics()
    },
    {
      providerId: KUGOU_PROVIDER,
      catalog: new LegacyTrackCatalog(rows, KUGOU_PROVIDER, KUGOU_SOURCES),
      source: new KuGouMediaSource({
        rows,
        client: kugouClient,
        search: kugou.searchKuGouSong,
        score: (wanted, hit) => kugou.scoreKuGouSongMatch(wanted, { title: hit.title, artist: hit.artist }),
        urlTtlMs: settings.kugouUrlTtlMs,
        clock: { now: () => Date.now() }
      }),
      lyrics: new KuGouLyrics(kugouClient)
    }
  ];

  const describeLegacy = (legacyTrackId: string) => {
    const track = db.getTrack(legacyTrackId);
    const ref = track ? legacyRefFor(track) : null;
    return ref ? playback.services.providers.describe(ref) : null;
  };
  const toLegacyId = (ref: TrackRef) => (ref.providerId === LOCAL_PROVIDER || ref.providerId === KUGOU_PROVIDER ? ref.mediaId : null);

  const playback = assemblePlayback({
    db: db.db,
    providers,
    radio: new LegacyRulesRadioCandidates({
      choose: (options) => radio.chooseRadioCandidate({ ...options, servable: (track) => legacyRefFor(track) !== null }),
      toLegacyId,
      describeLegacy
    }),
    writer: new LegacyModelScriptWriter(legacyDjLineGenerator({ getTrack: db.getTrack, generate: dj.generateDjLineForTrack }), llm.hasLlm),
    tts: new FishSpeechSynthesis({
      apiKey: config.fishTtsKey,
      endpoint: config.fishTtsEndpoint,
      model: config.fishTtsModel,
      voiceId: config.fishTtsVoiceId,
      format: config.fishTtsFormat,
      latency: config.fishTtsLatency,
      proxy: config.fishTtsProxy
    }),
    voiceDir: path.join(config.dataDir, "tts-v2"),
    legacyRef: legacyRefFor,
    policy: settings.policy
  });

  // List filtering only (chat/playlist/radio queue): cheap local checks, briefly remembered remote resolves.
  const verifyPlayable = async (track: Pick<Track, "id" | "source">) => {
    const ref = legacyRefFor(track);
    return ref ? playback.playability.check(ref, AbortSignal.timeout(playback.services.policy.sourceDeadlineMs)) : false;
  };
  const recentTracks = (): Track[] => {
    const started = playback.stores.started
      .recent(30)
      .map((fact) => (fact.legacyTrackId ? db.getTrack(fact.legacyTrackId) : undefined))
      .filter((track): track is Track => Boolean(track));
    return [...started, ...db.getRecentPlays(18)];
  };

  const legacyApi: LegacyApi = {
    ...db,
    ...kugou,
    ...kugouLibrary,
    ...library,
    ...now,
    ...playlist,
    ...radio,
    ...playbackSource,
    ...trackDto,
    ...tts,
    ...userProfile,
    ...weather,
    ...calendar,
    ...chat,
    ...dj,
    ...djSamples,
    ...llm,
    config: {
      libraryDir: config.libraryDir,
      aiProvider: config.aiProvider,
      aiModel: config.aiModel,
      djAiModel: config.djAiModel,
      djAiTimeoutMs: config.djAiTimeoutMs,
      djAiReasoningEffort: config.djAiReasoningEffort
    }
  };

  const legacyHooks: LegacyV1Hooks = {
    chatDeps: { verifyPlayable, recentTracks },
    recentTracks,
    verifyPlayable,
    refForLegacyTrack: legacyRefFor,
    onKuGouAccountChanged: () => {
      playback.stores.handles.revokeWhere(KUGOU_PROVIDER, () => true);
    },
    nowProjection: () => playback.services.now.get(),
    subscribeNow: (listener) => playback.services.now.subscribe(listener)
  };

  return {
    settings,
    playback,
    listen: { port: config.port, host: config.host },
    appDeps: {
      playbackProtocol: settings.protocol,
      playback: playback.services,
      legacy: legacyApi,
      legacyHooks,
      staticDir: path.join(process.cwd(), "dist")
    },
    async scanIfEmpty() {
      if (db.countTracks() > 0) return null;
      const tracks = await library.scanLibrary();
      return `Scanned ${tracks.length} tracks from ${config.libraryDir}`;
    },
    close() {
      playback.close();
      db.db.close();
    }
  };
}
