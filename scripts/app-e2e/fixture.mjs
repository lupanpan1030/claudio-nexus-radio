// Starts the isolated fixture server (fixture-server.mjs) in a child process
// with an explicit allowlisted environment: temporary cwd/data/profile/music,
// KuGou autostart off, every real upstream pointed at a closed loopback port,
// no inherited credentials and no project .env. API and Vite listen on
// 127.0.0.1 at random ports.
//
//   node scripts/app-e2e/fixture.mjs [--web]     # manual use; Ctrl-C stops it
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../..");
const CLOSED = "http://127.0.0.1:9";

/** Starts one fixture; resolves with its ready message and a stop() that waits for a clean exit. */
export async function startFixture({ web = true, timeoutMs = 60_000, logPrefix = null } = {}) {
  const runDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "claudio-app-e2e-"));
  for (const name of ["data", "profile", "music", "tmp"]) fs.mkdirSync(path.join(runDir, name));
  const env = {
    PATH: process.env.PATH ?? "",
    TZ: "UTC",
    NODE_ENV: "test",
    TMPDIR: path.join(runDir, "tmp"),
    DATA_DIR: path.join(runDir, "data"),
    USER_PROFILE_DIR: path.join(runDir, "profile"),
    MUSIC_LIBRARY_DIR: path.join(runDir, "music"),
    KUGOU_API_AUTOSTART: "false",
    KUGOU_API_BASE_URL: CLOSED,
    AI_BASE_URL: CLOSED,
    CHAT_AI_BASE_URL: CLOSED,
    FISH_TTS_ENDPOINT: `${CLOSED}/v1/tts`,
    CLAUDIO_REPO_ROOT: repoRoot,
    APP_E2E_RUN_DIR: runDir,
    APP_E2E_WEB: web ? "1" : "0"
  };
  fs.writeFileSync(path.join(runDir, "isolation.json"), JSON.stringify({ runDir, environmentKeys: Object.keys(env), credentialsInherited: false, projectEnvLoaded: false, realCompositionUsed: false }, null, 2));
  const child = spawn(
    process.execPath,
    ["--import", path.join(repoRoot, "node_modules/tsx/dist/esm/index.mjs"), "--import", path.join(repoRoot, "server/testing/register-workspace.mjs"), path.join(here, "fixture-server.mjs")],
    { cwd: runDir, env, stdio: ["ignore", "pipe", "pipe"] }
  );
  const stdout = fs.createWriteStream(path.join(runDir, "stdout.log"));
  const stderr = fs.createWriteStream(path.join(runDir, "stderr.log"));
  let exited = false;
  const exit = new Promise((resolve) => child.once("exit", (code) => {
    exited = true;
    stdout.end();
    stderr.end();
    resolve(code);
  }));
  const ready = await new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`fixture did not start within ${timeoutMs}ms; see ${runDir}/stderr.log`)), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout.write(chunk);
      if (logPrefix) process.stdout.write(`${logPrefix}${chunk}`);
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (message.event === "fixture-ready") {
            clearTimeout(timer);
            resolve(message);
          }
        } catch {
          // Not a JSON line.
        }
      }
    });
    child.stderr.on("data", (chunk) => stderr.write(chunk));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited (${code}) before it was ready; see ${runDir}/stderr.log`));
    });
  });

  const api = async (method, route, body) => {
    const response = await fetch(ready.apiOrigin + route, {
      method,
      headers: { "content-type": "application/json", "x-fixture-client": "harness" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const stop = async () => {
    if (!exited) {
      await fetch(`${ready.apiOrigin}/__fixture/shutdown`, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(() => child.kill("SIGTERM"));
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exit;
      clearTimeout(timer);
    }
    return { runDir, exitCode: child.exitCode };
  };
  return { ready, runDir, api, stop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startFixture({ web: process.argv.includes("--web") });
  console.log(JSON.stringify(fixture.ready, null, 2));
  const stop = () => void fixture.stop().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
