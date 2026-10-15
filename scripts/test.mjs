#!/usr/bin/env node
// Root test entry: discovers every *.test.{mjs,ts,tsx} in the source tree
// (nothing hard-coded, so new tests are picked up) and runs them in groups,
// each from a throwaway cwd with an explicit, credential-free environment —
// no project .env, no real DATA_DIR/profile/library, no provider keys, KuGou
// autostart off and every upstream pointed at a closed port (the policy of
// server/scripts/run-isolated-tests.mjs). Sources run through tsx with the
// "source" export condition, so no workspace dist is needed.
//
//   node scripts/test.mjs [--group packages,server,ui] [--require-upstream]
//
// The KuGou upstream compatibility cases need the reviewed KuGouMusicApi
// checkout at a fixed commit. Set CLAUDIO_KUGOU_API_REVIEWED_DIR to it; it is
// the only extra variable passed through. Without it those cases skip and the
// summary says "upstream NOT verified"; --require-upstream turns any skip of
// them into a failure (CI uses it with a pinned checkout).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    group: { type: "string" },
    "require-upstream": { type: "boolean", default: false }
  }
});

const SKIP_DIRS = new Set(["node_modules", ".git", ".data", ".results", "dist", "dist-server", "dist-showcase", "private-assets", "user", "docs", "photos", "public"]);
const TEST_FILE = /\.test\.(?:mjs|cjs|js|ts|tsx)$/;
const UPSTREAM_TEST = "server/test/kugou-upstream-and-autostart.test.mjs";

function discover() {
  const groups = { packages: [], server: [], ui: [] };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(full);
      } else if (TEST_FILE.test(entry.name)) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        const group = rel.startsWith("server/") ? "server" : rel.startsWith("packages/") || rel.startsWith("scripts/") ? "packages" : "ui";
        groups[group].push(rel);
      }
    }
  };
  walk(root);
  return groups;
}

function isolatedEnv(work) {
  const dirs = { data: path.join(work, "data"), profile: path.join(work, "profile"), music: path.join(work, "music"), tmp: path.join(work, "tmp") };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const closed = "http://127.0.0.1:9";
  const env = {
    PATH: process.env.PATH ?? "",
    TMPDIR: dirs.tmp,
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
  if (process.env.CLAUDIO_KUGOU_API_REVIEWED_DIR) env.CLAUDIO_KUGOU_API_REVIEWED_DIR = path.resolve(process.env.CLAUDIO_KUGOU_API_REVIEWED_DIR);
  return env;
}

/** Counts from the TAP stream; skipped cases are listed by name so a green run cannot hide them. */
function summarize(tap) {
  const count = (key) => Number(tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] ?? 0);
  const skipped = [...tap.matchAll(/^\s*ok \d+ - (.*?) # SKIP\s*(.*)$/gm)].map((m) => ({ name: m[1], reason: m[2] }));
  const todo = [...tap.matchAll(/^\s*(?:not )?ok \d+ - (.*?) # TODO\s*(.*)$/gm)].map((m) => ({ name: m[1], reason: m[2] }));
  return { tests: count("tests"), pass: count("pass"), fail: count("fail"), cancelled: count("cancelled"), skipped: count("skipped"), todo: count("todo"), skippedCases: skipped, todoCases: todo };
}

function runGroup(name, files) {
  if (files.length === 0) return { name, files: 0, status: 0, summary: null };
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `claudio-test-${name}-`));
  const tapFile = path.join(work, "result.tap");
  const loaders = ["--import", path.join(root, "node_modules/tsx/dist/esm/index.mjs")];
  // Server tests resolve @claudio/* to package sources through the existing workspace hook.
  if (name === "server") loaders.push("--import", path.join(root, "server/testing/register-workspace.mjs"));
  console.log(`\n=== ${name}: ${files.length} test files ===`);
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=source",
      ...loaders,
      "--test",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=tap",
      `--test-reporter-destination=${tapFile}`,
      ...files.map((file) => path.join(root, file))
    ],
    { cwd: work, env: isolatedEnv(work), stdio: "inherit" }
  );
  const tap = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, "utf8") : "";
  fs.rmSync(work, { recursive: true, force: true });
  return { name, files: files.length, status: result.status ?? 1, summary: summarize(tap) };
}

const groups = discover();
const selected = args.group ? args.group.split(",") : Object.keys(groups);
for (const name of selected) if (!(name in groups)) throw new Error(`unknown group ${name}`);
const results = selected.map((name) => runGroup(name, groups[name]));

const upstreamSkips = results.flatMap((r) => r.summary?.skippedCases ?? []).filter((c) => /upstream/i.test(`${c.name} ${c.reason}`));
const upstreamRan = selected.includes("server") && groups.server.includes(UPSTREAM_TEST);
console.log("\n=== summary ===");
for (const r of results) {
  const s = r.summary;
  console.log(`${r.status === 0 ? "ok  " : "FAIL"} ${r.name}: ${r.files} files${s ? `, ${s.tests} tests, ${s.pass} pass, ${s.fail} fail, ${s.skipped} skipped, ${s.todo} todo, ${s.cancelled} cancelled` : ""}`);
  for (const c of s?.skippedCases ?? []) console.log(`       skipped: ${c.name}${c.reason ? ` (${c.reason})` : ""}`);
  for (const c of s?.todoCases ?? []) console.log(`       todo: ${c.name}${c.reason ? ` (${c.reason})` : ""}`);
}
if (upstreamRan) console.log(upstreamSkips.length ? `upstream NOT verified: ${upstreamSkips.length} KuGou upstream cases skipped (set CLAUDIO_KUGOU_API_REVIEWED_DIR to the pinned checkout)` : "upstream verified against the pinned checkout");

let failed = results.some((r) => r.status !== 0);
if (args["require-upstream"] && upstreamRan && upstreamSkips.length > 0) {
  console.log("--require-upstream: upstream cases were skipped");
  failed = true;
}
process.exit(failed ? 1 : 0);
