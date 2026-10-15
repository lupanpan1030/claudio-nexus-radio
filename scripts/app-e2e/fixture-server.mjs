// Isolated v1 server for the main-app browser acceptance (child process of
// fixture.mjs; never run directly). The real createApp, assemblePlayback,
// SQLite stores, v1 routes and the real library DTO code (server/track-dto.ts)
// run unchanged; only the provider, radio chooser, script writer, TTS and the
// legacy non-playback dependencies are synthetic. Every sound is a generated
// WAV; the "voice" is a test tone, not speech. Nothing here reads .env, real
// accounts, a real library or the network.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const runDir = process.env.APP_E2E_RUN_DIR ?? "";
// The child's TMPDIR is inside the run directory, so check the shape fixture.mjs creates instead.
if (!path.isAbsolute(runDir) || !path.basename(runDir).startsWith("claudio-app-e2e-") || !fs.existsSync(path.join(runDir, "isolation.json"))) {
  throw new Error("fixture-server.mjs is started by fixture.mjs with an isolated temporary run directory");
}
const requireFromRepo = createRequire(path.join(repo, "package.json"));
const express = requireFromRepo("express");
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const [{ createApp }, { assemblePlayback }, { FakeProvider, FakeRadio }, { makeWav }, { abortableDelay, raceAbort }, { appError }, { toLibraryResponse }] = await Promise.all([
  load("server/http/app.ts"),
  load("server/playback-assembly.ts"),
  load("server/testing/fakes.ts"),
  load("server/testing/wav.ts"),
  load("server/application/operations.ts"),
  load("server/application/errors.ts"),
  load("server/track-dto.ts")
]);

const json = (value) => JSON.parse(JSON.stringify(value));
const artifacts = path.join(runDir, "audio");
fs.mkdirSync(artifacts, { recursive: true });
let phase = "initial";
let seq = 0;
let clockOffset = 0;
let closing = false;
const clock = { now: () => Date.now() + clockOffset };
const requests = [];
const events = [];
const legacyCalls = [];
const counters = { sourceResolve: 0, sourceOpen: 0, lyrics: 0, script: 0, tts: 0, radio: 0, scriptAborted: 0, ttsAborted: 0 };

const SENSITIVE = /^(mobile|code|cookie|token|password|authorization|apiKey|secret)$/i;
function redact(value, key = "") {
  if (SENSITIVE.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return typeof value === "string" ? value.slice(0, 6000) : value;
}
function event(type, details = {}) {
  const entry = { type, at: new Date().toISOString(), phase, ...redact(details) };
  events.push(entry);
  fs.appendFileSync(path.join(runDir, "events.jsonl"), JSON.stringify(entry) + "\n");
  return entry;
}

const TRACK_IDS = ["A", "B", "C"];
const defaults = () => ({
  tracks: Object.fromEntries(TRACK_IDS.map((id, index) => [id, { resolveDelayMs: 0, openDelayMs: 0, resolveError: null, openError: null, lyricsDelayMs: 0, lyricsMode: ["word", "line", "plain"][index] }])),
  scriptDelayMs: 0,
  scriptFail: false,
  scriptHold: false,
  ttsDelayMs: 0,
  ttsFail: false,
  ttsHold: false,
  voiceDurationMs: 3000,
  // "ogg-labelled-wav": the WAV bytes are stored and described as Ogg, which the server's duration
  // probe cannot read, so the voice asset's duration is "unknown". Served as audio/ogg; Chromium
  // sniffs the real container.
  voiceFormat: "wav",
  radioDelayMs: 0,
  radioFail: false,
  streamChunkDelayMs: 0,
  sourceTtlMs: 900000
});
let config = defaults();
let voiceVersion = 0;
const gates = { script: new Set(), tts: new Set() };
async function stageGate(stage, signal) {
  if (!config[`${stage}Hold`]) return;
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  gates[stage].add(release);
  event("gate-wait", { stage });
  try {
    await raceAbort(promise, signal);
  } finally {
    gates[stage].delete(release);
  }
}
function releaseGates(stage) {
  let count = 0;
  for (const name of stage === "all" ? ["script", "tts"] : [stage]) {
    for (const resolve of gates[name] ?? []) {
      count += 1;
      resolve();
    }
  }
  event("gate-release", { stage, count });
  return count;
}

const provider = new FakeProvider("fixture");
const metadata = [
  { mediaId: "A", title: "灯亮之前", artist: "隔离样本 A", durationMs: 16000, seed: 2 },
  { mediaId: "B", title: "下一段风景", artist: "隔离样本 B", durationMs: 20000, seed: 3 },
  { mediaId: "C", title: "慢慢向前", artist: "隔离样本 C", durationMs: 24000, seed: 5 }
];
for (const track of metadata) {
  const bytes = makeWav(track.durationMs, { seed: track.seed });
  provider.add({ ...track, bytes });
  fs.writeFileSync(path.join(artifacts, `${track.mediaId}.wav`), bytes);
}
const ref = (mediaId) => ({ providerId: "fixture", mediaId });
const catalog = {
  describe(track) {
    const entry = provider.describe(track);
    return entry && { ...entry, legacyTrackId: track.mediaId };
  },
  search(query, limit) {
    return provider.search(query, limit).map((entry) => ({ ...entry, legacyTrackId: entry.ref.mediaId }));
  }
};
const source = {
  async resolve(track, context) {
    counters.sourceResolve += 1;
    const settings = { ...config.tracks[track.mediaId] };
    event("source-resolve", { track, reason: context.reason, previousRevision: context.previous?.sourceRevision ?? null });
    if (settings.resolveDelayMs) await abortableDelay(settings.resolveDelayMs, context.signal);
    if (settings.resolveError) throw appError(settings.resolveError, "fixture_source_failure");
    const resolved = await provider.resolve(track, context);
    return { ...resolved, expiresAt: clock.now() + config.sourceTtlMs };
  },
  async open(binding, request) {
    counters.sourceOpen += 1;
    const settings = { ...config.tracks[binding.mediaId] };
    event("source-open", { mediaId: binding.mediaId, range: request.range, hash: binding.hash });
    if (settings.openDelayMs) await abortableDelay(settings.openDelayMs, request.signal);
    if (settings.openError) throw appError(settings.openError, "fixture_open_failure");
    const result = await provider.open(binding, request);
    const delay = config.streamChunkDelayMs;
    if (!delay || !result.body) return result;
    const body = (async function* () {
      for await (const chunk of result.body) {
        for (let index = 0; index < chunk.length; index += 8192) {
          await abortableDelay(delay, request.signal);
          yield chunk.subarray(index, index + 8192);
        }
      }
    })();
    return { ...result, body };
  }
};
const WORD_LRC = (id) => `[00:04.00]<00:04.00>灯<00:04.40>亮<00:04.80>之<00:05.20>前<00:05.80>\n[00:08.00]<00:08.00>听<00:08.40>见<00:08.80>${id}<00:09.20>的风<00:10.00>\n[00:12.00]<00:12.00>慢<00:12.50>慢<00:13.00>向前<00:14.00>`;
const LINE_LRC = (id) => `[00:04.00]下一段风景 ${id}\n[00:08.00]把时间留给耳朵\n[00:12.00]慢慢向前`;
const lyrics = {
  async fetch(lookup, { signal }) {
    counters.lyrics += 1;
    const id = String(lookup.binding.mediaId);
    const settings = { ...config.tracks[id] };
    if (settings.lyricsDelayMs) await abortableDelay(settings.lyricsDelayMs, signal);
    event("lyrics-fetch", { mediaId: id, revision: lookup.sourceRevision, mode: settings.lyricsMode });
    if (settings.lyricsMode === "missing") return { kind: "missing", reason: "not-found" };
    if (settings.lyricsMode === "unmatched") return { kind: "unmatched" };
    if (settings.lyricsMode === "plain") return { kind: "text", format: "plain", text: `这是一段没有时间轴的歌词 ${id}\n不会伪造逐字进度\n慢慢向前`, documentKey: `fixture:${id}:plain` };
    return { kind: "text", format: "lrc", text: settings.lyricsMode === "word" ? WORD_LRC(id) : LINE_LRC(id), documentKey: `fixture:${id}:${settings.lyricsMode}` };
  }
};
const writer = {
  async write(request) {
    counters.script += 1;
    const call = counters.script;
    event("script-start", { call, to: request.to.ref, from: request.from?.ref ?? null });
    try {
      await stageGate("script", request.signal);
      if (config.scriptDelayMs) await abortableDelay(config.scriptDelayMs, request.signal);
      if (config.scriptFail) throw appError("unavailable", "fixture_script_failure");
      const text = `刚才的旋律先停在这里。接下来，是${request.to.display.title}。让我们慢慢听。`;
      event("script-ready", { call, text });
      return { text, writer: "fixture-no-model" };
    } catch (error) {
      if (request.signal.aborted) counters.scriptAborted += 1;
      event("script-failed", { call, aborted: request.signal.aborted });
      throw error;
    }
  }
};
const tts = {
  configured: true,
  get descriptor() {
    return { provider: "fixture-tone", model: "deterministic-pcm", voice: `tone-v${voiceVersion}`, format: config.voiceFormat === "ogg-labelled-wav" ? "ogg" : "wav", options: JSON.stringify({ durationMs: config.voiceDurationMs, version: voiceVersion }) };
  },
  async synthesize(text, { signal }) {
    counters.tts += 1;
    const call = counters.tts;
    event("tts-start", { call, text });
    try {
      await stageGate("tts", signal);
      if (config.ttsDelayMs) await abortableDelay(config.ttsDelayMs, signal);
      if (config.ttsFail) throw appError("retryable", "fixture_tts_failure");
      const bytes = makeWav(config.voiceDurationMs, { seed: 9 });
      fs.writeFileSync(path.join(artifacts, `voice-${call}.wav`), bytes);
      event("tts-ready", { call, bytes: bytes.length, durationMs: config.voiceDurationMs });
      return bytes;
    } catch (error) {
      if (signal.aborted) counters.ttsAborted += 1;
      event("tts-failed", { call, aborted: signal.aborted });
      throw error;
    }
  }
};
const chooser = new FakeRadio(() => catalog.search("", 50));
const radio = {
  async pick(request) {
    counters.radio += 1;
    event("radio-start", { call: counters.radio });
    if (config.radioDelayMs) await abortableDelay(config.radioDelayMs, request.signal);
    if (config.radioFail) throw appError("unavailable", "fixture_radio_failure");
    const pick = await chooser.pick(request);
    event("radio-picked", { ref: pick?.entry.ref ?? null, excluded: request.exclude });
    return pick;
  }
};

const db = new DatabaseSync(path.join(runDir, "radio.sqlite"));
const assembly = assemblePlayback({
  db,
  providers: [{ providerId: "fixture", catalog, source, lyrics }],
  radio,
  writer,
  tts,
  voiceDir: path.join(runDir, "tts-v2"),
  clock,
  legacyRef: (row) => ref(row.id),
  serverInstanceId: `fixture-server-${path.basename(runDir)}`,
  policy: { prepareResponseWaitMs: 250, maxLongPollMs: 3000, sourceDeadlineMs: 5000, lyricsDeadlineMs: 5000, scriptDeadlineMs: 15000, voiceDeadlineMs: 15000 }
});
const rows = metadata.map((track) => ({
  id: track.mediaId,
  title: track.title,
  artist: track.artist,
  album: "合成样本",
  filePath: path.join(artifacts, `${track.mediaId}.wav`),
  folder: "fixture",
  extension: "wav",
  source: "main",
  playable: true,
  size: provider.tracks.get(track.mediaId).bytes.length,
  addedAt: new Date().toISOString()
}));
const insert = db.prepare("INSERT INTO tracks(id,title,artist,album,file_path,folder,extension,source,playable,size,added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
for (const row of rows) insert.run(row.id, row.title, row.artist, row.album, row.filePath, row.folder, row.extension, row.source, 1, row.size, row.addedAt);
const pick = (id) => ({ songId: id, djLine: "", reason: "隔离候选", moodTags: ["fixture"], source: "rules" });
const playlist = () => ({ playlistId: "fixture-playlist", title: "隔离验收歌单", scene: "fixture", summary: "三个合成样本", picks: rows.map((row) => pick(row.id)), source: "rules", generatedAt: new Date().toISOString() });
const tastes = new Set();
let loggedIn = false;
const loginStatus = () => ({ loggedIn, ...(loggedIn ? { userid: "fixture-account", loggedInAt: new Date().toISOString() } : {}), reason: "synthetic-fixture" });
const profile = { taste: "合成验收档案。", routines: "暂停和继续均由用户控制。", moodRules: "仅用样本。", interviews: "" };
const weather = { available: false, summary: "隔离环境不请求天气", source: "fallback" };
const emptyNow = { updatedAt: "", playback: { isPlaying: false, currentTime: 0, duration: 0, volume: 0 }, currentTrack: null, currentPick: null, dj: null, queue: { activePlaylistId: null, activePlaylistTitle: null, length: 0, nextSongId: null }, source: "web" };
const matchRows = (query) => rows.filter((row) => !query || `${row.id} ${row.title} ${row.artist}`.includes(query));
const impl = {
  config: { libraryDir: "[synthetic-fixtures]", aiProvider: "fixture", aiModel: "no-network", djAiModel: "no-network", djAiTimeoutMs: 15000, djAiReasoningEffort: "" },
  countTracks: () => rows.length,
  getActiveDailyPlan: () => null,
  getRecommendationAudits: () => [],
  getTodayPicks: () => [],
  getTrack: (id) => rows.find((row) => row.id === id),
  getTracks: (limit = 5000, query = "") => matchRows(query).slice(0, limit),
  // The real DTO code: the route passes the v1 ref rule (here the fixture provider's) and the allowlist is the production one.
  toLibraryResponse,
  scanLibrary: async () => rows,
  recordTaste: (id, action) => tastes.add(`${id}:${action}`),
  removeTaste: (id, action) => tastes.delete(`${id}:${action}`),
  healthCheckKuGouApi: async () => ({ ok: true, baseUrl: "fixture://offline", sampleCount: 3, autoStartAvailable: false }),
  hasLlm: () => true,
  getKuGouLoginStatus: loginStatus,
  logoutKuGou: () => {
    loggedIn = false;
  },
  sendKuGouCaptcha: async () => ({ sent: false, fixture: true }),
  loginKuGouCellphone: async () => {
    loggedIn = true;
    return { ok: true, status: loginStatus() };
  },
  getKuGouUserPlaylists: async () => [{ id: "fixture-list", name: "假账号样本", trackCount: 3 }],
  getKuGouLibraryStatus: () => ({ playlistCount: 1, trackCount: 3, membershipCount: 3 }),
  syncKuGouLibrary: async () => ({ playlistCount: 1, trackCount: 3, membershipCount: 3, added: 0, updated: 0, removed: 0, syncedAt: new Date().toISOString() }),
  searchKuGouSong: async (query) => matchRows(query).map((row) => ({ title: row.title, artist: row.artist, sourceId: row.id })),
  getNowPlayingSnapshot: () => emptyNow,
  getWeatherContext: async () => weather,
  sanitizeWeatherForDj: (value) => value,
  updateBrowserWeatherLocation: () => undefined,
  getCalendarContext: () => ({ available: true, block: "afternoon", label: "fixture", interruptionLevel: "normal", djGuidance: "隔离测试", nextWindow: "fixture", source: "local-rules" }),
  getUserProfileDocs: async () => profile,
  updateTasteProfile: async (message) => ({ ok: true, memory: message, nextQuestion: "测试完成。", docs: profile, usedOpenAI: false }),
  getRadioDecision: async (_query, _weather, count) => ({ picks: rows.slice(0, count).map((row) => pick(row.id)), ranked: [] }),
  suggestPlaylist: async () => playlist(),
  importAgentPlaylist: () => playlist(),
  importLatestInboxPlaylist: () => playlist(),
  importPendingInboxPlaylist: () => null,
  inspectPlaylistLink: (inputUrl) => ({ inputUrl: String(inputUrl), platform: "unknown", status: "unsupported", message: "隔离环境不解析外链", nextStep: "使用 fixture 歌单" }),
  planToday: async () => ({ reply: "隔离计划", playlist: playlist() }),
  chatWithRadio: async (message) => {
    const id = /\b([ABC])\b/i.exec(message)?.[1]?.toUpperCase() ?? "B";
    if (/歌单/.test(message)) return { reply: "这是隔离验收歌单。", playlist: playlist() };
    if (/下一首|加入队列/.test(message)) return { reply: `已把 ${id} 放进候选。`, queuePick: pick(id) };
    if (/播放/.test(message)) return { reply: `已提供播放候选 ${id}。`, pick: pick(id) };
    return { reply: "这是隔离 fixture 的普通回复，没有调用任何模型。" };
  },
  generateDjLine: async (input) => ({ songId: input.songId, djLine: "这是一条受控测试文稿。", source: "rules", usedLlm: false }),
  generateProgramLine: async (input) => ({ type: input.type, line: "受控节目提示。", source: "rules", usedLlm: false }),
  appendDjSample: (kind, input) => ({ id: `fixture-feedback-${Date.now()}`, ...input, why: kind, createdAt: new Date().toISOString() }),
  synthesizeTts: async () => {
    throw appError("unavailable", "fixture_legacy_tts_forbidden", "use v1 narration; legacy TTS is deliberately disabled");
  },
  recordPlay: () => {
    throw new Error("fixture: legacy recordPlay must never run in v1");
  }
};
const legacy = new Proxy(impl, {
  get(target, key) {
    const value = target[key];
    if (typeof value !== "function") return value ?? (() => { throw new Error(`unsupported fixture legacy dependency: ${String(key)}`); });
    return (...args) => {
      const sensitive = key === "loginKuGouCellphone" || key === "sendKuGouCaptcha";
      const call = { name: String(key), args: sensitive ? args.map(() => "[redacted]") : redact(args) };
      legacyCalls.push(call);
      event("legacy-call", call);
      return value(...args);
    };
  }
});
const hooks = {
  chatDeps: {},
  recentTracks: () => assembly.services.started.recent(30).map((fact) => rows.find((row) => row.id === fact.track.mediaId)).filter(Boolean),
  verifyPlayable: async () => true,
  refForLegacyTrack: (row) => ref(row.id),
  onKuGouAccountChanged: () => event("fake-account-change"),
  nowProjection: () => assembly.services.now.get(),
  subscribeNow: (listener) => assembly.services.now.subscribe(listener)
};
const real = createApp({ playbackProtocol: "v1", playback: assembly.services, legacy, legacyHooks: hooks });

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  const entry = { seq: ++seq, phase, at: new Date().toISOString(), method: req.method, path: req.path, query: redact(req.query), client: String(req.headers["x-fixture-client"] ?? ""), range: req.headers.range ?? null, body: redact(req.body ?? null) };
  requests.push(entry);
  // The JSON answers that hand out stream handles (prepare / preparation polls / resolve / narration) are
  // kept with their request, so a check can tie a native element's src to the item or cue it was issued for.
  if (/^\/api\/v1\/playback\/(prepare|preparations\/[^/]+|resolve|narration)$/.test(req.path)) {
    const send = res.json.bind(res);
    res.json = (body) => {
      entry.response = redact(json(body ?? null));
      return send(body);
    };
  }
  const started = performance.now();
  let logged = false;
  const finish = () => {
    if (logged) return;
    logged = true;
    entry.status = res.statusCode;
    entry.elapsedMs = Math.round(performance.now() - started);
    fs.appendFileSync(path.join(runDir, "requests.jsonl"), JSON.stringify(entry) + "\n");
  };
  res.once("finish", finish);
  res.once("close", finish);
  next();
});
const forbidden = (row) => row.path === "/api/radio/next" || row.path === "/api/tts/synthesize" || /^\/api\/track\/[^/]+\/(stream|playback-source)$/.test(row.path) || (row.path === "/api/now" && row.method === "PUT");
function state() {
  return {
    fixture: true,
    phase,
    runDir,
    config: json(config),
    gates: { script: gates.script.size, tts: gates.tts.size },
    counters: json(counters),
    tracks: metadata.map((track) => ({ ...track, track: ref(track.mediaId) })),
    tastes: [...tastes],
    login: loginStatus(),
    started: assembly.services.started.recent(200),
    now: assembly.services.now.get(),
    violations: requests.filter(forbidden),
    legacyCalls,
    requestCount: requests.length
  };
}
const ERROR_CLASSES = new Set(["unavailable", "retryable", "expired", "auth-required"]);
const LYRICS_MODES = ["word", "line", "plain", "missing", "unmatched"];
function patchConfig(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("config must be an object");
  const next = json(config);
  const set = (object, key, value, allowed) => {
    if (!allowed.includes(key)) throw new Error(`unknown config key ${key}`);
    if (key.endsWith("Ms")) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_200_000) throw new Error(`invalid milliseconds ${key}`);
    } else if (key.endsWith("Fail") || key.endsWith("Hold")) {
      if (typeof value !== "boolean") throw new Error(`invalid boolean ${key}`);
    } else if (key.endsWith("Error")) {
      if (value !== null && !ERROR_CLASSES.has(value)) throw new Error("invalid error class");
    } else if (key === "lyricsMode" && !LYRICS_MODES.includes(value)) {
      throw new Error("invalid lyricsMode");
    } else if (key === "voiceFormat" && !["wav", "ogg-labelled-wav"].includes(value)) {
      throw new Error("invalid voiceFormat");
    }
    object[key] = value;
  };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "tracks") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tracks must be an object");
      for (const [id, changes] of Object.entries(value)) {
        if (!Object.hasOwn(next.tracks, id)) throw new Error("unknown track");
        for (const [k, v] of Object.entries(changes ?? {})) set(next.tracks[id], k, v, Object.keys(defaults().tracks.A));
      }
    } else {
      set(next, key, value, Object.keys(defaults()).filter((k) => k !== "tracks"));
    }
  }
  if (next.voiceDurationMs < 100 || next.voiceDurationMs > 60000) throw new Error("voiceDurationMs must be 100..60000");
  if (Object.keys(patch).some((key) => key.startsWith("tts") || key === "voiceDurationMs" || key === "voiceFormat")) voiceVersion += 1;
  config = next;
  event("config-change", { config });
  return config;
}
app.get("/__fixture/state", (_req, res) => res.json(state()));
app.get("/__fixture/log", (req, res) => res.json({ requests: requests.filter((row) => row.seq > Number(req.query.afterSeq ?? 0)), events }));
app.post("/__fixture/phase", (req, res) => {
  phase = String(req.body?.name ?? "unnamed").slice(0, 100);
  event("phase");
  res.json({ phase });
});
app.post("/__fixture/config", (req, res) => {
  try {
    res.json(patchConfig(req.body));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.post("/__fixture/release", (req, res) => {
  const stage = req.body?.stage ?? "all";
  if (!["script", "tts", "all"].includes(stage)) return res.status(400).json({ error: "invalid stage" });
  res.json({ released: releaseGates(stage) });
});
app.post("/__fixture/replace-track", (req, res) => {
  const track = metadata.find((entry) => entry.mediaId === req.body?.mediaId);
  const seed = Number(req.body?.seed);
  if (!track || !Number.isSafeInteger(seed) || seed < 1 || seed > 10000) return res.status(400).json({ error: "mediaId A/B/C and integer seed 1..10000 required" });
  track.seed = seed;
  const bytes = makeWav(track.durationMs, { seed });
  provider.tracks.get(track.mediaId).bytes = bytes;
  fs.writeFileSync(path.join(artifacts, `${track.mediaId}.wav`), bytes);
  event("replace-track", { mediaId: track.mediaId, seed });
  res.json({ ok: true, track: ref(track.mediaId), seed });
});
app.post("/__fixture/shutdown", (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => void shutdown(), 30);
});
app.use(real.app);
app.use((error, _req, res, _next) => {
  event("http-error", { message: error.message });
  res.status(500).json({ fixture: true, error: error.message });
});

const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const apiOrigin = `http://127.0.0.1:${server.address().port}`;
let vite = null;
let webOrigin = null;
if (process.env.APP_E2E_WEB === "1") {
  const { createServer } = await import(pathToFileURL(requireFromRepo.resolve("vite")).href);
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const webPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  // The repository's own vite.config.ts (dev resolves workspace packages to
  // their sources); env and cache directories stay inside the run directory.
  vite = await createServer({
    root: repo,
    configFile: path.join(repo, "vite.config.ts"),
    envDir: runDir,
    cacheDir: path.join(runDir, "vite-cache"),
    logLevel: "warn",
    server: { host: "127.0.0.1", port: webPort, strictPort: true, proxy: { "/api": apiOrigin }, fs: { allow: [repo, runDir] } }
  });
  await vite.listen();
  webOrigin = vite.resolvedUrls.local[0].replace(/\/$/, "");
}
const ready = { event: "fixture-ready", apiOrigin, webOrigin, runDir, pid: process.pid, protocolVersion: 1, providerId: "fixture", tracks: metadata.map((track) => ref(track.mediaId)), viteConditions: vite?.config.resolve.conditions ?? null };
fs.writeFileSync(path.join(runDir, "ready.json"), JSON.stringify(ready, null, 2));
event("ready", ready);
console.log(JSON.stringify(ready));

async function shutdown() {
  if (closing) return;
  closing = true;
  event("shutdown-start");
  releaseGates("all");
  await real.close();
  assembly.close();
  if (vite) await vite.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.writeFileSync(path.join(runDir, "final-state.json"), JSON.stringify(state(), null, 2));
  db.close();
  event("shutdown-complete");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
