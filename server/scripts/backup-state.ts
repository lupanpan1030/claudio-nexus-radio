import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { backupState } from "../adapters/sqlite/backup.js";

/**
 * Usage (paths are explicit; nothing is inferred from .env):
 *   tsx server/scripts/backup-state.ts --data-dir <DATA_DIR> --out <empty dir>
 *       [--user-profile-dir <dir>] [--inbox-dir <dir>] [--execute]
 * Without --execute it only prints the inventory (dry run).
 */
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dataDir = arg("--data-dir");
const outDir = arg("--out");
if (!dataDir || !outDir) {
  console.error("usage: backup-state --data-dir <dir> --out <dir> [--user-profile-dir <dir>] [--inbox-dir <dir>] [--execute]");
  process.exit(2);
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.dirname(new URL(import.meta.url).pathname), encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function appVersion(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

const manifest = backupState(
  { dataDir: path.resolve(dataDir), userProfileDir: arg("--user-profile-dir") ?? null, inboxDir: arg("--inbox-dir") ?? null },
  path.resolve(outDir),
  { execute: process.argv.includes("--execute"), appVersion: appVersion(), gitCommit: gitCommit() }
);
console.log(JSON.stringify(manifest, null, 2));
