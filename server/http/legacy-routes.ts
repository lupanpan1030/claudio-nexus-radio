import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import type { NowProjectionV1, TrackRef } from "@claudio/contracts";
import { API_V1_PATHS } from "@claudio/contracts";
import type { ChatDeps } from "../chat.js";
import type { ChatReply, PlaylistSuggestion, RadioPick, TasteAction, Track } from "../types.js";
import { contentTypeFor } from "../adapters/files/byte-range.js";

type Modules = typeof import("../db.js") &
  typeof import("../kugou.js") &
  typeof import("../kugou-library.js") &
  typeof import("../library.js") &
  typeof import("../now.js") &
  typeof import("../playlist.js") &
  typeof import("../radio.js") &
  typeof import("../playback-source.js") &
  typeof import("../track-dto.js") &
  typeof import("../tts.js") &
  typeof import("../userProfile.js") &
  typeof import("../weather.js") &
  typeof import("../calendar.js") &
  typeof import("../chat.js") &
  typeof import("../dj.js") &
  typeof import("../dj-samples.js") &
  typeof import("../llm.js");

/** The legacy business functions the routes need, injected by the composition root. */
export type LegacyApi = Pick<
  Modules,
  | "countTracks" | "getActiveDailyPlan" | "getRecommendationAudits" | "getTodayPicks" | "getTrack" | "getTracks"
  | "recordPlay" | "recordTaste" | "removeTaste"
  | "getKuGouUserPlaylists" | "getKuGouLoginStatus" | "logoutKuGou" | "healthCheckKuGouApi" | "loginKuGouCellphone"
  | "searchKuGouSong" | "sendKuGouCaptcha"
  | "getKuGouLibraryStatus" | "syncKuGouLibrary" | "scanLibrary"
  | "getNowPlayingSnapshot" | "subscribeNowPlaying" | "updateNowPlayingSnapshot"
  | "importAgentPlaylist" | "importLatestInboxPlaylist" | "importPendingInboxPlaylist" | "inspectPlaylistLink" | "suggestPlaylist"
  | "nextRadioPick" | "nextRadioQueue" | "getRadioDecision" | "planToday"
  | "clearPlaybackSourceCache" | "resolvePlaybackSource" | "warmPlaybackSourceCache"
  | "toLibraryResponse" | "getTtsFilePath" | "synthesizeTts" | "getUserProfileDocs" | "updateTasteProfile"
  | "getWeatherContext" | "sanitizeWeatherForDj" | "updateBrowserWeatherLocation" | "getCalendarContext"
  | "chatWithRadio" | "generateDjLine" | "generateProgramLine" | "appendDjSample" | "hasLlm"
> & {
  readonly config: {
    readonly libraryDir: string;
    readonly aiProvider: string;
    readonly aiModel: string;
    readonly djAiModel: string;
    readonly djAiTimeoutMs: number;
    readonly djAiReasoningEffort: string;
  };
};

/** v1-mode wiring for legacy non-playback features (supplied by the composition root). */
export interface LegacyV1Hooks {
  readonly chatDeps: ChatDeps;
  readonly recentTracks: () => Track[];
  readonly verifyPlayable: (track: Track) => Promise<boolean>;
  readonly refForLegacyTrack: (track: Pick<Track, "id" | "source">) => TrackRef | null;
  /** KuGou login/logout changed the account: provider caches and handles must be invalidated. */
  readonly onKuGouAccountChanged: () => void;
  readonly nowProjection: () => NowProjectionV1 | null;
  readonly subscribeNow: (listener: (projection: NowProjectionV1) => void) => () => void;
}

const allowedTasteActions = new Set<TasteAction>(["like", "skip", "commute", "morning", "work", "sleep", "focus", "nostalgia", "other"]);

function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function gone(replacement: string) {
  return (_req: Request, res: Response) => {
    res.status(410).json({
      error: "This playback endpoint is retired in the v1 protocol.",
      code: "legacy_endpoint_removed",
      replacement
    });
  };
}

export function createLegacyRouter(legacy: LegacyApi, mode: "v1" | "legacy", hooks: LegacyV1Hooks): Router {
  const router = express.Router();
  const v1 = mode === "v1";
  const authAttempts = new Map<string, { count: number; resetAt: number }>();

  function limitSensitiveAuth(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = req.ip || "unknown";
    const existing = authAttempts.get(key);
    const state = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : existing;
    state.count += 1;
    authAttempts.set(key, state);
    if (state.count > 5) {
      res.status(429).json({ ok: false, error: "Too many login attempts. Please wait one minute." });
      return;
    }
    next();
  }

  const withRef = <T extends RadioPick>(pick: T): T & { track?: TrackRef } => {
    if (!v1) return pick;
    const track = legacy.getTrack(pick.songId);
    const ref = track ? hooks.refForLegacyTrack(track) : null;
    return ref ? { ...pick, track: ref } : pick;
  };
  const playlistWithRefs = (playlist: PlaylistSuggestion) => (v1 ? { ...playlist, picks: playlist.picks.map(withRef) } : playlist);

  router.get("/api/health", async (_req, res) => {
    const activePlan = legacy.getActiveDailyPlan();
    const kugou = await legacy.healthCheckKuGouApi();
    res.json({
      ok: true,
      libraryDir: legacy.config.libraryDir,
      tracks: legacy.countTracks(),
      ai: legacy.hasLlm(),
      aiProvider: legacy.config.aiProvider,
      aiModel: legacy.config.aiModel,
      djAiModel: legacy.config.djAiModel || legacy.config.aiModel,
      djAiTimeoutMs: legacy.config.djAiTimeoutMs,
      djAiReasoningEffort: legacy.config.djAiReasoningEffort,
      kugou,
      playbackProtocol: mode,
      activeDailyPlan: activePlan
        ? { dateKey: activePlan.dateKey, activatedAt: activePlan.activatedAt, currentBlockKey: activePlan.currentBlockKey }
        : null
    });
  });

  // Legacy now-playing: in v1 it is a read-only view of the executor projection.
  const legacyNowView = () => {
    const projection = hooks.nowProjection();
    if (!projection) return { ...legacy.getNowPlayingSnapshot(), protocol: "v1-projection" };
    const item = projection.item;
    return {
      updatedAt: projection.observedAt,
      playback: { isPlaying: projection.transport === "playing", currentTime: (projection.positionMs ?? 0) / 1000, duration: 0, volume: 0 },
      currentTrack: item
        ? { id: item.track.mediaId, title: item.display?.title ?? "", artist: item.display?.artist ?? "", album: item.display?.album ?? "", extension: "", source: "main", playable: true }
        : null,
      currentPick: null,
      dj: null,
      queue: { activePlaylistId: null, activePlaylistTitle: null, length: 0, nextSongId: null },
      source: "web",
      protocol: "v1-projection",
      projection
    };
  };

  router.get("/api/now", (_req, res) => {
    res.json(v1 ? legacyNowView() : legacy.getNowPlayingSnapshot());
  });

  router.get("/api/now/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const write = (snapshot: unknown) => {
      res.write(`event: now\n`);
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    };
    const unsubscribe = v1
      ? (write(legacyNowView()), hooks.subscribeNow(() => write(legacyNowView())))
      : legacy.subscribeNowPlaying(write);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  if (v1) router.put("/api/now", gone(API_V1_PATHS.now));
  else router.put("/api/now", (req, res) => res.json(legacy.updateNowPlayingSnapshot(req.body)));

  router.get("/api/weather", async (_req, res) => {
    const weather = await legacy.getWeatherContext();
    res.json({ weather: legacy.sanitizeWeatherForDj(weather) });
  });

  router.put("/api/weather/location", async (req, res) => {
    try {
      legacy.updateBrowserWeatherLocation(req.body?.lat, req.body?.lng);
      const weather = await legacy.getWeatherContext();
      res.json({ ok: true, weather: legacy.sanitizeWeatherForDj(weather) });
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error, "weather location failed") });
    }
  });

  router.get("/api/calendar/context", (_req, res) => {
    res.json({ calendar: legacy.getCalendarContext() });
  });

  router.get("/api/kugou/health", async (_req, res) => {
    res.json(await legacy.healthCheckKuGouApi());
  });

  router.get("/api/kugou/login/status", (_req, res) => {
    res.json(legacy.getKuGouLoginStatus());
  });

  router.post("/api/kugou/logout", (_req, res) => {
    legacy.logoutKuGou();
    hooks.onKuGouAccountChanged();
    res.json(legacy.getKuGouLoginStatus());
  });

  router.post("/api/kugou/captcha/send", limitSensitiveAuth, async (req, res) => {
    try {
      res.json({ ok: true, result: await legacy.sendKuGouCaptcha(String(req.body?.mobile ?? "")) });
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error, "KuGou captcha failed") });
    }
  });

  router.post("/api/kugou/login/cellphone", limitSensitiveAuth, async (req, res) => {
    try {
      const result = await legacy.loginKuGouCellphone(
        String(req.body?.mobile ?? ""),
        String(req.body?.code ?? ""),
        typeof req.body?.userid === "string" ? req.body.userid : undefined
      );
      if (result.ok) hooks.onKuGouAccountChanged();
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error, "KuGou login failed") });
    }
  });

  router.get("/api/kugou/search", async (req, res) => {
    try {
      const keyword = String(req.query.q ?? req.query.keyword ?? "");
      if (!keyword.trim()) {
        res.status(400).json({ error: "keyword is required" });
        return;
      }
      res.json({ songs: await legacy.searchKuGouSong(keyword, Number(req.query.limit ?? 10)) });
    } catch (error) {
      res.status(502).json({ error: message(error, "KuGou search failed") });
    }
  });

  router.get("/api/kugou/playlists", async (_req, res) => {
    try {
      res.json({ playlists: await legacy.getKuGouUserPlaylists() });
    } catch (error) {
      const needsLogin = Boolean((error as Error & { needsLogin?: boolean })?.needsLogin);
      res.status(needsLogin ? 401 : 502).json({ error: message(error, "KuGou playlists failed"), needsLogin });
    }
  });

  router.get("/api/kugou/library/status", (_req, res) => {
    res.json(legacy.getKuGouLibraryStatus());
  });

  router.post("/api/kugou/library/sync", async (_req, res) => {
    try {
      const result = await legacy.syncKuGouLibrary();
      res.json(result);
      // v1 resolves sources on demand per preparation; no unowned background URL warm-up.
      if (!v1) void legacy.warmPlaybackSourceCache(240);
    } catch (error) {
      const needsLogin = Boolean((error as Error & { needsLogin?: boolean })?.needsLogin);
      res.status(needsLogin ? 401 : 502).json({ error: message(error, "KuGou library sync failed"), needsLogin });
    }
  });

  router.get("/api/taste-profile", async (_req, res) => {
    res.json(await legacy.getUserProfileDocs());
  });

  router.post("/api/taste-profile/train", async (req, res) => {
    try {
      res.json(await legacy.updateTasteProfile(String(req.body?.message ?? "")));
    } catch (error) {
      res.status(500).json({ error: message(error, "taste training failed") });
    }
  });

  router.post("/api/library/scan", async (_req, res) => {
    try {
      const tracks = await legacy.scanLibrary();
      res.json({ ok: true, count: tracks.length });
    } catch (error) {
      res.status(500).json({ ok: false, error: message(error, "scan failed") });
    }
  });

  router.get("/api/library", (req, res) => {
    const query = String(req.query.q ?? "");
    const limit = Number(req.query.limit ?? 500);
    const tracks = legacy.getTracks(limit, query, { searchFilePath: false });
    // v1 clients link rows to TrackRefs only through this server-stated ref.
    res.json(legacy.toLibraryResponse(tracks, legacy.countTracks(), v1 ? hooks.refForLegacyTrack : undefined));
  });

  if (v1) {
    // These resolved and proxied with a silent KuGou→local fallback; v1 binds one recording per handle.
    router.get("/api/track/:id/playback-source", gone(API_V1_PATHS.resolve));
    router.get("/api/track/:id/stream", gone(API_V1_PATHS.prepare));
    router.post("/api/radio/next", gone(API_V1_PATHS.prepare));
  } else {
    router.get("/api/track/:id/playback-source", async (req, res) => {
      try {
        const playback = await legacy.resolvePlaybackSource(req.params.id);
        res.json({ ...playback, streamUrl: `/api/track/${req.params.id}/stream` });
      } catch (error) {
        const text = message(error, "playback source failed");
        res.status(text === "track not found" ? 404 : 502).json({ error: text });
      }
    });

    router.get("/api/track/:id/stream", async (req, res) => {
      const track = legacy.getTrack(req.params.id);
      if (!track) {
        res.status(404).json({ error: "track not found" });
        return;
      }
      try {
        const playback = await legacy.resolvePlaybackSource(track.id);
        if (playback.mode === "api") {
          try {
            const remote = await fetch(playback.streamUrl, { headers: req.headers.range ? { Range: req.headers.range } : {} });
            if (!remote.ok || !remote.body) throw new Error(`remote audio returned ${remote.status}`);
            for (const header of ["accept-ranges", "content-length", "content-range"]) {
              const value = remote.headers.get(header);
              if (value) res.setHeader(header, value);
            }
            const remoteContentType = remote.headers.get("content-type");
            res.setHeader("content-type", remoteContentType?.startsWith("audio/") ? remoteContentType : "audio/mpeg");
            res.status(remote.status);
            const { Readable } = await import("node:stream");
            Readable.fromWeb(remote.body as never).pipe(res);
            return;
          } catch {
            legacy.clearPlaybackSourceCache(track.id);
          }
        }
      } catch {
        // Local playback below is the final fallback.
      }
      if (!track.playable || track.source === "kugou-api" || !fs.existsSync(track.filePath)) {
        res.status(502).json({ error: "KuGou playback failed and no local fallback is available" });
        return;
      }
      const stat = fs.statSync(track.filePath);
      const range = req.headers.range;
      const contentType = contentTypeFor(track.extension);
      if (!range) {
        res.writeHead(200, { "Content-Length": stat.size, "Content-Type": contentType, "Accept-Ranges": "bytes" });
        fs.createReadStream(track.filePath).pipe(res);
        return;
      }
      const [startText = "", endText = ""] = range.replace(/bytes=/, "").split("-");
      const start = Number.parseInt(startText, 10);
      const end = endText ? Number.parseInt(endText, 10) : stat.size - 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": contentType
      });
      fs.createReadStream(track.filePath, { start, end }).pipe(res);
    });

    router.post("/api/radio/next", async (req, res) => {
      try {
        const weather = req.body?.withWeather ? await legacy.getWeatherContext() : undefined;
        const pick = await legacy.nextRadioPick(String(req.body?.query ?? ""), weather, { useAi: req.body?.useAi === true });
        legacy.recordPlay(pick.songId, pick);
        res.json({ ...pick, weather });
      } catch (error) {
        res.status(500).json({ error: message(error, "radio pick failed") });
      }
    });
  }

  router.post("/api/dj/line", async (req, res) => {
    try {
      const result = await legacy.generateDjLine({
        songId: String(req.body?.songId ?? ""),
        query: String(req.body?.query ?? ""),
        reason: String(req.body?.reason ?? ""),
        moodTags: Array.isArray(req.body?.moodTags) ? req.body.moodTags.map((item: unknown) => String(item)) : [],
        previousLine: String(req.body?.previousLine ?? ""),
        // v1: lines are stored per cue; this route must not rewrite the latest pick/audit/play by track id.
        dryRun: v1 ? true : undefined
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: message(error, "dj line failed") });
    }
  });

  router.post("/api/dj/program-line", async (req, res) => {
    try {
      const type = String(req.body?.type ?? "opening");
      if (type !== "opening" && type !== "interlude" && type !== "closing") {
        res.status(400).json({ error: "invalid program line type" });
        return;
      }
      res.json(
        await legacy.generateProgramLine({
          type,
          scene: String(req.body?.scene ?? ""),
          recentTracks: Array.isArray(req.body?.recentTracks) ? req.body.recentTracks : []
        })
      );
    } catch (error) {
      res.status(500).json({ error: message(error, "program line failed") });
    }
  });

  router.post("/api/dj/sample-feedback", (req, res) => {
    try {
      const kind = String(req.body?.kind ?? "");
      if (kind !== "approved" && kind !== "rejected") {
        res.status(400).json({ ok: false, error: "invalid DJ sample feedback kind" });
        return;
      }
      const sample = legacy.appendDjSample(kind, {
        text: String(req.body?.text ?? ""),
        songId: typeof req.body?.songId === "string" ? req.body.songId : undefined,
        reason: typeof req.body?.reason === "string" ? req.body.reason : undefined
      });
      res.json({ ok: true, sample });
    } catch (error) {
      res.status(400).json({ ok: false, error: message(error, "DJ sample feedback failed") });
    }
  });

  router.post("/api/tts/synthesize", async (req, res) => {
    res.json(await legacy.synthesizeTts(String(req.body?.text ?? ""), "dj", { refresh: req.body?.refresh === true }));
  });

  router.get(/^\/api\/tts\/([a-f0-9]{64}\.(?:mp3|wav|ogg))$/i, (req, res) => {
    try {
      const fileName = String((req.params as Record<string, string>)[0] ?? "");
      const filePath = legacy.getTtsFilePath(fileName);
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: "tts file not found" });
        return;
      }
      const stat = fs.statSync(filePath);
      const ext = path.extname(fileName).toLowerCase();
      const contentType = ext === ".wav" ? "audio/wav" : ext === ".ogg" ? "audio/ogg" : "audio/mpeg";
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) {
          res.status(416).end();
          return;
        }
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : stat.size - 1;
        if (start >= stat.size || end >= stat.size || start > end) {
          res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
          return;
        }
        res.writeHead(206, {
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Content-Type": contentType
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { "Accept-Ranges": "bytes", "Content-Length": stat.size, "Content-Type": contentType });
      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      res.status(400).json({ error: message(error, "invalid tts file") });
    }
  });

  router.post("/api/radio/queue", async (req, res) => {
    try {
      const weather = req.body?.withWeather ? await legacy.getWeatherContext() : undefined;
      const count = Number(req.body?.count ?? 4);
      const options = { useAi: req.body?.useAi === true };
      // v1: recommendations only — no radio_picks rows, recency from confirmed listens.
      const picks: RadioPick[] = v1
        ? await recommendOnly(legacy, String(req.body?.query ?? ""), weather, count, { ...options, recent: hooks.recentTracks(), verifyPlayable: hooks.verifyPlayable })
        : await legacy.nextRadioQueue(String(req.body?.query ?? ""), weather, count, options);
      res.json({
        picks: picks.map((pick) => ({ ...withRef(pick), weather })),
        decisions: picks.map((pick) => pick.decision).filter(Boolean),
        ...(v1 ? { semantics: "recommendation-only" } : {})
      });
    } catch (error) {
      res.status(500).json({ error: message(error, "radio queue failed") });
    }
  });

  router.post("/api/playlist/suggest", async (req, res) => {
    try {
      const result = await legacy.suggestPlaylist(String(req.body?.scene ?? ""), {
        count: Number(req.body?.count ?? 10),
        ...(v1 ? { recent: hooks.recentTracks(), verifyPlayable: hooks.verifyPlayable } : {})
      });
      res.json(playlistWithRefs(result));
    } catch (error) {
      res.status(500).json({ error: message(error, "playlist suggestion failed") });
    }
  });

  router.post("/api/playlist/import", (req, res) => {
    try {
      res.json(playlistWithRefs(legacy.importAgentPlaylist(req.body?.playlist ?? req.body)));
    } catch (error) {
      res.status(400).json({ error: message(error, "playlist import failed") });
    }
  });

  router.post("/api/playlist/inbox/latest", (_req, res) => {
    try {
      res.json(playlistWithRefs(legacy.importLatestInboxPlaylist()));
    } catch (error) {
      res.status(404).json({ error: message(error, "playlist inbox is empty") });
    }
  });

  router.get("/api/playlist/inbox/pending", (_req, res) => {
    try {
      const playlist = legacy.importPendingInboxPlaylist();
      res.json({ playlist: playlist ? playlistWithRefs(playlist) : null });
    } catch (error) {
      res.status(400).json({ error: message(error, "pending playlist import failed") });
    }
  });

  router.post("/api/playlist/link/inspect", (req, res) => {
    res.json(legacy.inspectPlaylistLink(req.body?.url ?? req.body?.link ?? req.body));
  });

  router.post("/api/radio/plan-today", async (req, res) => {
    try {
      const weather = await legacy.getWeatherContext();
      res.json(await legacy.planToday(String(req.body?.message ?? "帮我规划今天的歌单"), weather));
    } catch (error) {
      res.status(500).json({ error: message(error, "daily plan failed") });
    }
  });

  router.post("/api/chat", async (req, res) => {
    try {
      const reply: ChatReply = await legacy.chatWithRadio(String(req.body?.message ?? ""), v1 ? hooks.chatDeps : undefined);
      if (!v1) {
        if (reply.pick) legacy.recordPlay(reply.pick.songId, reply.pick);
        res.json(reply);
        return;
      }
      // v1: a chat pick is a candidate for the queue; only the executor's started report records a listen.
      res.json({
        ...reply,
        ...(reply.pick ? { pick: withRef(reply.pick) } : {}),
        ...(reply.queuePick ? { queuePick: withRef(reply.queuePick) } : {}),
        ...(reply.playlist ? { playlist: playlistWithRefs(reply.playlist) } : {})
      });
    } catch (error) {
      res.status(500).json({ error: message(error, "chat failed") });
    }
  });

  router.get("/api/radio/today", (_req, res) => {
    // radio_picks are selections, not confirmed listens; v1 listens are at /api/v1/history/started.
    res.json({ picks: legacy.getTodayPicks(), semantics: "legacy-selection" });
  });

  router.get("/api/radio/audits", (req, res) => {
    res.json({ audits: legacy.getRecommendationAudits(Number(req.query.limit ?? 20)) });
  });

  const tastePayload = (req: Request) => ({
    trackId: String(req.body?.trackId ?? ""),
    action: String(req.body?.action ?? "") as TasteAction
  });

  router.post("/api/taste", (req, res) => {
    const { trackId, action } = tastePayload(req);
    if (!trackId || !allowedTasteActions.has(action)) {
      res.status(400).json({ ok: false, error: "invalid taste payload" });
      return;
    }
    legacy.recordTaste(trackId, action);
    res.json({ ok: true });
  });

  router.delete("/api/taste", (req, res) => {
    const { trackId, action } = tastePayload(req);
    if (!trackId || !allowedTasteActions.has(action)) {
      res.status(400).json({ ok: false, error: "invalid taste payload" });
      return;
    }
    legacy.removeTaste(trackId, action);
    res.json({ ok: true });
  });

  return router;
}

async function recommendOnly(
  legacy: LegacyApi,
  query: string,
  weather: Awaited<ReturnType<LegacyApi["getWeatherContext"]>> | undefined,
  count: number,
  options: Parameters<LegacyApi["getRadioDecision"]>[3]
): Promise<RadioPick[]> {
  const result = await legacy.getRadioDecision(query, weather, count, options);
  const seen = new Set<string>();
  return result.picks.filter((pick) => (seen.has(pick.songId) ? false : (seen.add(pick.songId), true))).slice(0, Math.max(1, count));
}
