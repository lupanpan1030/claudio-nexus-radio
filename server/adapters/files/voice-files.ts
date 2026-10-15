import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MediaStream } from "../../ports/media-source.js";
import type { VoiceFileStore } from "../../ports/narration.js";
import { contentTypeFor, fileStream } from "./byte-range.js";

const SAFE_NAME = /^[a-f0-9]{64}\.(mp3|wav|ogg)$/;

/**
 * Voice files in a versioned directory (e.g. DATA_DIR/tts-v2). The legacy
 * DATA_DIR/tts cache is left untouched for rollback.
 */
export class DiskVoiceFileStore implements VoiceFileStore {
  constructor(private readonly dir: string) {}

  private pathFor(fileName: string): string {
    if (!SAFE_NAME.test(fileName)) throw new Error("invalid voice file name");
    return path.join(this.dir, fileName);
  }

  size(fileName: string): number | null {
    try {
      const stat = fs.statSync(this.pathFor(fileName));
      return stat.isFile() ? stat.size : null;
    } catch {
      return null;
    }
  }

  /** Temp file + fsync + rename in the same directory: readers never see partial audio. */
  async writeAtomic(fileName: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathFor(fileName);
    await fs.promises.mkdir(this.dir, { recursive: true });
    const temp = path.join(this.dir, `.${fileName}.${randomBytes(6).toString("hex")}.tmp`);
    const handle = await fs.promises.open(temp, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.promises.rename(temp, target);
    } catch (error) {
      await fs.promises.rm(temp, { force: true });
      throw error;
    }
  }

  async open(fileName: string, range: string | null, signal: AbortSignal): Promise<MediaStream> {
    const filePath = this.pathFor(fileName);
    const stat = await fs.promises.stat(filePath);
    return fileStream(filePath, stat.size, contentTypeFor(path.extname(fileName).slice(1)), range, signal);
  }

  remove(fileName: string): void {
    fs.rmSync(this.pathFor(fileName), { force: true });
  }
}
