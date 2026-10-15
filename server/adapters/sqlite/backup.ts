import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION } from "./migrations.js";

export interface StateLocations {
  /** DATA_DIR: radio.sqlite, kugou-session.json, playback caches, tts/, tts-v2/. */
  readonly dataDir: string;
  /** USER_PROFILE_DIR: taste/routine docs, dj-samples.json. */
  readonly userProfileDir?: string | null;
  /** Legacy playlist inbox (the old server used <cwd>/.data/playlist-inbox). */
  readonly inboxDir?: string | null;
}

export interface ManifestEntry {
  readonly kind: "sqlite" | "file" | "directory";
  readonly role: string;
  readonly source: string;
  readonly target: string;
  readonly sensitive: boolean;
  /** How this state is treated by the v1 cut-over. */
  readonly format: string;
  readonly files?: number;
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface BackupManifest {
  readonly schema: "claudio.state-backup.v1";
  readonly createdAt: string;
  readonly appVersion: string | null;
  readonly gitCommit: string | null;
  readonly sqliteSchemaVersion: number | null;
  readonly codeSchemaVersion: number;
  readonly executed: boolean;
  readonly entries: readonly ManifestEntry[];
  readonly restore: readonly string[];
}

const FILE_STATE: ReadonlyArray<{ name: string; role: string; sensitive: boolean; format: string }> = [
  { name: "kugou-session.json", role: "KuGou login session", sensitive: true, format: "unchanged; logout/login invalidates v1 KuGou stream handles" },
  { name: "playback-source-cache-v2.json", role: "legacy KuGou URL cache", sensitive: false, format: "archived; v1 does not read it, legacy rollback may" }
];
const DIR_STATE: ReadonlyArray<{ name: string; role: string; format: string }> = [
  { name: "tts", role: "legacy TTS cache", format: "kept as-is for legacy /api/tts/<hash> and rollback" },
  { name: "tts-v2", role: "v1 voice cache", format: "content-keyed by provider/model/voice/format/options/text" }
];

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function directoryStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return { files, bytes };
}

function readSchemaVersion(dbPath: string): number | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!table) return 0;
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
    return Number(row.version ?? 0);
  } finally {
    db.close();
  }
}

/**
 * Inventory (dry run) or copy (execute) of all Claudio state. SQLite is
 * copied with VACUUM INTO, which produces a consistent snapshot even while
 * WAL is in use; other files are copied as-is. Never reads .env.
 */
export function backupState(
  locations: StateLocations,
  outDir: string,
  options: { execute: boolean; appVersion?: string | null; gitCommit?: string | null; now?: Date }
): BackupManifest {
  const entries: ManifestEntry[] = [];
  if (options.execute) {
    if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) throw new Error(`backup target ${outDir} is not empty`);
    fs.mkdirSync(outDir, { recursive: true });
  }

  const dbPath = path.join(locations.dataDir, "radio.sqlite");
  let sqliteSchemaVersion: number | null = null;
  if (fs.existsSync(dbPath)) {
    sqliteSchemaVersion = readSchemaVersion(dbPath);
    const target = path.join(outDir, "data", "radio.sqlite");
    let sha256: string | undefined;
    let bytes: number | undefined;
    if (options.execute) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const source = new DatabaseSync(dbPath);
      try {
        source.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
      } finally {
        source.close();
      }
      const copy = new DatabaseSync(target, { readOnly: true });
      try {
        const check = copy.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
        if (Object.values(check)[0] !== "ok") throw new Error("backup integrity_check failed");
      } finally {
        copy.close();
      }
      sha256 = sha256File(target);
      bytes = fs.statSync(target).size;
    }
    entries.push({
      kind: "sqlite",
      role: "main database (tracks, tastes, legacy plays/picks/audits, chat, memories, v1 playback tables)",
      source: dbPath,
      target,
      sensitive: true,
      format: "additive migrations; legacy rows and tracks.id kept",
      ...(sha256 ? { sha256, bytes } : {})
    });
  }

  for (const item of FILE_STATE) {
    const source = path.join(locations.dataDir, item.name);
    if (!fs.existsSync(source)) continue;
    const target = path.join(outDir, "data", item.name);
    if (options.execute) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    entries.push({ kind: "file", role: item.role, source, target, sensitive: item.sensitive, format: item.format, bytes: fs.statSync(source).size, sha256: sha256File(source) });
  }

  const dirs: Array<{ source: string; target: string; role: string; format: string; sensitive: boolean }> = DIR_STATE.map((item) => ({
    source: path.join(locations.dataDir, item.name),
    target: path.join(outDir, "data", item.name),
    role: item.role,
    format: item.format,
    sensitive: false
  }));
  if (locations.userProfileDir) {
    dirs.push({ source: locations.userProfileDir, target: path.join(outDir, "user-profile"), role: "user profile docs and DJ samples", format: "unchanged", sensitive: true });
  }
  if (locations.inboxDir) {
    dirs.push({ source: locations.inboxDir, target: path.join(outDir, "playlist-inbox"), role: "playlist inbox", format: "unchanged", sensitive: false });
  }
  for (const dir of dirs) {
    if (!fs.existsSync(dir.source)) continue;
    if (options.execute) fs.cpSync(dir.source, dir.target, { recursive: true });
    entries.push({ kind: "directory", role: dir.role, source: dir.source, target: dir.target, sensitive: dir.sensitive, format: dir.format, ...directoryStats(dir.source) });
  }

  const manifest: BackupManifest = {
    schema: "claudio.state-backup.v1",
    createdAt: (options.now ?? new Date()).toISOString(),
    appVersion: options.appVersion ?? null,
    gitCommit: options.gitCommit ?? null,
    sqliteSchemaVersion,
    codeSchemaVersion: CURRENT_SCHEMA_VERSION,
    executed: options.execute,
    entries,
    restore: [
      "Stop the Claudio server (no writer may hold radio.sqlite).",
      "Move the current DATA_DIR aside (do not delete it) and copy data/ from this backup into a fresh DATA_DIR.",
      "Copy user-profile/ to USER_PROFILE_DIR and playlist-inbox/ to the inbox location, if present.",
      "Start the build matching appVersion/gitCommit. Older builds ignore the additive v1 tables; their new rows stay unused, not converted.",
      "Run PRAGMA integrity_check on the restored radio.sqlite before serving traffic."
    ]
  };
  if (options.execute) fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}
