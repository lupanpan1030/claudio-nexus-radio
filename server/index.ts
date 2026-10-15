import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import express from "express";
import { getCalendarContext } from "./calendar.js";
import { chatWithRadio } from "./chat.js";
import { config } from "./config.js";
import { appendDjSample } from "./dj-samples.js";
import { generateDjLine, generateProgramLine } from "./dj.js";
import {
  countTracks,
  getActiveDailyPlan,
  getRecommendationAudits,
  getTodayPicks,
  getTrack,
  getTracks,
  recordPlay,
  recordTaste,
  removeTaste
} from "./db.js";
import { hasLlm } from "./llm.js";
import {
  getKuGouUserPlaylists,
  getKuGouLoginStatus,
  logoutKuGou,
  healthCheckKuGouApi,
  loginKuGouCellphone,
  searchKuGouSong,
  sendKuGouCaptcha
} from "./kugou.js";
import { scanLibrary } from "./library.js";
import { getNowPlayingSnapshot, subscribeNowPlaying, updateNowPlayingSnapshot } from "./now.js";
import {
  importAgentPlaylist,
  importLatestInboxPlaylist,
  importPendingInboxPlaylist,
  inspectPlaylistLink,
  suggestPlaylist
} from "./playlist.js";
import { nextRadioPick, nextRadioQueue, planToday } from "./radio.js";
import { clearPlaybackSourceCache, resolvePlaybackSource, warmPlaybackSourceCache } from "./playback-source.js";
import { getKuGouLibraryStatus, syncKuGouLibrary } from "./kugou-library.js";
import { toLibraryResponse } from "./track-dto.js";
import { getTtsFilePath, synthesizeTts } from "./tts.js";
import { getUserProfileDocs, updateTasteProfile } from "./userProfile.js";
import { getWeatherContext, sanitizeWeatherForDj, updateBrowserWeatherLocation } from "./weather.js";
import type { TasteAction } from "./types.js";

const app = express();

app.use(express.json({ limit: "64kb" }));

const authAttempts = new Map<string, { count: number; resetAt: number }>();

function limitSensitiveAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
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

app.get("/api/health", async (_req, res) => {
  const activePlan = getActiveDailyPlan();
  const kugou = await healthCheckKuGouApi();
  res.json({
    ok: true,
    libraryDir: config.libraryDir,
    tracks: countTracks(),
    ai: hasLlm(),
    aiProvider: config.aiProvider,
    aiModel: config.aiModel,
    djAiModel: config.djAiModel || config.aiModel,
    djAiTimeoutMs: config.djAiTimeoutMs,
    djAiReasoningEffort: config.djAiReasoningEffort,
    kugou,
    activeDailyPlan: activePlan
      ? {
          dateKey: activePlan.dateKey,
          activatedAt: activePlan.activatedAt,
          currentBlockKey: activePlan.currentBlockKey
        }
      : null
  });
});

app.get("/api/now", (_req, res) => {
  res.json(getNowPlayingSnapshot());
});

app.get("/api/now/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const unsubscribe = subscribeNowPlaying((snapshot) => {
    res.write(`event: now\n`);
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.put("/api/now", (req, res) => {
  res.json(updateNowPlayingSnapshot(req.body));
});

app.get("/api/weather", async (_req, res) => {
  const weather = await getWeatherContext();
  res.json({ weather: sanitizeWeatherForDj(weather) });
});

app.put("/api/weather/location", async (req, res) => {
  try {
    updateBrowserWeatherLocation(req.body?.lat, req.body?.lng);
    const weather = await getWeatherContext();
    res.json({ ok: true, weather: sanitizeWeatherForDj(weather) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "weather location failed" });
  }
});

app.get("/api/calendar/context", (_req, res) => {
  res.json({ calendar: getCalendarContext() });
});

app.get("/api/kugou/health", async (_req, res) => {
  res.json(await healthCheckKuGouApi());
});

app.get("/api/kugou/login/status", (_req, res) => {
  res.json(getKuGouLoginStatus());
});

app.post("/api/kugou/logout", (_req, res) => {
  logoutKuGou();
  res.json(getKuGouLoginStatus());
});

app.post("/api/kugou/captcha/send", limitSensitiveAuth, async (req, res) => {
  try {
    res.json({ ok: true, result: await sendKuGouCaptcha(String(req.body?.mobile ?? "")) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "KuGou captcha failed" });
  }
});

app.post("/api/kugou/login/cellphone", limitSensitiveAuth, async (req, res) => {
  try {
    res.json(await loginKuGouCellphone(
      String(req.body?.mobile ?? ""),
      String(req.body?.code ?? ""),
      typeof req.body?.userid === "string" ? req.body.userid : undefined
    ));
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "KuGou login failed" });
  }
});

app.get("/api/kugou/search", async (req, res) => {
  try {
    const keyword = String(req.query.q ?? req.query.keyword ?? "");
    if (!keyword.trim()) {
      res.status(400).json({ error: "keyword is required" });
      return;
    }
    res.json({ songs: await searchKuGouSong(keyword, Number(req.query.limit ?? 10)) });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "KuGou search failed" });
  }
});

app.get("/api/kugou/playlists", async (_req, res) => {
  try {
    res.json({ playlists: await getKuGouUserPlaylists() });
  } catch (error) {
    const needsLogin = Boolean((error as Error & { needsLogin?: boolean })?.needsLogin);
    res.status(needsLogin ? 401 : 502).json({
      error: error instanceof Error ? error.message : "KuGou playlists failed",
      needsLogin
    });
  }
});

app.get("/api/kugou/library/status", (_req, res) => {
  res.json(getKuGouLibraryStatus());
});

app.post("/api/kugou/library/sync", async (_req, res) => {
  try {
    const result = await syncKuGouLibrary();
    res.json(result);
    void warmPlaybackSourceCache(240);
  } catch (error) {
    const needsLogin = Boolean((error as Error & { needsLogin?: boolean })?.needsLogin);
    res.status(needsLogin ? 401 : 502).json({
      error: error instanceof Error ? error.message : "KuGou library sync failed",
      needsLogin
    });
  }
});

app.get("/api/taste-profile", async (_req, res) => {
  res.json(await getUserProfileDocs());
});

app.post("/api/taste-profile/train", async (req, res) => {
  try {
    res.json(await updateTasteProfile(String(req.body?.message ?? "")));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "taste training failed" });
  }
});

app.post("/api/library/scan", async (_req, res) => {
  try {
    const tracks = await scanLibrary();
    res.json({ ok: true, count: tracks.length });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "scan failed" });
  }
});

app.get("/api/library", (req, res) => {
  const query = String(req.query.q ?? "");
  const limit = Number(req.query.limit ?? 500);
  res.json(toLibraryResponse(getTracks(limit, query, { searchFilePath: false }), countTracks()));
});

app.get("/api/track/:id/playback-source", async (req, res) => {
  try {
    const playback = await resolvePlaybackSource(req.params.id);
    res.json({
      ...playback,
      streamUrl: `/api/track/${req.params.id}/stream`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "playback source failed";
    res.status(message === "track not found" ? 404 : 502).json({ error: message });
  }
});

app.get("/api/track/:id/stream", async (req, res) => {
  const track = getTrack(req.params.id);
  if (!track) {
    res.status(404).json({ error: "track not found" });
    return;
  }

  try {
    const playback = await resolvePlaybackSource(track.id);
    if (playback.mode === "api") {
      try {
        const remote = await fetch(playback.streamUrl, {
          headers: req.headers.range ? { Range: req.headers.range } : {}
        });
        if (!remote.ok || !remote.body) {
          throw new Error(`remote audio returned ${remote.status}`);
        }

        for (const header of ["accept-ranges", "content-length", "content-range"]) {
          const value = remote.headers.get(header);
          if (value) res.setHeader(header, value);
        }
        const remoteContentType = remote.headers.get("content-type");
        res.setHeader("content-type", remoteContentType?.startsWith("audio/") ? remoteContentType : "audio/mpeg");
        res.status(remote.status);
        Readable.fromWeb(remote.body as never).pipe(res);
        return;
      } catch {
        clearPlaybackSourceCache(track.id);
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
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes"
    });
    fs.createReadStream(track.filePath).pipe(res);
    return;
  }

  const [startText, endText] = range.replace(/bytes=/, "").split("-");
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

app.post("/api/radio/next", async (req, res) => {
  try {
    const weather = req.body?.withWeather ? await getWeatherContext() : undefined;
    const pick = await nextRadioPick(String(req.body?.query ?? ""), weather, { useAi: req.body?.useAi === true });
    recordPlay(pick.songId, pick);
    res.json({ ...pick, weather });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "radio pick failed" });
  }
});

app.post("/api/dj/line", async (req, res) => {
  try {
    const result = await generateDjLine({
      songId: String(req.body?.songId ?? ""),
      query: String(req.body?.query ?? ""),
      reason: String(req.body?.reason ?? ""),
      moodTags: Array.isArray(req.body?.moodTags) ? req.body.moodTags.map((item: unknown) => String(item)) : [],
      previousLine: String(req.body?.previousLine ?? "")
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "dj line failed" });
  }
});

app.post("/api/dj/program-line", async (req, res) => {
  try {
    const type = String(req.body?.type ?? "opening");
    if (type !== "opening" && type !== "interlude" && type !== "closing") {
      res.status(400).json({ error: "invalid program line type" });
      return;
    }

    const result = await generateProgramLine({
      type,
      scene: String(req.body?.scene ?? ""),
      recentTracks: Array.isArray(req.body?.recentTracks) ? req.body.recentTracks : []
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "program line failed" });
  }
});

app.post("/api/dj/sample-feedback", (req, res) => {
  try {
    const kind = String(req.body?.kind ?? "");
    if (kind !== "approved" && kind !== "rejected") {
      res.status(400).json({ ok: false, error: "invalid DJ sample feedback kind" });
      return;
    }

    const sample = appendDjSample(kind, {
      text: String(req.body?.text ?? ""),
      songId: typeof req.body?.songId === "string" ? req.body.songId : undefined,
      reason: typeof req.body?.reason === "string" ? req.body.reason : undefined
    });
    res.json({ ok: true, sample });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "DJ sample feedback failed" });
  }
});

app.post("/api/tts/synthesize", async (req, res) => {
  const result = await synthesizeTts(String(req.body?.text ?? ""), "dj", { refresh: req.body?.refresh === true });
  res.json(result);
});

app.get(/^\/api\/tts\/([a-f0-9]{64}\.(?:mp3|wav|ogg))$/i, (req, res) => {
  try {
    const fileName = req.params[0];
    const filePath = getTtsFilePath(fileName);
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

    res.writeHead(200, {
      "Accept-Ranges": "bytes",
      "Content-Length": stat.size,
      "Content-Type": contentType
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "invalid tts file" });
  }
});

app.post("/api/radio/queue", async (req, res) => {
  try {
    const weather = req.body?.withWeather ? await getWeatherContext() : undefined;
    const picks = await nextRadioQueue(String(req.body?.query ?? ""), weather, Number(req.body?.count ?? 4), {
      useAi: req.body?.useAi === true
    });
    res.json({
      picks: picks.map((pick) => ({ ...pick, weather })),
      decisions: picks.map((pick) => pick.decision).filter(Boolean)
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "radio queue failed" });
  }
});

app.post("/api/playlist/suggest", async (req, res) => {
  try {
    const result = await suggestPlaylist(String(req.body?.scene ?? ""), {
      count: Number(req.body?.count ?? 10)
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "playlist suggestion failed" });
  }
});

app.post("/api/playlist/import", (req, res) => {
  try {
    res.json(importAgentPlaylist(req.body?.playlist ?? req.body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "playlist import failed" });
  }
});

app.post("/api/playlist/inbox/latest", (_req, res) => {
  try {
    res.json(importLatestInboxPlaylist());
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : "playlist inbox is empty" });
  }
});

app.get("/api/playlist/inbox/pending", (_req, res) => {
  try {
    res.json({ playlist: importPendingInboxPlaylist() });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "pending playlist import failed" });
  }
});

app.post("/api/playlist/link/inspect", (req, res) => {
  res.json(inspectPlaylistLink(req.body?.url ?? req.body?.link ?? req.body));
});

app.post("/api/radio/plan-today", async (req, res) => {
  try {
    const weather = await getWeatherContext();
    const result = await planToday(String(req.body?.message ?? "帮我规划今天的歌单"), weather);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "daily plan failed" });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const reply = await chatWithRadio(String(req.body?.message ?? ""));
    if (reply.pick) recordPlay(reply.pick.songId, reply.pick);
    res.json(reply);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "chat failed" });
  }
});

app.get("/api/radio/today", (_req, res) => {
  res.json({ picks: getTodayPicks() });
});

app.get("/api/radio/audits", (req, res) => {
  res.json({ audits: getRecommendationAudits(Number(req.query.limit ?? 20)) });
});

const allowedTasteActions = new Set<TasteAction>([
  "like",
  "skip",
  "commute",
  "morning",
  "work",
  "sleep",
  "focus",
  "nostalgia",
  "other"
]);

app.post("/api/taste", (req, res) => {
  const trackId = String(req.body?.trackId ?? "");
  const action = String(req.body?.action ?? "") as TasteAction;

  if (!trackId || !allowedTasteActions.has(action)) {
    res.status(400).json({ ok: false, error: "invalid taste payload" });
    return;
  }

  recordTaste(trackId, action);
  res.json({ ok: true });
});

app.delete("/api/taste", (req, res) => {
  const trackId = String(req.body?.trackId ?? "");
  const action = String(req.body?.action ?? "") as TasteAction;

  if (!trackId || !allowedTasteActions.has(action)) {
    res.status(400).json({ ok: false, error: "invalid taste payload" });
    return;
  }

  removeTaste(trackId, action);
  res.json({ ok: true });
});

if (fs.existsSync(path.join(process.cwd(), "dist"))) {
  app.use(express.static(path.join(process.cwd(), "dist")));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(process.cwd(), "dist", "index.html"));
  });
}

app.listen(config.port, config.host, async () => {
  console.log(`AI radio server listening on http://${config.host}:${config.port}`);
  if (countTracks() === 0) {
    try {
      const tracks = await scanLibrary();
      console.log(`Scanned ${tracks.length} tracks from ${config.libraryDir}`);
    } catch (error) {
      console.warn(`Initial library scan skipped: ${error instanceof Error ? error.message : error}`);
    }
  }
});

function contentTypeFor(extension: string) {
  switch (extension) {
    case "mp3":
      return "audio/mpeg";
    case "flac":
      return "audio/flac";
    case "m4a":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}
