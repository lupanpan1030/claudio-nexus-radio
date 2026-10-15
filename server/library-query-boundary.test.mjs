import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-library-query-"));
process.env.DATA_DIR = dataDir;
const { db, getTracks, upsertTracks } = await import("./db.ts");

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("public catalog search cannot probe persistence locators", () => {
  upsertTracks([{
    id: "locator-probe-track",
    title: "Ordinary title",
    artist: "Ordinary artist",
    album: "Ordinary album",
    filePath: "/private/secret-path-sentinel/song.mp3",
    folder: "secret-path-sentinel/song.mp3",
    extension: "mp3",
    source: "main",
    playable: true,
    size: 1,
    addedAt: "2026-08-15T00:00:00.000Z"
  }]);

  assert.equal(getTracks(10, "secret-path-sentinel").length, 0);
  assert.equal(getTracks(10, "secret-path-sentinel", { searchFilePath: false }).length, 0);
  assert.equal(getTracks(10, "secret-path-sentinel", { searchFilePath: true }).length, 1);
});
