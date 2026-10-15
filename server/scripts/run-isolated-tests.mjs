#!/usr/bin/env node
// Runs server tests from a throwaway cwd with an explicit, credential-free
// environment: no project .env, no real DATA_DIR/profile/library, no provider
// keys, KuGou autostart off and every upstream pointed at a closed port. HOME is
// not set at all: nothing under test may read or write a user home directory.
//   node server/scripts/run-isolated-tests.mjs [test files…]
//   (default: server/test/*.test.mjs and server/*.test.mjs)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requested = process.argv.slice(2).map((file) => path.resolve(file));
const discover = (dir) =>
  fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => path.join(root, dir, entry.name))
    .sort();
const files = requested.length ? requested : [...discover("server/test"), ...discover("server")];

const work = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-isolated-tests-"));
const dirs = {
  data: path.join(work, "data"),
  profile: path.join(work, "profile"),
  music: path.join(work, "music"),
  tmp: path.join(work, "tmp")
};
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

const closed = "http://127.0.0.1:9";
const env = {
  PATH: process.env.PATH ?? "",
  TZ: process.env.TZ ?? "UTC",
  NODE_ENV: "test",
  DATA_DIR: dirs.data,
  USER_PROFILE_DIR: dirs.profile,
  MUSIC_LIBRARY_DIR: dirs.music,
  TMPDIR: dirs.tmp,
  KUGOU_API_AUTOSTART: "false",
  KUGOU_API_BASE_URL: closed,
  AI_BASE_URL: closed,
  CHAT_AI_BASE_URL: closed,
  FISH_TTS_ENDPOINT: `${closed}/v1/tts`
};
// The only variable taken from the caller: a reviewed KuGou upstream checkout (a path, never a credential).
const PASSTHROUGH = ["CLAUDIO_KUGOU_API_REVIEWED_DIR"];
for (const name of PASSTHROUGH) if (process.env[name]) env[name] = process.env[name];

const result = spawnSync(
  process.execPath,
  [
    "--conditions=source",
    "--import",
    path.join(root, "node_modules/tsx/dist/esm/index.mjs"),
    "--import",
    path.join(root, "server/testing/register-workspace.mjs"),
    "--test",
    ...files
  ],
  { cwd: work, env, stdio: "inherit" }
);
fs.rmSync(work, { recursive: true, force: true });
process.exit(result.status ?? 1);
