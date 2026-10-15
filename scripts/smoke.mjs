#!/usr/bin/env node
// `npm run smoke`: the legacy server smoke (server/scripts/smoke.ts, 47 cases,
// unchanged) run isolated. The smoke opens SQLite, writes chat history,
// profile documents, a source cache and a playlist inbox under cwd/.data, so
// it never runs in the project directory: it gets a fresh work directory as
// cwd, empty data/profile/library/tmp, the shared allowlisted environment
// with every credential blank (scripts/isolation.mjs), and
// scripts/network-guard.cjs preloaded (non-loopback network and child
// processes refused). Only the two public prompt files it reads are copied in.
//
//   node scripts/smoke.mjs [--keep]
//
// --keep leaves the work directory (DB, guard log, output) for inspection;
// otherwise it is removed. The exit code is the smoke's own.
//
// Scope: these are the old module-level assertions (catalog mapping, context,
// radio rules, playlists, legacy now/playback/tts endpoints). They are not
// acceptance of the v1 playback core, real media or the main UI.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createWork, emptyCredentials, isolatedEnv, root, tsxLoader } from "./isolation.mjs";

const { values: args } = parseArgs({ options: { keep: { type: "boolean", default: false } } });

/** Public fixtures the smoke reads from cwd/prompts; nothing else is copied (no .env, .data, private assets). */
const FIXTURES = ["prompts/dj-persona.md", "prompts/dj-fewshot.md"];
const TIMEOUT_MS = 120_000;

const dirs = createWork("smoke");
for (const rel of FIXTURES) {
  const target = path.join(dirs.cwd, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, rel), target);
}
const guardLog = path.join(dirs.work, "network.jsonl");
const env = isolatedEnv(dirs, {
  ...emptyCredentials(),
  AI_BASE_URL: "http://127.0.0.1:9/v1",
  CHAT_AI_BASE_URL: "http://127.0.0.1:9/v1",
  CLAUDIO_NETWORK_GUARD_LOG: guardLog,
  TSX_TSCONFIG_PATH: path.join(root, "tsconfig.server.json")
});

const result = spawnSync(
  process.execPath,
  ["--require", path.join(root, "scripts/network-guard.cjs"), "--conditions=source", "--import", tsxLoader, path.join(root, "server/scripts/smoke.ts")],
  { cwd: dirs.cwd, env, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");

const passed = (result.stdout ?? "").split("\n").filter((line) => line.startsWith("PASS ")).length;
const failed = (result.stderr ?? "").split("\n").filter((line) => line.startsWith("FAIL ")).length;
const guard = fs.existsSync(guardLog)
  ? fs
      .readFileSync(guardLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  : [];
const refused = guard.filter((e) => e.allowed === false);
const status = result.error ? `error: ${result.error.message}` : result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
console.log(`\n=== isolated legacy smoke: ${passed} PASS, ${failed} FAIL, ${status}; guard refused ${refused.length} (${[...new Set(refused.map((e) => e.origin ?? e.host ?? e.command))].join(", ") || "none"}) ===`);
if (args.keep) console.log(`work directory kept: ${dirs.work}`);
else fs.rmSync(dirs.work, { recursive: true, force: true });
process.exit(result.status ?? 1);
