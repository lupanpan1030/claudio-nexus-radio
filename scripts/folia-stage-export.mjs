#!/usr/bin/env node
// Exports a verified build of the separate claudio-folia-stage repository into
// public/vendor/folia-stage/ (gitignored: the AGPL build is served, never
// committed here) and writes the small pin Claudio commits.
//
//   node scripts/folia-stage-export.mjs [--stage <path>] [--allow-uncommitted]
//
// --stage defaults to the sibling checkout ../claudio-folia-stage. The stage's
// own export script verifies dist (hashes, imports, licences) and refuses an
// un-ignored target; this script re-hashes the copy, then pins
// name/version/contract/source hash/entry hash/commit. Without an export the
// app keeps its basic lyrics; a pin mismatch makes the app refuse the stage.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const stageRoot = resolve(option("--stage") ?? join(repoRoot, "..", "claudio-folia-stage"));
const target = join(repoRoot, "public", "vendor", "folia-stage");
const pinPath = join(repoRoot, "src", "stage", "folia-stage.pin.json");
const fail = (message) => {
  console.error(`folia-stage export failed: ${message}`);
  process.exit(1);
};

const exporter = join(stageRoot, "scripts", "export-dist.mjs");
if (!existsSync(exporter)) fail(`no stage export script at ${exporter} (pass --stage <path>)`);

const exportArgs = [exporter, target, "--replace"];
if (args.includes("--allow-uncommitted")) exportArgs.push("--allow-uncommitted");
execFileSync(process.execPath, exportArgs, { stdio: "inherit", cwd: stageRoot });

const info = JSON.parse(readFileSync(join(target, "BUILD_INFO.json"), "utf8"));
if (info.name !== "claudio-folia-stage") fail(`unexpected build name ${info.name}`);
if (!Array.isArray(info.files) || info.files.length === 0) fail("BUILD_INFO lists no files");
for (const file of info.files) {
  const bytes = readFileSync(join(target, file.path));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== file.sha256 || bytes.length !== file.bytes) fail(`${file.path} does not match BUILD_INFO`);
}
const entry = info.files.find((file) => file.path === info.entry);
if (!entry) fail(`entry ${info.entry} is not listed in BUILD_INFO`);

const pin = {
  name: info.name,
  version: info.version,
  contractVersion: info.contractVersion,
  sourceSha256: info.sourceSha256,
  entry: info.entry,
  entrySha256: entry.sha256,
  stageGitCommit: info.stageGitCommit ?? null,
  stageWorkingTreeDirty: info.stageWorkingTreeDirty !== false,
  upstream: info.upstream,
  base: "/vendor/folia-stage/"
};
writeFileSync(pinPath, `${JSON.stringify(pin, null, 2)}\n`);
console.log(`pinned ${pin.name}@${pin.version} contract ${pin.contractVersion} source ${pin.sourceSha256.slice(0, 12)} → ${pinPath}`);
if (pin.stageWorkingTreeDirty) console.warn("warning: the stage build came from an uncommitted tree; re-export from a commit before distributing.");
