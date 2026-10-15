type SmokeCheck = {
  name: string;
  run: () => Promise<void> | void;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function includesIgnoreCase(value: string, expected: string) {
  return value.toLowerCase().includes(expected.toLowerCase());
}

process.env.AI_API_KEY = "";
process.env.DEEPSEEK_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.DJ_AI_MODEL = "deepseek-v4-flash";
process.env.DJ_AI_TEMPERATURE = "0.85";
process.env.DJ_AI_TIMEOUT_MS = "12000";
process.env.DJ_AI_REASONING_EFFORT = "low";

const { resolveDirectTrack } = await import("../direct.js");
const { toKuGouApiTrack } = await import("../kugou-catalog.js");
const { resolvePlaybackSource } = await import("../playback-source.js");
const { chatWithRadio, classifyEmotionalSignal, emotionalConversationGuidance } = await import("../chat.js");
const { calculateRecencyBreakdown, getRadioDecision, nextSceneTags, timeSceneTags } = await import("../radio.js");
const {
  importAgentPlaylist,
  importLatestInboxPlaylist,
  importPendingInboxPlaylist,
  inspectPlaylistLink,
  latestPlaylistInboxPath,
  pendingPlaylistInboxPath,
  suggestPlaylist
} = await import("../playlist.js");
const { generateDjLine, generateProgramLine, invalidDjLineReason, invalidProgramLineReason } = await import("../dj.js");
const { invalidContextDjLineReason } = await import("../dj-validator.js");
const { buildModelFirstDjLineInstruction } = await import("../dj-model-first.js");
const { config } = await import("../config.js");
const { synthesizeTts } = await import("../tts.js");
const { appendDjSample, djSamplesPath, formatDjSamplesForContext, readDjSamples } = await import("../dj-samples.js");
const { buildDjVoiceMemory } = await import("../dj-voice-memory.js");
const { buildContext } = await import("../context.js");
const { getNowPlayingSnapshot, subscribeNowPlaying, updateNowPlayingSnapshot } = await import("../now.js");
const { sanitizeWeatherForDj, updateBrowserWeatherLocation } = await import("../weather.js");
const { getCalendarContext } = await import("../calendar.js");
const { getKuGouLoginStatus, playbackSourceRequests, scoreKuGouSongMatch, toClaudioPlaylist } = await import("../kugou.js");
const { db, getRecentGeneratedPlaylistTracks, getTasteScores, recordGeneratedPlaylistTracks, recordTaste } = await import("../db.js");
const fs = await import("node:fs");
const path = await import("node:path");
const playbackSourceCachePath = path.join(config.dataDir, "playback-source-cache-v2.json");
const previousPlaybackSourceCache = fs.existsSync(playbackSourceCachePath) ? fs.readFileSync(playbackSourceCachePath) : null;

let directSongId = "";
const persistentSmokeTrackIds: string[] = [];
const persistentSmokeFiles: string[] = [];

function createSmokeTrack(options: {
  title?: string;
  artist?: string;
  album?: string;
  extension?: string;
  source?: "main" | "kugou-cache" | "kugou-api";
  playable?: boolean;
  filePath?: string;
} = {}) {
  const id = `smoke-taste-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO tracks (
      id, title, artist, album, file_path, folder, extension, source, playable, size, added_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    options.title ?? "Smoke Taste Track",
    options.artist ?? "Smoke Artist",
    options.album ?? "Smoke Album",
    options.filePath ?? `smoke://${id}.${options.extension ?? "mp3"}`,
    "smoke",
    options.extension ?? "mp3",
    options.source ?? "main",
    options.playable === false ? 0 : 1,
    1,
    new Date().toISOString()
  );
  return id;
}

function createPersistentSmokeTrack(options: Parameters<typeof createSmokeTrack>[0]) {
  const id = createSmokeTrack(options);
  persistentSmokeTrackIds.push(id);
  return id;
}

function removeSmokeTrack(id: string) {
  db.prepare("DELETE FROM plays WHERE track_id = ?").run(id);
  db.prepare("DELETE FROM tastes WHERE track_id = ?").run(id);
  db.prepare("DELETE FROM radio_picks WHERE track_id = ?").run(id);
  db.prepare("DELETE FROM kugou_playlist_tracks WHERE track_id = ?").run(id);
  db.prepare("DELETE FROM generated_playlist_tracks WHERE track_id = ?").run(id);
  db.prepare("DELETE FROM tracks WHERE id = ?").run(id);
}

const playlistSmokeTrackIds = Array.from({ length: 12 }, (_, index) =>
  createPersistentSmokeTrack({
    title: `Smoke Playlist Track ${index + 1}`,
    artist: `Smoke Playlist Artist ${index + 1}`,
    album: index % 2 === 0 ? "Piano Smoke" : "OST Smoke",
    filePath: `kugou://smoke-playlist-${index + 1}`,
    source: "kugou-api"
  })
);

function writePlaybackSourceCache(trackIds: string[]) {
  fs.writeFileSync(
    playbackSourceCachePath,
    JSON.stringify(
      Object.fromEntries(
        trackIds.map((trackId) => [
          trackId,
          {
            expiresAt: Date.now() + 60_000,
            source: {
              mode: "api",
              streamUrl: "https://smoke.invalid/audio.mp3",
              source: "kugou-api",
              reason: "smoke API playback source"
            }
          }
        ])
      )
    )
  );
}

const checks: SmokeCheck[] = [
  {
    name: "kugou: metadata converts to Claudio playlist schema without playback URLs",
    run: () => {
      const playlist = toClaudioPlaylist("KuGou smoke", [
        { title: "Smoke Song", artist: "Smoke Singer", hash: "abc" },
        { title: "Instrumental Smoke", artist: "Smoke Band" }
      ]);
      assert(playlist.schema === "claudio.playlist.v1", "expected Claudio playlist schema");
      assert(playlist.scene === "kugou-favorites", "expected KuGou scene marker");
      assert(playlist.tracks.length === 2, "expected converted tracks");
      assert(playlist.tracks[0]?.title === "Smoke Song", "expected title mapping");
      assert(playlist.tracks[0]?.artist === "Smoke Singer", "expected artist mapping");
      assert(!JSON.stringify(playlist).includes("abc"), "expected playback/hash metadata to stay out of playlist import");
    }
  },
  {
    name: "kugou: login status reports explicit needsLogin when no session exists",
    run: () => {
      const status = getKuGouLoginStatus();
      assert(typeof status.loggedIn === "boolean", "expected boolean login status");
      if (!status.loggedIn) {
        assert(status.needsLogin === true, "expected unauthenticated status to request login");
        assert(typeof status.reason === "string", "expected unauthenticated status reason");
      }
    }
  },
  {
    name: "kugou: playback matching rejects a wrong artist or loose title",
    run: () => {
      const track = { title: "遇见", artist: "孙燕姿" };
      const exact = scoreKuGouSongMatch(track, { title: "遇见", artist: "孙燕姿" });
      const wrongArtist = scoreKuGouSongMatch(track, { title: "遇见", artist: "其他歌手" });
      const looseTitle = scoreKuGouSongMatch(track, { title: "遇见你", artist: "其他歌手" });
      assert(exact === 100, `expected exact match score 100, got ${exact}`);
      assert(wrongArtist === 70, `expected title-only score 70, got ${wrongArtist}`);
      assert(looseTitle === 40, `expected loose-title score 40, got ${looseTitle}`);
      assert(wrongArtist < 85 && looseTitle < 85, "expected non-exact artist matches to stay below playback threshold");
    }
  },
  {
    name: "context: model-first DJ uses the locked song and keeps environment nonliteral",
    run: async () => {
      const track = {
        id: "model-first-smoke",
        title: "Model First Song",
        artist: "Model First Artist",
        album: "Model First Album",
        filePath: "kugou://model-first",
        folder: "smoke",
        extension: "remote",
        source: "kugou-api",
        playable: true,
        size: 0,
        addedAt: new Date().toISOString()
      } as const;
      const context = await buildContext({
        mode: "dj-line",
        userMessage: "model-first smoke",
        currentTrack: track,
        candidates: [track],
        includeRecentChat: false,
        includeLongTermMemory: false,
        includeInterviewTail: false,
        includeTasteSignals: false,
        djContentMode: "model-first"
      } as never);

      assert(context.userInputContext.includes("Current Song"), "expected a current-song window for model-first DJ");
      assert(context.userInputContext.includes("Model First Artist - Model First Song"), "expected locked song identity in model-first context");
      assert(!context.userInputContext.includes("Source-aware evidence pack"), "expected model-first DJ to omit the default evidence pack");
      assert(context.environmentContext.includes("rhythm and pacing"), "expected environment to guide pacing without becoming a literal scene");
    }
  },
  {
    name: "context: minimal model-first DJ sends only the locked song to the user message",
    run: async () => {
      const context = await buildContext({
        mode: "dj-line",
        djContentMode: "model-first",
        minimalDjContext: true,
        userMessage: "minimal model-first smoke",
        currentTrack: {
          id: "minimal-smoke",
          title: "Minimal Song",
          artist: "Minimal Artist",
          album: "Minimal Album",
          filePath: "kugou://minimal",
          folder: "smoke",
          extension: "remote",
          source: "kugou-api",
          playable: true,
          size: 0,
          addedAt: new Date().toISOString()
        },
        candidates: [],
        queue: []
      } as never);
      const userMessage = context.messages.find((message) => message.role === "user");
      assert(userMessage, "expected a minimal user message");
      assert(userMessage.content.includes("## Current Song"), "expected current song input in minimal mode");
      assert(!userMessage.content.includes("## User Corpus"), "expected selection preferences outside minimal DJ context");
      assert(!userMessage.content.includes("## Environment"), "expected environment outside minimal DJ context");
      assert(!userMessage.content.includes("## Memory"), "expected memory outside minimal DJ context");
      assert(!userMessage.content.includes("## Execution"), "expected execution state outside minimal DJ context");
    }
  },
  {
    name: "context: DJ runtime includes positive few-shot examples except the current song",
    run: async () => {
      const context = await buildContext({
        mode: "dj-line",
        djContentMode: "model-first",
        minimalDjContext: true,
        userMessage: "few-shot isolation smoke",
        currentTrack: {
          id: "encounter-smoke",
          title: "遇见",
          artist: "孙燕姿",
          album: "The Moment",
          filePath: "kugou://encounter-smoke",
          folder: "smoke",
          extension: "remote",
          source: "kugou-api",
          playable: true,
          size: 0,
          addedAt: new Date().toISOString()
        },
        candidates: []
      });
      assert(context.systemPrompt.includes("参考范式："), "expected few-shot originals in the runtime prompt");
      assert(context.systemPrompt.includes("Kiss The Rain"), "expected previously unselected few-shots in the runtime prompt");
      assert(!context.systemPrompt.includes("2003年《遇见》刚发行的时候"), "expected the current song few-shot outside the runtime prompt");
      assert(!context.systemPrompt.includes("一个声音在用力往上走"), "expected rejected examples outside the runtime prompt");
      assert(context.messages.length === 2, "expected one system message and one assembled user message");
      const userMessage = context.messages.find((message) => message.role === "user");
      assert(userMessage, "expected an assembled user message");
      assert(!userMessage.content.includes("## System Prompt"), "expected system guidance to stay out of the user context");
      assert(!userMessage.content.includes("# Claudio DJ Few-Shot"), "expected few-shots to appear once in the system message only");
      assert(context.systemPrompt.includes("专业、资深的私人电台主持人"), "expected the approved host prompt");
      assert(!context.systemPrompt.includes("Song Evidence"), "expected model-first persona to avoid evidence-only writing instructions");
      assert(!context.systemPrompt.includes("10-12 句"), "expected no legacy sentence-count formula in the persona");
      assert(!fs.existsSync(path.resolve(process.cwd(), "prompts", "dj-style-reference.md")), "expected style reference to be consolidated into the persona");
    }
  },
  {
    name: "context: runtime user corpus excludes archival taste interviews",
    run: async () => {
      const context = await buildContext({
        mode: "dj-line",
        userMessage: "profile archive isolation smoke",
        includeRecentChat: false,
        includeLongTermMemory: false
      });

      assert(!context.userCorpus.includes("口味访谈摘要"), "expected archival taste interviews outside the runtime user corpus");
      assert(context.userCorpus.includes("taste.md"), "expected taste profile in the runtime user corpus");
      assert(context.userCorpus.includes("routines.md"), "expected routines in the runtime user corpus");
      assert(context.userCorpus.includes("mood-rules.md"), "expected mood rules in the runtime user corpus");
    }
  },
  {
    name: "calendar: local context exposes pacing without private schedule details",
    run: () => {
      const workCalendar = getCalendarContext(new Date(2026, 5, 3, 10, 20));
      assert(workCalendar.block === "work", `expected work block, got ${workCalendar.block}`);
      assert(workCalendar.interruptionLevel === "quiet", `expected quiet mode, got ${workCalendar.interruptionLevel}`);
      const serialized = JSON.stringify(workCalendar);
      assert(!/meeting|class|location|attendee|会议|课程|地点|联系人/.test(serialized), "expected no private schedule details");
    }
  },
  {
    name: "context: calendar supplies sanitized pacing to dj-line",
    run: async () => {
      const context = await buildContext({
        mode: "dj-line",
        userMessage: "calendar context smoke",
        calendar: getCalendarContext(new Date(2026, 5, 3, 15, 0)),
        includeRecentChat: false,
        includeLongTermMemory: false,
        includeInterviewTail: false
      });

      assert(context.environmentContext.includes("Calendar:"), "expected calendar pacing in environment");
      assert(context.executionContext.includes("Scheduler:"), "expected scheduler pacing in execution");
      assert(!/项目会|课程表|教室|会议室|联系人|attendee:|meeting:|class:/.test(context.assembledPrompt), "expected prompt to omit private schedule details");
    }
  },
  {
    name: "weather: browser coordinates update runtime source without exposing location to DJ",
    run: () => {
      const location = updateBrowserWeatherLocation(30.259, 120.13);
      assert(location.source === "browser", `expected browser source, got ${location.source}`);
      assert(location.city === "当前位置", "expected private runtime city label");

      const sanitized = sanitizeWeatherForDj({
        city: "杭州西湖区",
        summary: "小雨",
        temperature: 18.4,
        windSpeed: 6.2,
        observedAt: "2026-06-03T09:30",
        source: "browser",
        available: true
      });

      assert(sanitized.available, "expected sanitized weather to be available");
      assert(!("city" in sanitized), "expected sanitized weather to omit city");
      assert(!("lat" in sanitized), "expected sanitized weather to omit latitude");
      assert(!("lng" in sanitized), "expected sanitized weather to omit longitude");
    }
  },
  {
    name: "context: weather enters dj-line as sanitized atmosphere",
    run: async () => {
      const context = await buildContext({
        mode: "dj-line",
        userMessage: "weather context smoke",
        sanitizedWeather: {
          available: true,
          summary: "小雨",
          temperature: 18.4,
          windSpeed: 6.2,
          observedAt: "2026-06-03T09:30",
          source: "browser"
        },
        includeRecentChat: false,
        includeLongTermMemory: false,
        includeInterviewTail: false
      });

      assert(context.environmentContext.includes("小雨"), "expected sanitized weather summary");
      assert(!context.environmentContext.includes("杭州"), "expected environment to omit city names");
      assert(!context.environmentContext.includes("120.13"), "expected environment to omit coordinates");
    }
  },
  {
    name: "now: read-only output contract accepts current web snapshot",
    run: () => {
      const before = getNowPlayingSnapshot();
      assert(before.source === "web", `expected web source, got ${before.source}`);
      assert(before.queue.length >= 0, "expected queue length to be normalized");

      const updated = updateNowPlayingSnapshot({
        playback: {
          isPlaying: true,
          currentTime: 12.5,
          duration: 180,
          volume: 0.8
        },
        currentTrack: {
          id: "now-smoke-track",
          title: "Now Smoke",
          artist: "Smoke Artist",
          album: "Smoke Album",
          extension: "mp3",
          source: "main",
          playable: true
        },
        currentPick: {
          songId: "now-smoke-track",
          djLine: "Smoke line",
          reason: "Smoke now contract",
          moodTags: ["smoke"],
          source: "rules"
        },
        dj: {
          songId: "now-smoke-track",
          say: "Smoke line",
          voiceUrl: "/api/tts/smoke.mp3",
          source: "rules",
          status: "voice_ready"
        },
        queue: {
          activePlaylistId: "now-smoke-playlist",
          activePlaylistTitle: "Now Smoke Playlist",
          length: 3,
          nextSongId: "now-smoke-next"
        }
      });

      assert(updated.currentTrack?.id === "now-smoke-track", "expected current track in now snapshot");
      assert(updated.currentPick?.songId === "now-smoke-track", "expected current pick in now snapshot");
      assert(updated.dj?.status === "voice_ready", "expected DJ voice status in now snapshot");
      assert(updated.queue.nextSongId === "now-smoke-next", "expected queue next song in now snapshot");
      assert(getNowPlayingSnapshot().currentTrack?.id === "now-smoke-track", "expected GET snapshot to return last PUT");
    }
  },
  {
    name: "now: stream publisher emits snapshot updates",
    run: () => {
      const seen: string[] = [];
      const unsubscribe = subscribeNowPlaying((snapshot) => {
        seen.push(snapshot.currentTrack?.id ?? "empty");
      });

      updateNowPlayingSnapshot({
        playback: {
          isPlaying: false,
          currentTime: 0,
          duration: 200,
          volume: 0.5
        },
        currentTrack: {
          id: "now-stream-smoke-track",
          title: "Now Stream Smoke",
          artist: "Smoke Artist",
          album: "Smoke Album",
          extension: "mp3",
          source: "main",
          playable: true
        },
        currentPick: null,
        dj: null,
        queue: {
          activePlaylistId: null,
          activePlaylistTitle: null,
          length: 0,
          nextSongId: null
        }
      });
      unsubscribe();

      assert(seen.length >= 2, "expected stream publisher to emit initial and updated snapshots");
      assert(seen.includes("now-stream-smoke-track"), "expected stream publisher to emit updated track id");
    }
  },
  {
    name: "direct: 播放 July 的 My Soul resolves from KuGou API candidates",
    run: async () => {
      const directFilePath = path.join(config.dataDir, `smoke-direct-${Date.now()}.mp3`);
      fs.writeFileSync(directFilePath, Buffer.alloc(256));
      persistentSmokeFiles.push(directFilePath);
      directSongId = createPersistentSmokeTrack({
        title: "Smoke Direct My Soul (Variant)",
        artist: "July",
        album: "Smoke Direct Album",
        filePath: "kugou://smoke-direct-my-soul",
        source: "kugou-api"
      });
      writePlaybackSourceCache([directSongId, ...playlistSmokeTrackIds]);
      for (let index = 1; index <= 9; index += 1) {
        createPersistentSmokeTrack({
          title: `Smoke Playlist Track ${index}`,
          artist: `Smoke Playlist Artist ${index}`,
          album: index % 2 === 0 ? "Piano Smoke" : "OST Smoke"
        });
      }
      createPersistentSmokeTrack({
        title: "River Flows in You",
        artist: "Yiruma",
        album: "Smoke Cache",
        extension: "kgma",
        source: "kugou-cache",
        playable: false
      });
      createPersistentSmokeTrack({ title: "Sparkle", artist: "RADWIMPS", album: "Smoke Alias" });
      createPersistentSmokeTrack({ title: "You", artist: "M.Graveyard", album: "Smoke False Match" });
      const result = await resolveDirectTrack("播放 July 的 My Soul", {
        search: async () => [toKuGouApiTrack({ title: "My Soul", artist: "July", hash: "smoke-api-my-soul" })]
      });
      assert(result.reason === "matched", `expected matched, got ${result.reason}`);
      assert(result.match, "expected a direct match");
      assert(result.match.playable, "expected the direct match to be browser-playable");
      assert(includesIgnoreCase(result.match.title, "my soul"), `expected title to include My Soul, got ${result.match.title}`);
      assert(includesIgnoreCase(result.match.artist, "july"), `expected artist to include July, got ${result.match.artist}`);
      assert(result.match.source === "kugou-api", "expected the API result to be selected");
    }
  },
  {
    name: "playback: local file without an API source is not playable",
    run: async () => {
      const localOnlyFilePath = path.join(config.dataDir, `smoke-local-only-${Date.now()}.mp3`);
      fs.writeFileSync(localOnlyFilePath, Buffer.alloc(256));
      persistentSmokeFiles.push(localOnlyFilePath);
      const trackId = createPersistentSmokeTrack({
        title: `Smoke API Only ${Date.now()}`,
        artist: "Smoke API Only Artist",
        filePath: localOnlyFilePath
      });

      await resolvePlaybackSource(trackId)
        .then(() => {
          throw new Error("expected a local-only track to be rejected without an API source");
        })
        .catch((error) => {
          if (error instanceof Error && error.message.includes("expected a local-only")) throw error;
        });
    }
  },
  {
    name: "chat: daily playlist intent returns a bounded queue",
    run: async () => {
      const reply = await chatWithRadio("根据今天的情况生成今日歌单");
      assert(reply.playlist, "expected daily playlist result");
      assert(reply.playlist.picks.length >= 8 && reply.playlist.picks.length <= 12, "expected an 8-12 track daily queue");
    }
  },
  {
    name: "chat: BGM wording stays in conversation instead of starting playback",
    run: async () => {
      const reply = await chatWithRadio("帮我挑一首写作时的 BGM");
      assert(!reply.queuePick && !reply.pick && !reply.playlist, "expected BGM wording not to trigger music actions");
      assert(reply.reply.includes("不在这里"), "expected BGM wording to stay outside this chat entry");
    }
  },
  {
    name: "chat: ordinary conversation does not trigger playback",
    run: async () => {
      const reply = await chatWithRadio("你好 Claudio，今天过得怎么样");
      assert(Boolean(reply.reply), "expected a conversational reply");
      assert(!reply.pick && !reply.queuePick && !reply.playlist, "expected ordinary chat not to trigger music actions");
    }
  },
  {
    name: "chat: emotional signals distinguish a broad feeling from a concrete situation",
    run: () => {
      assert(classifyEmotionalSignal("我现在有点emo") === "low", "expected a broad feeling to use the low-signal mode");
      assert(
        classifyEmotionalSignal("我有点舍不得一段关系，但又觉得继续下去很累") === "specific",
        "expected a concrete relationship situation to use the specific mode"
      );
    }
  },
  {
    name: "chat: emotional guidance anchors to facts without diagnosing or scripting the user",
    run: () => {
      const guidance = emotionalConversationGuidance("specific");
      assert(guidance.includes("已经说出的事实"), "expected emotional replies to stay grounded in the user's own facts");
      assert(guidance.includes("诊断"), "expected emotional replies not to diagnose the user");
      assert(guidance.includes("替用户下结论"), "expected emotional replies not to decide for the user");
    }
  },
  {
    name: "playback: uses the API's new URL endpoint after the standard endpoint",
    run: () => {
      assert(
        playbackSourceRequests({ hash: "smoke-hash" }).map((request) => request.pathname).join(",") === "/song/url,/song/url,/song/url/new",
        "expected the new KuGou URL endpoint to be the API-only fallback"
      );
    }
  },
  {
    name: "next: rules-only recommendation returns one fast pick",
    run: async () => {
      const startedAt = Date.now();
      const result = await getRadioDecision("", undefined, 1, { useAi: false });
      const elapsedMs = Date.now() - startedAt;
      const pick = result.picks[0];

      assert(pick, "expected one radio pick");
      assert(pick.source === "rules", `expected rules source, got ${pick.source}`);
      assert(Boolean(pick.songId), "expected a song id");
      assert(elapsedMs < 1500, `expected rules-only next under 1500ms, got ${elapsedMs}ms`);
    }
  },
  {
    name: "next: recent artist and near-duplicate tracks are cooled down",
    run: () => {
      const candidate = {
        id: "zhao-lei-1",
        title: "灏戝勾閿︽椂(1)",
        artist: "璧甸浄",
        album: "",
        filePath: "",
        folder: "",
        extension: "mp3",
        source: "main",
        playable: true,
        size: 1,
        addedAt: ""
      } as const;
      const recent = [
        { ...candidate, id: "zhao-lei-0", title: "灏戝勾閿︽椂" },
        { ...candidate, id: "zhao-lei-2", title: "鎴愰兘" },
        { ...candidate, id: "zhao-lei-3", title: "鍗楁柟濮戝" }
      ];
      const breakdown = calculateRecencyBreakdown(candidate, recent);

      assert(breakdown.track_repeat <= -70, `expected near duplicate track penalty, got ${breakdown.track_repeat}`);
      assert(breakdown.artist_repeat <= -50, `expected strong recent artist penalty, got ${breakdown.artist_repeat}`);
    }
  },
  {
    name: "next: repeated style family is cooled down",
    run: () => {
      const candidate = {
        id: "instrumental-new",
        title: "Quiet Room (纯音乐)",
        artist: "new artist",
        album: "",
        filePath: "",
        folder: "",
        extension: "mp3",
        source: "main",
        playable: true,
        size: 1,
        addedAt: ""
      } as const;
      const recent = [0, 1, 2, 3].map((index) => ({
        ...candidate,
        id: `instrumental-recent-${index}`,
        title: `Recent Ambient ${index} (纯音乐)`,
        artist: `artist ${index}`
      }));
      const breakdown = calculateRecencyBreakdown(candidate, recent);

      assert(breakdown.family_repeat <= -25, `expected strong repeated-family penalty, got ${breakdown.family_repeat}`);
    }
  },
  {
    name: "next: time scene applies only when query has no explicit scene",
    run: () => {
      assert(timeSceneTags(new Date("2026-05-20T06:30:00")).includes("morning"), "expected morning tag");
      assert(timeSceneTags(new Date("2026-05-20T09:00:00")).includes("commute"), "expected commute tag");
      assert(timeSceneTags(new Date("2026-05-20T15:00:00")).includes("afternoon"), "expected afternoon tag");
      assert(timeSceneTags(new Date("2026-05-20T20:30:00")).includes("night"), "expected early evening night tag");
      assert(!timeSceneTags(new Date("2026-05-20T20:30:00")).includes("sleep"), "expected early evening to avoid sleep tag");
      assert(timeSceneTags(new Date("2026-05-20T23:00:00")).includes("sleep"), "expected sleep tag");
      assert(nextSceneTags("", new Date("2026-05-20T23:00:00")).includes("sleep"), "expected empty query to use time scene");
      assert(nextSceneTags("工作时听", new Date("2026-05-20T23:00:00")).includes("focus"), "expected explicit query scene to win");
      assert(!nextSceneTags("工作时听", new Date("2026-05-20T23:00:00")).includes("sleep"), "expected explicit scene to avoid time scene");
    }
  },
  {
    name: "taste: repeated feedback changes bounded scores without runaway growth",
    run: () => {
      const smokeTrackId = createSmokeTrack();
      try {
        const baseline = getTasteScores().scores.get(smokeTrackId) ?? 0;

        for (let index = 0; index < 5; index += 1) {
          recordTaste(smokeTrackId, "like");
        }

        const liked = getTasteScores().scores.get(smokeTrackId) ?? 0;
        assert(liked > baseline, `expected likes to increase score from ${baseline}, got ${liked}`);
        assert(liked <= 12, `expected like score cap at 12, got ${liked}`);

        db.prepare("DELETE FROM tastes WHERE track_id = ? AND action = ?").run(smokeTrackId, "like");
        for (let index = 0; index < 5; index += 1) {
          recordTaste(smokeTrackId, "skip");
        }

        const skipped = getTasteScores().scores.get(smokeTrackId) ?? 0;
        assert(skipped < baseline, `expected skips to lower score from ${baseline}, got ${skipped}`);
        assert(skipped >= -12, `expected skip score floor at -12, got ${skipped}`);
      } finally {
        removeSmokeTrack(smokeTrackId);
      }
    }
  },
  {
    name: "taste: scene marks are scoped to the matching next scene",
    run: () => {
      const smokeTrackId = createSmokeTrack();
      try {
        for (let index = 0; index < 5; index += 1) {
          recordTaste(smokeTrackId, "focus");
        }

        const scores = getTasteScores();
        const focusScore = scores.sceneScores.get("focus")?.get(smokeTrackId) ?? 0;
        const sleepScore = scores.sceneScores.get("sleep")?.get(smokeTrackId) ?? 0;

        assert(focusScore > 0, `expected focus scene score, got ${focusScore}`);
        assert(focusScore <= 9, `expected focus scene cap at 9, got ${focusScore}`);
        assert(sleepScore === 0, `expected focus mark not to create sleep score, got ${sleepScore}`);
      } finally {
        removeSmokeTrack(smokeTrackId);
      }
    }
  },
  {
    name: "playlist: independent workflow returns a bounded temporary queue",
    run: async () => {
      const playlist = await suggestPlaylist("通勤轻节奏", { count: 10, useAi: false, recordHistory: false });
      const uniqueIds = new Set(playlist.picks.map((pick) => pick.songId));

      assert(playlist.picks.length >= 8, `expected at least 8 playlist picks, got ${playlist.picks.length}`);
      assert(playlist.picks.length <= 12, `expected at most 12 playlist picks, got ${playlist.picks.length}`);
      assert(uniqueIds.size === playlist.picks.length, "expected playlist picks to be unique");
      assert(
        playlist.picks.every((pick) => pick.moodTags.includes("playlist")),
        "expected playlist picks to carry playlist boundary tag"
      );
      assert(
        playlist.summary.includes("普通下一首") || playlist.summary.includes("队列"),
        "expected playlist summary to describe queue boundary"
      );
    }
  },
  {
    name: "playlist: agent JSON import matches local playable tracks",
    run: () => {
      assert(directSongId, "direct smoke did not provide a song id for playlist import");
      const imported = importAgentPlaylist({
        schema: "claudio.playlist.v1",
        title: "电脑前工作歌单",
        scene: "work",
        intent: "temporary_queue",
        program_note: "从熟悉旋律进入电脑前的工作状态。",
        tracks: [
          {
            position: 1,
            title: "Smoke Direct My Soul",
            artist: "July",
            family: "piano",
            energy: 3,
            vocal: false,
            reason: "熟悉但不喧闹，适合作为开场。"
          },
          {
            position: 2,
            title: "A Missing Smoke Track",
            artist: "Unknown",
            family: "other",
            energy: 2,
            vocal: false,
            reason: "用于验证缺失歌曲不会阻塞导入。"
          }
        ]
      });

      assert(imported.scene === "work", `expected work scene, got ${imported.scene}`);
      assert(imported.picks.length === 1, `expected one matched pick, got ${imported.picks.length}`);
      assert(imported.picks[0]?.songId === directSongId, "expected imported My Soul to match the direct smoke track");
      assert(imported.missingTracks?.length === 1, "expected one missing track to be reported");
    }
  },
  {
    name: "playlist: agent JSON import tolerates local title variants",
    run: () => {
      assert(directSongId, "direct smoke did not provide a song id for playlist import");
      const imported = importAgentPlaylist({
        schema: "claudio.playlist.v1",
        title: "标题变体测试",
        scene: "work",
        tracks: [
          {
            position: 1,
            title: "Smoke Direct My Soul",
            artist: "",
            family: "piano",
            energy: 3,
            vocal: false,
            reason: "验证本地标题带括号时仍能匹配。"
          }
        ]
      });

      assert(imported.picks.length === 1, `expected one variant match, got ${imported.picks.length}`);
      assert(imported.picks[0]?.songId === directSongId, "expected title-only variant import to match My Soul");
    }
  },
  {
    name: "playlist: inbox latest imports through the same local matcher",
    run: () => {
      assert(directSongId, "direct smoke did not provide a song id for playlist inbox");
      const previous = fs.existsSync(latestPlaylistInboxPath) ? fs.readFileSync(latestPlaylistInboxPath, "utf8") : null;

      try {
        fs.mkdirSync(path.dirname(latestPlaylistInboxPath), { recursive: true });
        fs.writeFileSync(
          latestPlaylistInboxPath,
          JSON.stringify({
            schema: "claudio.playlist.v1",
            title: "inbox smoke playlist",
            scene: "work",
            tracks: [{ position: 1, title: "Smoke Direct My Soul", artist: "July", reason: "verify inbox bridge" }]
          })
        );

        const imported = importLatestInboxPlaylist();
        assert(imported.picks.length === 1, `expected one inbox pick, got ${imported.picks.length}`);
        assert(imported.picks[0]?.songId === directSongId, "expected inbox My Soul to match the direct smoke track");
      } finally {
        if (previous === null) fs.rmSync(latestPlaylistInboxPath, { force: true });
        else fs.writeFileSync(latestPlaylistInboxPath, previous);
      }
    }
  },
  {
    name: "playlist: pending inbox previews through the same local matcher",
    run: () => {
      assert(directSongId, "direct smoke did not provide a song id for playlist pending inbox");
      const previous = fs.existsSync(pendingPlaylistInboxPath) ? fs.readFileSync(pendingPlaylistInboxPath, "utf8") : null;

      try {
        fs.mkdirSync(path.dirname(pendingPlaylistInboxPath), { recursive: true });
        fs.writeFileSync(
          pendingPlaylistInboxPath,
          JSON.stringify({
            schema: "claudio.playlist.v1",
            title: "pending inbox smoke playlist",
            scene: "work",
            tracks: [
              { position: 1, title: "Smoke Direct My Soul", artist: "July", reason: "verify pending inbox preview" },
              { position: 2, title: "A Missing Pending Track", artist: "Unknown", reason: "verify missing report" }
            ]
          })
        );

        const imported = importPendingInboxPlaylist();
        assert(imported, "expected pending inbox playlist");
        assert(imported.picks.length === 1, `expected one pending inbox pick, got ${imported.picks.length}`);
        assert(imported.picks[0]?.songId === directSongId, "expected pending My Soul to match the direct smoke track");
        assert(imported.missingTracks?.length === 1, "expected pending missing track to be reported");
      } finally {
        if (previous === null) fs.rmSync(pendingPlaylistInboxPath, { force: true });
        else fs.writeFileSync(pendingPlaylistInboxPath, previous);
      }
    }
  },
  {
    name: "playlist: agent JSON import avoids short-title false matches",
    run: () => {
      const imported = importAgentPlaylist({
        schema: "claudio.playlist.v1",
        title: "random import diagnostics",
        scene: "work",
        tracks: [
          { position: 1, title: "Fix You", artist: "Coldplay", reason: "should not match a generic You title" },
          { position: 2, title: "River Flows in You", artist: "Yiruma", reason: "often exists as Kugou cache only" },
          { position: 3, title: "Sparkle", artist: "RADWIMPS", reason: "should match local Japanese title alias" }
        ]
      });

      assert(
        imported.picks.some((pick) => pick.decision?.reason.includes("RADWIMPS")),
        "expected Sparkle to match the local RADWIMPS alias"
      );
      assert(
        !imported.picks.some((pick) => pick.decision?.reason.includes("M.Graveyard - You")),
        "expected Fix You not to false-match M.Graveyard - You"
      );

    }
  },
  {
    name: "playlist: external playlist link inspection is isolated from import",
    run: () => {
      const netease = inspectPlaylistLink("https://music.163.com/#/playlist?id=123456");
      assert(netease.status === "recognized", `expected recognized netease link, got ${netease.status}`);
      assert(netease.platform === "netease", `expected netease platform, got ${netease.platform}`);
      assert(netease.playlistId === "123456", `expected playlist id 123456, got ${netease.playlistId}`);

      const unsupported = inspectPlaylistLink("https://example.com/playlist/123456");
      assert(unsupported.status === "unsupported", `expected unsupported link, got ${unsupported.status}`);
      assert(unsupported.nextStep.length > 0, "expected cautious next step");
    }
  },
  {
    name: "dj: missing LLM provider produces no local narration",
    run: async () => {
      assert(directSongId, "direct smoke did not provide a song id for DJ failure contract");
      let rejected = false;
      try {
        await generateDjLine({
          songId: directSongId,
          reason: "smoke test missing LLM",
          previousLine: ""
        });
      } catch {
        rejected = true;
      }
      assert(rejected, "expected missing LLM to reject instead of generating local narration");
    }
  },
  {
    name: "playlist: generated queues enter the three-day cooldown",
    run: () => {
      const trackId = createSmokeTrack({ title: "Generated Queue Smoke", artist: "Cooldown Artist" });
      const expiredTrackId = createSmokeTrack({ title: "Expired Queue Smoke", artist: "Cooldown Artist" });
      const playlistId = `smoke-playlist-${Date.now()}`;
      try {
        db.prepare("INSERT INTO generated_playlist_tracks (playlist_id, track_id, generated_at) VALUES (?, ?, datetime('now', '-2 days'))").run(playlistId, trackId);
        db.prepare("INSERT INTO generated_playlist_tracks (playlist_id, track_id, generated_at) VALUES (?, ?, datetime('now', '-4 days'))").run(playlistId, expiredTrackId);
        const recent = getRecentGeneratedPlaylistTracks(10_000);
        assert(recent.some((track) => track.id === trackId), "expected two-day-old generated track in cooldown history");
        assert(!recent.some((track) => track.id === expiredTrackId), "expected four-day-old generated track outside cooldown history");
      } finally {
        db.prepare("DELETE FROM generated_playlist_tracks WHERE playlist_id = ?").run(playlistId);
        removeSmokeTrack(trackId);
        removeSmokeTrack(expiredTrackId);
      }
    }
  },
    {
      name: "dj: approved/rejected samples are optional context inputs",
      run: () => {
        const samples = readDjSamples();
        const formatted = formatDjSamplesForContext(samples);

        assert(Array.isArray(samples.approved), "expected approved sample list");
        assert(Array.isArray(samples.rejected), "expected rejected sample list");
        if (samples.approved.length === 0 && samples.rejected.length === 0) {
          assert(formatted.summary.includes("No DJ approved/rejected examples available."), "expected empty sample summary");
        } else {
          assert(formatted.summary.includes("APPROVED") || formatted.summary.includes("REJECTED"), "expected formatted sample summary");
        }
      }
    },
  {
    name: "dj: voice feedback remains a short direction instead of a rule list",
    run: async () => {
      const memory = buildDjVoiceMemory();
      assert(memory.includes("DJ Voice Preference Memory"), "expected DJ voice memory header");
      assert(memory.includes("Style direction:"), "expected concise style-direction summary");
      assert(memory.includes("Recent user signal:"), "expected recent user signal summary");
      assert(memory.includes("不喜欢的反馈权重大于喜欢的反馈"), "expected rejected feedback priority");
      assert(memory.includes("原始样本不会进入 prompt"), "expected raw examples to be omitted from memory");
      assert(
        memory.split("\n").filter((line) => line.startsWith("-")).length <= 5,
        "expected voice memory to avoid accumulating a long rule list"
      );
      assert(!memory.includes("APPROVED"), "expected memory to avoid raw approved labels");
      assert(!memory.includes("REJECTED"), "expected memory to avoid raw rejected labels");

      const context = await buildContext({
        mode: "dj-line",
        userMessage: "smoke dj memory placement",
        memoryNotes: [memory],
        toolResults: ["Selected track is locked: smoke-song"],
        systemState: ["play must contain exactly the current track id."],
        includeRecentChat: false,
        includeLongTermMemory: false,
        includeInterviewTail: false
      });

      assert(context.memoryContext.includes("DJ Voice Preference Memory"), "expected DJ voice memory in dj-line prompt");
      assert(!context.userInputContext.includes("APPROVED"), "expected raw approved samples outside tool results");
      assert(!context.userInputContext.includes("REJECTED"), "expected raw rejected samples outside tool results");
    }
  },
  {
    name: "dj: voice memory remains available without a runtime writing scaffold",
    run: async () => {
      const track = {
        id: "brief-smoke-track",
        title: "Neighbor's Garden",
        artist: "Smoke Artist",
        album: "Smoke Album",
        filePath: "smoke://brief.mp3",
        folder: "smoke",
        extension: "mp3",
        source: "main",
        playable: true,
        size: 1,
        addedAt: new Date().toISOString()
      } as const;
      const context = await buildContext({
        mode: "dj-line",
        userMessage: "brief placement smoke",
        currentTrack: track,
        candidates: [track],
        memoryNotes: [buildDjVoiceMemory()],
        systemState: ["play must contain exactly the current track id."],
        includeRecentChat: false,
        includeLongTermMemory: false,
        includeInterviewTail: false
      });

      assert(!/DJ Context Compiler Brief|computedWriteDecision|sceneCore|openingStrategy|angleStrategy|sentencePlan/.test(context.assembledPrompt), "expected no runtime writing scaffold");
      assert(context.memoryContext.includes("DJ Voice Preference Memory"), "expected voice memory in DJ context");
      assert(!context.userCorpus.includes("像一个认识我三年的朋友"), "expected rule-based user corpus without old voice prose");
      assert(!context.userCorpus.includes("话说一半留一半"), "expected rule-based user corpus without old style phrases");
    }
  },
  {
    name: "dj: sample feedback appends bounded style boundaries",
    run: () => {
      const previous = fs.existsSync(djSamplesPath) ? fs.readFileSync(djSamplesPath, "utf8") : null;
      const text = `Smoke DJ feedback sample ${Date.now()}`;

      try {
        appendDjSample("approved", { text, songId: "smoke-song", reason: "smoke approved" });
        let samples = readDjSamples(40);
        assert(samples.approved.some((sample) => sample.text === text), "expected approved feedback sample");

        appendDjSample("rejected", { text, songId: "smoke-song", reason: "smoke rejected" });
        samples = readDjSamples(40);
        assert(samples.rejected.some((sample) => sample.text === text), "expected rejected feedback sample");
        assert(!samples.approved.some((sample) => sample.text === text), "expected same text to move out of approved");

        for (let index = 0; index < 35; index += 1) {
          appendDjSample("rejected", { text: `${text} ${index}`, songId: "smoke-song" });
        }
        samples = readDjSamples(40);
        assert(samples.rejected.length <= 30, `expected rejected samples capped at 30, got ${samples.rejected.length}`);
      } finally {
        if (previous === null) fs.rmSync(djSamplesPath, { force: true });
        else fs.writeFileSync(djSamplesPath, previous);
      }
    }
  },
  {
    name: "tts: missing Fish key falls back to browser voice contract",
    run: async () => {
      const previousKey = config.fishTtsKey;
      config.fishTtsKey = "";
      try {
        const result = await synthesizeTts("今晚先让音乐把注意力轻轻收回来。", "dj");
        assert(result.ok === false, "expected TTS to fall back without a Fish key");
        assert(result.fallback === "browser", `expected browser fallback, got ${result.fallback}`);
        assert(result.error.length > 0, "expected fallback reason");
      } finally {
        config.fishTtsKey = previousKey;
      }
    }
  },
  {
    name: "tts: refresh option bypasses cache contract without changing fallback safety",
    run: async () => {
      const previousKey = config.fishTtsKey;
      config.fishTtsKey = "";
      try {
        const result = await synthesizeTts("今晚先让音乐把注意力轻轻收回来。", "dj", { refresh: true });
        assert(result.ok === false, "expected refresh TTS without key to fall back");
        assert(result.fallback === "browser", `expected browser fallback, got ${result.fallback}`);
      } finally {
        config.fishTtsKey = previousKey;
      }
    }
  },
  {
    name: "dj: model-first instruction stays within the minimal execution contract",
    run: () => {
      const instruction = buildModelFirstDjLineInstruction();
      assert(instruction === "Write a natural spoken Chinese paragraph for the locked song.", "expected the approved minimal DJ instruction");
    }
  },
  {
    name: "dj: config exposes independent high-quality line model defaults",
    run: () => {
      assert(config.djAiModel === "deepseek-v4-flash", `expected DJ_AI_MODEL from .env.example/test env, got ${config.djAiModel}`);
      assert(config.djAiTemperature === 0.85, `expected DJ temperature 0.85, got ${config.djAiTemperature}`);
      assert(config.djAiTimeoutMs === 12000, `expected DJ timeout 12000, got ${config.djAiTimeoutMs}`);
      assert(config.djAiReasoningEffort === "low", `expected DJ reasoning effort low, got ${config.djAiReasoningEffort}`);
    }
  },
  {
    name: "dj: context validation keeps safety boundaries without policing writing moves",
    run: () => {
      const track = {
        id: "context-validation-smoke",
        title: "Context Validation Song",
        artist: "Context Validation Artist",
        album: "Smoke",
        filePath: "smoke://context-validation.mp3",
        folder: "smoke",
        extension: "mp3",
        source: "main",
        playable: true,
        size: 1,
        addedAt: new Date().toISOString()
      } as const;
      assert(
        invalidContextDjLineReason("手上的事先放一会儿，等这段旋律慢慢走到你身边。", track) === "",
        "expected style moves to remain model-led in context validation"
      );
      assert(
        invalidContextDjLineReason("这首纯音乐没有一句歌词，但旋律已经把话说完了。", track) === "",
        "expected an explicit no-lyrics statement to remain valid for an instrumental track"
      );
      assert(
        invalidContextDjLineReason("这是一段完整的主持人串词。".repeat(24), track) === "",
        "expected the formal path to accept a full broadcast-length line"
      );
    }
  },
  {
    name: "dj: instrumental tracks reject vocal wording",
    run: () => {
      const instrumentalTrack = {
        id: "instrumental-1",
        title: "Pure Imagination (纯音乐)",
        artist: "ROOK1E",
        album: "",
        filePath: "",
        folder: "",
        extension: "mp3",
        source: "main",
        playable: true,
        size: 1,
        addedAt: ""
      } as const;

      assert(
        invalidDjLineReason("器乐留白之后，让这段细腻的歌词慢慢落进心里。", [], instrumentalTrack),
        "expected vocal wording to be rejected for instrumental track"
      );
      assert(
        invalidContextDjLineReason("这首纯音乐没有歌词，适合把注意力暂时放回眼前。", instrumentalTrack) === "",
        "expected an explicit no-lyrics statement to remain valid for an instrumental track"
      );
      assert(
        invalidContextDjLineReason("这首纯音乐不需要歌词帮忙，它让旋律自己说话。", instrumentalTrack) === "",
        "expected a no-lyrics-needed statement to remain valid for an instrumental track"
      );
      assert(
        !invalidDjLineReason(
          "Pure Imagination，ROOK1E。先到这首。",
          [],
          instrumentalTrack
        ),
        "expected neutral per-track narration to pass"
      );
      assert(
        invalidDjLineReason("先把手里的事停一停，听 ROOK1E 的 Pure Imagination。留一点空白，心也能休息一下。", [], instrumentalTrack),
        "expected hand-task template wording to be rejected"
      );
      assert(
        invalidDjLineReason("接下来为您带来一首很有氛围感的作品。", [], instrumentalTrack),
        "expected broadcast/template wording to be rejected"
      );
      assert(
        invalidDjLineReason("Kevin Kern 的《Fairy Wings》接上来，音色会铺得很开。", [], instrumentalTrack),
        "expected transition/unfolding template wording to be rejected"
      );
      assert(
        invalidDjLineReason("你可以半听半放，让它在耳边留一点余地。", [], instrumentalTrack, "plain_note"),
        "expected listening-instruction template wording to be rejected"
      );
      assert(
        invalidDjLineReason("节奏会一点点铺开，像把精神从旁边扶起来。", [], instrumentalTrack, "mood_note"),
        "expected music forecast template wording to be rejected"
      );
      assert(
        invalidDjLineReason("嗯，今晚的旋律仿佛能把所有疲惫都慢慢安放在心里。", [], instrumentalTrack),
        "expected long written sentence to be rejected"
      );
    }
  },
  {
    name: "dj: program line contract supports longer radio monologue",
    run: async () => {
      const result = await generateProgramLine({
        type: "opening",
        scene: "work study night",
        recentTracks: [
          { title: "My Soul", artist: "July" },
          { title: "River Flows in You", artist: "Yiruma" }
        ],
        dryRun: true
      });

      assert(result.line.trim().length >= 40, "expected a non-empty program line");
      assert(!invalidProgramLineReason(result.line), `program line should pass validation: ${result.line}`);
    }
  }
];

try {
  for (const check of checks) {
    const startedAt = Date.now();
    try {
      await check.run();
      console.log(`PASS ${check.name} (${Date.now() - startedAt}ms)`);
    } catch (error) {
      console.error(`FAIL ${check.name}`);
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  for (const trackId of persistentSmokeTrackIds) removeSmokeTrack(trackId);
  for (const filePath of persistentSmokeFiles) fs.rmSync(filePath, { force: true });
  if (previousPlaybackSourceCache === null) fs.rmSync(playbackSourceCachePath, { force: true });
  else fs.writeFileSync(playbackSourceCachePath, previousPlaybackSourceCache);
}
