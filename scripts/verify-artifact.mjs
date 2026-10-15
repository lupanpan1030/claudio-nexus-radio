#!/usr/bin/env node
// Production artifact check, run after `npm run build`: stages what a
// deployment carries outside the source tree and imports it with plain Node
// (no tsx, no "source" export condition, no NODE_PATH), so a module that only
// resolves thanks to workspace sources, a missing production dependency or a
// dev-only import fails here.
//
//   node scripts/verify-artifact.mjs [--out dir] [--keep]
//
// Staged: dist/, dist-server/ (tests excluded), prompts/ (read from cwd at
// runtime), root manifests and licences, every workspace's package.json +
// dist + LICENSE/NOTICE linked under node_modules/@claudio/*, and the non-dev
// packages of package-lock.json copied from the installed node_modules.
// Imported: every workspace package, dist-server/http/app.js and
// dist-server/composition.js; nothing is called or started. Fails on an import
// error, a symlink leaving the artifact, or a workspace src/ in it.
//
// Scope: module resolution and import safety only; it does not prove routes,
// providers, network or media behaviour.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createWork, isolatedEnv, root } from "./isolation.mjs";

const { values: args } = parseArgs({ options: { out: { type: "string" }, keep: { type: "boolean", default: false } } });
const out = args.out ? path.resolve(args.out) : fs.mkdtempSync(path.join(os.tmpdir(), "claudio-artifact-"));
const target = path.join(out, "artifact");
if (fs.existsSync(target)) throw new Error(`${target} already exists`);
if (path.relative(root, target).split(path.sep)[0] !== "..") throw new Error("the artifact must be staged outside the source tree");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const workspaces = manifest.workspaces;
if (!Array.isArray(workspaces) || workspaces.some((p) => p.includes("*"))) throw new Error("explicit workspace list required");
const notTest = (src) => !/\.test\./.test(path.basename(src));

fs.mkdirSync(target, { recursive: true });
for (const dir of ["dist", "dist-server", "prompts"]) {
  if (!fs.statSync(path.join(root, dir), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`missing ${dir}/ (run npm run build first)`);
  fs.cpSync(path.join(root, dir), path.join(target, dir), { recursive: true, filter: notTest });
}
for (const file of ["package.json", "package-lock.json", "LICENSE", "NOTICE", "NOTICE.md"]) {
  if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(target, file));
}

const names = [];
for (const rel of workspaces) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, rel, "package.json"), "utf8"));
  const dest = path.join(target, rel);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(root, rel, "package.json"), path.join(dest, "package.json"));
  if (!fs.existsSync(path.join(root, rel, "dist"))) throw new Error(`missing ${rel}/dist (run npm run build first)`);
  fs.cpSync(path.join(root, rel, "dist"), path.join(dest, "dist"), { recursive: true, filter: notTest });
  for (const file of fs.readdirSync(path.join(root, rel))) {
    if (/^(LICENSE|NOTICE)/.test(file)) fs.copyFileSync(path.join(root, rel, file), path.join(dest, file));
  }
  const link = path.join(target, "node_modules", pkg.name);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(link), dest), link, "dir");
  names.push(pkg.name);
}

const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const copied = [];
const optionalMissing = [];
for (const [rel, item] of Object.entries(lock.packages ?? {})) {
  if (!rel.startsWith("node_modules/") || item.dev || item.link) continue;
  const source = path.join(root, rel);
  if (!fs.existsSync(source)) {
    if (item.optional) {
      optionalMissing.push(rel);
      continue;
    }
    throw new Error(`locked production dependency ${rel} is not installed`);
  }
  // Nested node_modules are separate lock entries, copied on their own.
  fs.cpSync(source, path.join(target, rel), { recursive: true, dereference: true, filter: (src) => path.relative(source, src).split(path.sep)[0] !== "node_modules" });
  copied.push(rel);
}

const imports = [...names, "./dist-server/http/app.js", "./dist-server/composition.js"];
fs.writeFileSync(
  path.join(target, "import-probe.mjs"),
  `for (const name of ${JSON.stringify(imports)}) {\n  const module = await import(name);\n  console.log(JSON.stringify({ module: name, exports: Object.keys(module).length }));\n}\n`
);
const dirs = createWork("artifact-env");
const env = isolatedEnv(dirs, { NODE_ENV: "production", CLAUDIO_REPO_ROOT: target, CLAUDIO_NETWORK_GUARD_LOG: path.join(out, "network.jsonl") });
const run = spawnSync(process.execPath, ["--require", path.join(root, "scripts/network-guard.cjs"), "import-probe.mjs"], { cwd: target, env, encoding: "utf8", timeout: 60_000 });
fs.rmSync(dirs.work, { recursive: true, force: true });

const outside = [];
const sources = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(full);
      if (path.relative(fs.realpathSync(target), real).split(path.sep)[0] === "..") outside.push(full);
    } else if (entry.isDirectory()) walk(full);
  }
};
walk(target);
for (const rel of workspaces) if (fs.existsSync(path.join(target, rel, "src"))) sources.push(path.join(rel, "src"));

const result = {
  scope: "plain Node import and layout only; no server start, routes, providers, network or media",
  artifact: target,
  node: process.version,
  imports: (run.stdout ?? "").split("\n").filter(Boolean),
  importExit: run.status,
  importError: run.error?.message ?? (run.status === 0 ? null : (run.stderr ?? "").slice(-4000)),
  copiedProductionDependencies: copied.length,
  optionalMissing,
  externalSymlinks: outside,
  workspaceSources: sources
};
fs.writeFileSync(path.join(out, "artifact-result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
const ok = run.status === 0 && outside.length === 0 && sources.length === 0;
if (!args.keep && !args.out) fs.rmSync(out, { recursive: true, force: true });
console.log(ok ? "artifact import ok" : "artifact check FAILED");
process.exit(ok ? 0 : 1);
