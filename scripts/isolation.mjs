// Shared isolation policy for root maintenance entries (scripts/test.mjs,
// scripts/smoke.mjs): every run gets a throwaway work directory and an
// environment rebuilt from an explicit allowlist — no project .env (the cwd
// is the work directory), no real DATA_DIR/profile/library, nothing inherited
// beyond PATH/TZ (so no provider keys or proxies), KuGou autostart off and
// every upstream pointed at a closed port. HOME is neither set nor
// overridden; it is simply not passed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Node fetch refuses port 9 as a "bad port", so nothing on this machine is ever reached through it. */
export const CLOSED_UPSTREAM = "http://127.0.0.1:9";

/** Credentials and proxies the product reads; passed explicitly empty so nothing inherited can fill them. */
const EMPTY = [
  "AI_API_KEY",
  "AI_BACKUP_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "CHAT_AI_API_KEY",
  "FISH_TTS_API_KEY",
  "FISH_API_KEY",
  "FISH_TTS_VOICE_ID",
  "LLM_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "FISH_TTS_PROXY"
];

/** A fresh work directory with cwd/data/profile/music/tmp below it; the caller removes `work`. */
export function createWork(name) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `claudio-${name}-`));
  const dirs = { work, cwd: path.join(work, "cwd"), data: path.join(work, "data"), profile: path.join(work, "profile"), music: path.join(work, "music"), tmp: path.join(work, "tmp") };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

/** The allowlisted environment for a run in `dirs` (see createWork); `extra` adds named entries. */
export function isolatedEnv(dirs, extra = {}) {
  return {
    PATH: process.env.PATH ?? "",
    TMPDIR: dirs.tmp,
    TZ: process.env.TZ ?? "UTC",
    NODE_ENV: "test",
    DATA_DIR: dirs.data,
    USER_PROFILE_DIR: dirs.profile,
    MUSIC_LIBRARY_DIR: dirs.music,
    KUGOU_API_AUTOSTART: "false",
    KUGOU_API_BASE_URL: CLOSED_UPSTREAM,
    AI_BASE_URL: CLOSED_UPSTREAM,
    CHAT_AI_BASE_URL: CLOSED_UPSTREAM,
    FISH_TTS_ENDPOINT: `${CLOSED_UPSTREAM}/v1/tts`,
    CLAUDIO_REPO_ROOT: root,
    ...extra
  };
}

/** Every credential/proxy variable the product reads, set empty (for entries that pass the env on to product code). */
export function emptyCredentials() {
  return Object.fromEntries(EMPTY.map((key) => [key, ""]));
}

/** tsx loader resolved from the repository install (no global tsx). */
export const tsxLoader = path.join(root, "node_modules/tsx/dist/esm/index.mjs");
