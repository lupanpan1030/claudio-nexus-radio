#!/usr/bin/env node
// Runs server tests from a throwaway cwd with an explicit, credential-free
// environment: no project .env, no real DATA_DIR/profile/library, no provider
// keys, KuGou autostart off and every upstream pointed at a closed port.
//   node server/scripts/run-isolated-tests.mjs [test files…]   (default: server/test/*.test.mjs)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requested = process.argv.slice(2).map((file) => path.resolve(file));
const files = requested.length
  ? requested
  : fs
      .readdirSync(path.join(root, "server/test"))
      .filter((name) => name.endsWith(".test.mjs"))
      .sort()
      .map((name) => path.join(root, "server/test", name));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-isolated-tests-"));
const dirs = { data: path.join(work, "data"), profile: path.join(work, "profile"), music: path.join(work, "music") };
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

const closed = "http://127.0.0.1:9";
const env = {
  PATH: process.env.PATH ?? "",
  HOME: work,
  TZ: process.env.TZ ?? "UTC",
  NODE_ENV: "test",
  DATA_DIR: dirs.data,
  USER_PROFILE_DIR: dirs.profile,
  MUSIC_LIBRARY_DIR: dirs.music,
  KUGOU_API_AUTOSTART: "false",
  KUGOU_API_BASE_URL: closed,
  AI_BASE_URL: closed,
  CHAT_AI_BASE_URL: closed,
  FISH_TTS_ENDPOINT: `${closed}/v1/tts`,
  CLAUDIO_REPO_ROOT: root
};

const result = spawnSync(
  process.execPath,
  [
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
