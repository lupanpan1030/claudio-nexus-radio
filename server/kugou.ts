import { config } from "./config.js";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export type KuGouSong = {
  title: string;
  artist?: string;
  album?: string;
  hash?: string;
  albumId?: string;
  mixsongId?: string;
  duration?: number;
  sourceId?: string;
};

export type KuGouPlaylist = {
  id: string;
  name: string;
  trackCount?: number;
};

export type KuGouLoginAccount = {
  userid: string;
  nickname?: string;
  avatar?: string;
};

export type KuGouLoginStatus = {
  loggedIn: boolean;
  userid?: string;
  loggedInAt?: string;
  expiresAt?: string;
  needsLogin?: boolean;
  reason?: string;
};

export type KuGouImportedPlaylist = {
  schema: "claudio.playlist.v1";
  title: string;
  scene: string;
  program_note: string;
  tracks: Array<{
    position: number;
    title: string;
    artist?: string;
    reason: string;
  }>;
};

export type KuGouPlaybackResult = {
  url: string;
  source: "kugou-api";
  matchedSong: KuGouSong;
  matchScore: number;
};

function apiBase() {
  return config.kugouApiBaseUrl.replace(/\/+$/, "");
}

const sessionPath = path.join(config.dataDir, "kugou-session.json");
const sessionTtlMs = 1000 * 60 * 60 * 24 * 14;
const bundledApiDir = path.join(config.dataDir, "external", "kugou-api");
const bundledApiLogPath = path.join(bundledApiDir, "claudio-kugou-runtime.log");
const bundledApiErrLogPath = path.join(bundledApiDir, "claudio-kugou-runtime.err.log");
const localApiBootDeadlineMs = 8000;

type KuGouSession = {
  cookie: string;
  userid: string;
  loggedInAt: string;
  source: "phone";
};

let runtimeSession: KuGouSession | null | undefined;
let autoStartPromise: Promise<boolean> | null = null;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalKuGouBase() {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(apiBase());
}

function bundledApiEntrypoint() {
  const appJs = path.join(bundledApiDir, "app.js");
  return fs.existsSync(appJs) ? appJs : "";
}

async function canReachLocalKuGouApi() {
  if (!isLocalKuGouBase()) return false;
  try {
    const url = new URL(`${apiBase()}/search/complex`);
    url.searchParams.set("keywords", "test");
    url.searchParams.set("pagesize", "1");
    url.searchParams.set("page", "1");
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureBundledLocalKuGouApi() {
  if (!config.kugouApiAutostart) return false;
  if (!isLocalKuGouBase()) return false;
  if (await canReachLocalKuGouApi()) return true;
  if (autoStartPromise) return autoStartPromise;

  autoStartPromise = (async () => {
    const entry = bundledApiEntrypoint();
    if (!entry) return false;

    fs.mkdirSync(bundledApiDir, { recursive: true });
    const out = fs.openSync(bundledApiLogPath, "a");
    const err = fs.openSync(bundledApiErrLogPath, "a");
    const base = new URL(apiBase());
    const host = base.hostname || "127.0.0.1";
    const port = base.port || (base.protocol === "https:" ? "443" : "80");

    const child = spawn(process.execPath, [entry], {
      cwd: bundledApiDir,
      detached: true,
      stdio: ["ignore", out, err],
      windowsHide: true,
      env: {
        ...process.env,
        HOST: host,
        PORT: port,
        platform: "lite"
      }
    });
    child.unref();

    const deadline = Date.now() + localApiBootDeadlineMs;
    while (Date.now() < deadline) {
      if (await canReachLocalKuGouApi()) return true;
      await sleep(500);
    }
    return false;
  })();

  try {
    return await autoStartPromise;
  } finally {
    autoStartPromise = null;
  }
}

function readSession() {
  if (runtimeSession !== undefined) return runtimeSession;
  try {
    runtimeSession = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as KuGouSession;
  } catch {
    runtimeSession = null;
  }
  return runtimeSession;
}

function writeSession(session: KuGouSession) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), "utf8");
  runtimeSession = session;
}

function sessionExpiry(session: KuGouSession) {
  return new Date(new Date(session.loggedInAt).getTime() + sessionTtlMs).toISOString();
}

function isSessionExpired(session: KuGouSession) {
  return Date.now() - new Date(session.loggedInAt).getTime() > sessionTtlMs;
}

function cookieFromHeaders(headers: Headers) {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  const values = getSetCookie && getSetCookie.length > 0 ? getSetCookie : [headers.get("set-cookie") ?? ""];
  return values
    .flatMap((value) => value.split(/,(?=[^;,]+=)/))
    .map((value) => value.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");
}

function authError(message: string) {
  const error = new Error(message) as Error & { needsLogin?: boolean };
  error.needsLogin = true;
  return error;
}

function bodyNeedsLogin(body: unknown) {
  const text = JSON.stringify(body);
  if (/"(?:error_code|errcode)"\s*:\s*(20010|20028|30705|30706)/i.test(text)) return true;
  return /"error_code"\s*:\s*(20010|30705|30706)|未登录|登录|token|cookie/i.test(text) && /20010|未登录|登录过期|token/i.test(text);
}

export function getKuGouLoginStatus(): KuGouLoginStatus {
  const session = readSession();
  if (!session) return { loggedIn: false, needsLogin: true, reason: "not_logged_in" };
  const expired = isSessionExpired(session);
  return {
    loggedIn: !expired,
    userid: session.userid,
    loggedInAt: session.loggedInAt,
    expiresAt: sessionExpiry(session),
    needsLogin: expired,
    reason: expired ? "expired" : undefined
  };
}

/** Server-side only: credentials for the v1 KuGou adapters. Never serialize to clients. */
export function getKuGouSessionCredentials(): { cookie: string; userid: string; loggedInAt: string } | null {
  const session = readSession();
  if (!session || isSessionExpired(session)) return null;
  return { cookie: session.cookie, userid: session.userid, loggedInAt: session.loggedInAt };
}

export function logoutKuGou() {
  runtimeSession = null;
  try {
    fs.rmSync(sessionPath, { force: true });
  } catch {
    // A missing session is already logged out.
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function parseKuGouBody(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const tagged = text.match(/<!--KG_TAG_RES_START-->([\s\S]*?)<!--KG_TAG_RES_END-->/);
    const jsonLike = tagged?.[1] ?? text.match(/\{[\s\S]*\}/)?.[0] ?? "";
    if (jsonLike) {
      try {
        return JSON.parse(jsonLike);
      } catch {
        // Keep the raw body below for diagnostics.
      }
    }
    return text;
  }
}

function asString(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return "";
}

function deepItems(value: unknown): Record<string, unknown>[] {
  const seen = new Set<unknown>();
  const items: Record<string, unknown>[] = [];

  function visit(node: unknown) {
    if (!node || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    if (typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const title = pickString(record, ["songname", "song_name", "filename", "name", "title"]);
    const id = pickString(record, ["id", "listid", "global_collection_id", "specialid", "hash", "FileHash"]);
    if (title || id) items.push(record);

    for (const value of Object.values(record)) {
      if (Array.isArray(value) || (value && typeof value === "object")) visit(value);
    }
  }

  visit(value);
  return items;
}

function deepRecords(value: unknown): Record<string, unknown>[] {
  const seen = new Set<unknown>();
  const records: Record<string, unknown>[] = [];

  function visit(node: unknown) {
    if (!node || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    if (typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    records.push(record);

    for (const child of Object.values(record)) {
      if (Array.isArray(child) || (child && typeof child === "object")) visit(child);
    }
  }

  visit(value);
  return records;
}

function looksLikeAudioUrl(value: string) {
  return /^https?:\/\//i.test(value) && !/\.jpg|\.jpeg|\.png|\.webp|\.gif($|\?)/i.test(value);
}

function firstAudioUrl(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") {
    const directMatch = value.match(/https?:\/\/[^\s"'<>]+/i)?.[0] ?? "";
    return looksLikeAudioUrl(directMatch) ? directMatch : "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = firstAudioUrl(item);
      if (nested) return nested;
    }
    return "";
  }

  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["url", "backup_url", "play_url", "playUrl", "audio_url"]) {
    const nested = firstAudioUrl(record[key]);
    if (nested) return nested;
  }

  for (const child of Object.values(record)) {
    const nested = firstAudioUrl(child);
    if (nested) return nested;
  }

  return "";
}

function normalizeSongIdentity(value: string) {
  return stripVersionDecorations(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function scoreKuGouSongMatch(track: Pick<KuGouSong, "title" | "artist">, song: KuGouSong) {
  const title = normalizeSongIdentity(track.title);
  const artist = normalizeSongIdentity(track.artist ?? "");
  const songTitle = normalizeSongIdentity(song.title);
  const songArtist = normalizeSongIdentity(song.artist ?? "");
  let score = 0;

  if (title && songTitle === title) score += 70;
  else if (title && (songTitle.includes(title) || title.includes(songTitle))) score += 40;

  if (artist && songArtist === artist) score += 30;
  else if (artist && (songArtist.includes(artist) || artist.includes(songArtist))) score += 15;

  return score;
}

function cleanTitle(value: string) {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function stripVersionDecorations(value: string) {
  return cleanTitle(value)
    .replace(/\s*[\(（\[【][^)\]）】]*[\)）\]】]\s*/g, " ")
    .replace(/\s*[-—–]?\s*(?:tv\s*(?:version|verison|size)|version|verison|live|instrumental|edit|mix|remaster(?:ed)?|extended|short|full\s*version)\s*$/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchKeywords(value: string) {
  const clean = cleanTitle(value);
  const stripped = stripVersionDecorations(value);
  const titleOnly = clean.includes(" - ") ? clean.split(/\s+-\s+/).slice(1).join(" - ").trim() : "";
  return [...new Set([clean, stripped, titleOnly].filter(Boolean))];
}

function parseFilename(filename: string) {
  const clean = cleanTitle(filename);
  const parts = clean.split(/\s+-\s+| - /);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
  return { title: clean };
}

function toSong(record: Record<string, unknown>): KuGouSong | null {
  const filename = pickString(record, ["filename", "FileName", "songname", "name", "title"]);
  const parsed = parseFilename(filename);
  let title = cleanTitle(pickString(record, ["songname", "SongName", "song_name", "audio_name", "name", "title"]) || parsed.title);
  const artist = cleanTitle(
    pickString(record, ["singername", "SingerName", "singer_name", "author_name", "artist", "singer"]) || parsed.artist || ""
  );

  if (artist && title.toLowerCase().startsWith(`${artist.toLowerCase()} - `)) {
    title = title.slice(artist.length + 3).trim();
  }

  if (!title) return null;
  return {
    title,
    artist: artist || undefined,
    album: cleanTitle(pickString(record, ["album_name", "albumname", "album", "AlbumName"])) || undefined,
    hash: pickString(record, ["hash", "Hash", "FileHash", "audio_id", "Audioid"]) || undefined,
    albumId: pickString(record, ["album_id", "albumid", "AlbumID"]) || undefined,
    mixsongId: pickString(record, ["mixsongid", "MixSongID", "mix_song_id", "album_audio_id", "audio_id", "Audioid", "id"]) || undefined,
    duration: asNumber(record.duration ?? record.timelength),
    sourceId: pickString(record, ["id", "audio_id", "Audioid", "hash", "Hash", "FileHash"]) || undefined
  };
}

function toPlaylist(record: Record<string, unknown>): KuGouPlaylist | null {
  const id = pickString(record, ["global_collection_id", "listid", "specialid", "id"]);
  const name = cleanTitle(pickString(record, ["name", "title", "listname", "specialname"]));
  if (!id || !name) return null;
  return {
    id,
    name,
    trackCount: asNumber(record.count ?? record.songcount ?? record.total)
  };
}

async function kugouFetch(
  pathname: string,
  params: Record<string, string | number | undefined> = {},
  options: { method?: "GET" | "POST"; auth?: boolean } = {}
) {
  const session = options.auth ? readSession() : null;
  if (options.auth) {
    if (!session) throw authError("KuGou login is required.");
    if (isSessionExpired(session)) throw authError("KuGou login expired. Please log in again.");
  }

  const url = new URL(`${apiBase()}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  async function runFetch() {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(session?.cookie ? { Cookie: session.cookie, Authorization: session.cookie } : {})
      }
    });
    const text = await response.text();
    const body = parseKuGouBody(text);

    if (bodyNeedsLogin(body)) throw authError("KuGou verification or login is required.");
    if (!response.ok) throw new Error(`KuGou API ${response.status}: ${text.slice(0, 160)}`);
    if (options.auth && bodyNeedsLogin(body)) throw authError("KuGou login expired. Please log in again.");
    return body;
  }

  try {
    return await runFetch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const autoStarted = await ensureBundledLocalKuGouApi();
    if (autoStarted && /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(message)) {
      return runFetch();
    }
    throw error;
  }
}

async function firstSuccessful(
  paths: string[],
  params: Record<string, string | number | undefined>,
  options: { auth?: boolean } = {}
) {
  const errors: string[] = [];
  for (const pathname of paths) {
    try {
      return await kugouFetch(pathname, params, options);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(errors[0] ?? "KuGou API request failed");
}

export async function healthCheckKuGouApi() {
  try {
    const body = await firstSuccessful(["/search", "/search/complex", "/search/song"], { keywords: "test", pagesize: 1, page: 1 });
    return { ok: true, baseUrl: apiBase(), sampleCount: deepItems(body).length, autoStartAvailable: fs.existsSync(bundledApiDir) };
  } catch (error) {
    return {
      ok: false,
      baseUrl: apiBase(),
      error: error instanceof Error ? error.message : "KuGou API unavailable",
      autoStartAvailable: fs.existsSync(bundledApiDir),
      localApiEntrypoint: bundledApiEntrypoint() || undefined,
      runtimeLog: fs.existsSync(bundledApiLogPath) ? bundledApiLogPath : undefined
    };
  }
}

export async function searchKuGouSong(keyword: string, limit = 10): Promise<KuGouSong[]> {
  const songs: KuGouSong[] = [];
  const seen = new Set<string>();

  for (const searchKeyword of buildSearchKeywords(keyword)) {
    let body: unknown;
    try {
      body = await firstSuccessful(
        ["/search", "/search/complex", "/search/song"],
        {
          keywords: searchKeyword,
          pagesize: limit,
          page: 1
        },
        { auth: true }
      );
    } catch {
      body = await firstSuccessful(["/search", "/search/complex", "/search/song"], {
        keywords: searchKeyword,
        pagesize: limit,
        page: 1
      });
    }

    for (const song of deepItems(body).map(toSong).filter((item): item is KuGouSong => !!item)) {
      const key = `${song.title}\n${song.artist ?? ""}\n${song.hash ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      songs.push(song);
    }

    if (songs.length >= limit) break;
  }

  return songs.slice(0, limit);
}

export function playbackSourceRequests(track: Pick<KuGouSong, "albumId" | "hash" | "mixsongId">) {
  return [
    {
      pathname: "/song/url",
      params: {
        hash: track.hash,
        album_id: track.albumId,
        album_audio_id: track.mixsongId,
        quality: 320
      }
    },
    {
      pathname: "/song/url",
      params: {
        hash: track.hash,
        album_id: track.albumId,
        album_audio_id: track.mixsongId,
        quality: 128
      }
    },
    {
      pathname: "/song/url/new",
      params: {
        hash: track.hash,
        album_audio_id: track.mixsongId
      }
    }
  ];
}

export async function getKuGouSongPlaybackUrl(track: Pick<KuGouSong, "title" | "artist" | "hash">): Promise<KuGouPlaybackResult | null> {
  // Synced KuGou tracks already carry the authoritative hash. Avoid a second
  // search request here: the upstream complex-search endpoint can reject valid
  // logged-in sessions with error 152 while direct hash playback still works.
  const directHash = track.hash?.trim();
  const directSong: KuGouSong | null = directHash
    ? { title: track.title, artist: track.artist, hash: directHash }
    : null;
  const songs = directSong ? [] : await searchKuGouSong([track.artist, track.title].filter(Boolean).join(" "), 6);
  const match = directSong
    ? { song: directSong, score: 100 }
    : songs
        .filter((item) => item.hash)
        .map((song) => ({ song, score: scoreKuGouSongMatch(track, song) }))
        .sort((left, right) => right.score - left.score)[0];
  const minimumScore = track.artist?.trim() ? 85 : 70;
  if (!match || match.score < minimumScore) return null;
  const matchedSong = match.song;

  const requests = playbackSourceRequests(matchedSong);
  const authModes = readSession() ? [true, false] : [false];

  for (const request of requests) {
    for (const auth of authModes) {
      try {
        const body = await kugouFetch(request.pathname, request.params, { auth });
        const url = firstAudioUrl(body);
        if (url) {
          return {
            url,
            source: "kugou-api",
            matchedSong,
            matchScore: match.score
          };
        }
      } catch {
        // Try the next quality or authenticated request.
      }
    }
  }

  return null;
}

export async function sendKuGouCaptcha(mobile: string) {
  if (!/^\d{11}$/.test(mobile)) throw new Error("mobile must be an 11 digit phone number");
  return kugouFetch("/captcha/sent", { mobile }, { method: "POST" });
}

function parseLoginAccounts(body: unknown): KuGouLoginAccount[] {
  const record = asRecord(body);
  const data = asRecord(record.data);
  const directList = Array.isArray(data.info_list) ? data.info_list : Array.isArray(record.info_list) ? record.info_list : [];
  const source = directList.length > 0 ? directList : deepItems(body);
  return source
    .map<KuGouLoginAccount | null>((record) => {
      const item = asRecord(record);
      const userid = pickString(item, ["userid", "user_id", "id"]);
      if (!userid) return null;
      return {
        userid,
        nickname: pickString(item, ["nickname", "nick_name", "name", "username"]) || undefined,
        avatar: pickString(item, ["pic", "avatar", "headimg", "img"]) || undefined
      };
    })
    .filter((item): item is KuGouLoginAccount => !!item);
}

function pickLoggedInUserId(body: unknown, fallback = "") {
  const record = asRecord(body);
  const data = asRecord(record.data);
  return pickString(data, ["userid", "user_id"]) || pickString(record, ["userid", "user_id"]) || fallback;
}

export async function loginKuGouCellphone(mobile: string, code: string, userid?: string) {
  if (!/^\d{11}$/.test(mobile)) throw new Error("mobile must be an 11 digit phone number");
  if (!/^\d{4,8}$/.test(code)) throw new Error("code must be a numeric verification code");

  const url = new URL(`${apiBase()}/login/cellphone`);
  url.searchParams.set("mobile", mobile);
  url.searchParams.set("code", code);
  if (userid) url.searchParams.set("userid", userid);

  const response = await fetch(url, { method: "POST", headers: { Accept: "application/json" } });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Keep plain text body for diagnostics.
  }

  const serialized = JSON.stringify(body);
  const loginRecord = asRecord(body);
  const loginData = asRecord(loginRecord.data);
  if (/34175/.test(serialized) || Array.isArray(loginData.info_list) || Array.isArray(loginRecord.info_list)) {
    return { ok: false as const, requiresAccountSelection: true, accounts: parseLoginAccounts(body), raw: body };
  }

  if (!response.ok) throw new Error(`KuGou login ${response.status}: ${text.slice(0, 160)}`);

  const cookie = cookieFromHeaders(response.headers);
  const loggedInUserId = pickLoggedInUserId(body, userid);
  if (!cookie || !loggedInUserId) {
    throw new Error("KuGou login did not return a usable session.");
  }

  const session: KuGouSession = {
    cookie,
    userid: loggedInUserId,
    loggedInAt: new Date().toISOString(),
    source: "phone"
  };
  writeSession(session);

  return {
    ok: true as const,
    status: getKuGouLoginStatus(),
    raw: body
  };
}

export async function getKuGouUserPlaylists(): Promise<KuGouPlaylist[]> {
  const body = await kugouFetch("/user/playlist", {}, { auth: true });
  const playlists = deepItems(body).map(toPlaylist).filter((item): item is KuGouPlaylist => !!item);
  const seen = new Set<string>();
  return playlists.filter((playlist) => {
    if (seen.has(playlist.id)) return false;
    seen.add(playlist.id);
    return true;
  });
}

export async function getKuGouPlaylistTracks(playlistId: string, expectedCount = 0): Promise<KuGouSong[]> {
  if (expectedCount === 0) return [];
  const errors: string[] = [];
  const songs: KuGouSong[] = [];
  const pageSize = 200;
  const pageCount = Math.max(1, Math.ceil(expectedCount / pageSize));
  for (let page = 1; page <= pageCount; page += 1) {
    let body: unknown;
    for (const request of [
      { pathname: "/playlist/track/all/new", params: { listid: playlistId, page, pagesize: pageSize } },
      { pathname: "/playlist/track/all", params: { id: playlistId, page, pagesize: pageSize } },
      { pathname: "/playlist/detail", params: { ids: playlistId } }
    ]) {
      try {
        body = await kugouFetch(request.pathname, request.params, { auth: true });
        break;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!body) throw new Error(errors[0] ?? "KuGou playlist tracks failed");
    const pageSongs = deepItems(body).map(toSong).filter((song): song is KuGouSong => !!song);
    songs.push(...pageSongs);
    if (pageSongs.length < pageSize) break;
  }

  const seen = new Set<string>();
  const uniqueSongs = songs.filter((song) => {
    const key = `${song.title}\n${song.artist ?? ""}\n${song.hash ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return expectedCount > 0 ? uniqueSongs.slice(0, expectedCount) : uniqueSongs;
}

export function toClaudioPlaylist(title: string, tracks: KuGouSong[]): KuGouImportedPlaylist {
  return {
    schema: "claudio.playlist.v1",
    title,
    scene: "kugou-favorites",
    program_note: "Imported from KuGou API metadata. Claudio will only play locally matched files.",
    tracks: tracks.map((track, index) => ({
      position: index + 1,
      title: track.title,
      artist: track.artist,
      reason: "KuGou playlist metadata; local playback required."
    }))
  };
}
