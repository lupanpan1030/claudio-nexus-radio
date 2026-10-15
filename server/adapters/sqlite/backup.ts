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
  /** Symlinks/special files not copied (directories only). */
  readonly skipped?: number;
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

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

/**
 * The backup root: created 0700 when absent (with any missing parents, which
 * this task then owns), or an existing empty directory that is already
 * private to this user. The mode of an existing directory or of its parents
 * is never changed: a wider one is refused, before anything is copied.
 */
function prepareRoot(outDir: string): void {
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(outDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!stat) {
    fs.mkdirSync(outDir, { recursive: true, mode: PRIVATE_DIR });
    stat = fs.lstatSync(outDir);
  } else {
    if (!stat.isDirectory()) throw new Error(`backup target ${outDir} is not a directory`);
    if (fs.readdirSync(outDir).length > 0) throw new Error(`backup target ${outDir} is not empty`);
  }
  if (!stat.isDirectory()) throw new Error(`backup target ${outDir} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`backup target ${outDir} is not owned by the current user`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `backup target ${outDir} is accessible to other users (mode ${(stat.mode & 0o777).toString(8)}); use a new path or make it private (chmod 700) first`
    );
  }
}

/** A directory inside the backup, private from creation (umask can only narrow it). */
function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
}

/** Copies one regular file into a new 0600 file (exclusive create, no wider intermediate mode). */
function copyPrivateFile(source: string, target: string): void {
  const input = fs.openSync(source, "r");
  try {
    const output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, PRIVATE_FILE);
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const read = fs.readSync(input, buffer, 0, buffer.length, null);
        if (read === 0) break;
        let written = 0;
        while (written < read) written += fs.writeSync(output, buffer, written, read - written);
      }
      fs.fsyncSync(output);
    } finally {
      fs.closeSync(output);
    }
  } finally {
    fs.closeSync(input);
  }
}

/** Recursive copy of regular files and directories only; symlinks and special files are skipped and counted. */
function copyPrivateTree(source: string, target: string): number {
  privateDir(target);
  let skipped = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) skipped += copyPrivateTree(from, to);
    else if (entry.isFile()) copyPrivateFile(from, to);
    else skipped += 1;
  }
  return skipped;
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function directoryStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!isRealDirectoryPath(dir, entry.parentPath)) continue;
    files += 1;
    bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return { files, bytes };
}

/** True unless the path lies below a symlinked directory (which copies skip). */
function isRealDirectoryPath(root: string, dir: string): boolean {
  let current = dir;
  while (current.length > root.length) {
    if (fs.lstatSync(current).isSymbolicLink()) return false;
    current = path.dirname(current);
  }
  return true;
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
 * WAL is in use; other files are copied byte for byte. Never reads .env.
 * The backup holds sessions and profile data: every directory in it is 0700
 * and every file 0600 from the moment it is created. A dry run touches nothing.
 */
export function backupState(
  locations: StateLocations,
  outDir: string,
  options: { execute: boolean; appVersion?: string | null; gitCommit?: string | null; now?: Date }
): BackupManifest {
  const entries: ManifestEntry[] = [];
  if (options.execute) prepareRoot(outDir);

  const dbPath = path.join(locations.dataDir, "radio.sqlite");
  let sqliteSchemaVersion: number | null = null;
  if (fs.existsSync(dbPath)) {
    sqliteSchemaVersion = readSchemaVersion(dbPath);
    const target = path.join(outDir, "data", "radio.sqlite");
    let sha256: string | undefined;
    let bytes: number | undefined;
    if (options.execute) {
      privateDir(path.dirname(target));
      // VACUUM INTO accepts an existing empty file and keeps its mode, so the copy is never wider than 0600.
      fs.closeSync(fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, PRIVATE_FILE));
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
      privateDir(path.dirname(target));
      copyPrivateFile(source, target);
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
    const skipped = options.execute ? copyPrivateTree(dir.source, dir.target) : 0;
    entries.push({
      kind: "directory",
      role: dir.role,
      source: dir.source,
      target: dir.target,
      sensitive: dir.sensitive,
      format: dir.format,
      ...directoryStats(dir.source),
      ...(skipped > 0 ? { skipped } : {})
    });
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
  if (options.execute) fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: PRIVATE_FILE, flag: "wx" });
  return manifest;
}
