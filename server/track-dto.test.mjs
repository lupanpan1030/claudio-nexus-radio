import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { toLibraryResponse, toTrackDto } = await import("./track-dto.ts");

function privateRecord(overrides = {}) {
  return {
    id: "private-track",
    title: "Private Track",
    artist: "Private Artist",
    album: "Private Album",
    filePath: "/Users/private/Music/secret-sentinel/song.flac",
    folder: "secret-sentinel/song.flac",
    extension: "flac",
    source: "main",
    playable: true,
    size: 123456,
    addedAt: "2026-08-15T00:00:00.000Z",
    providerSecret: "secret-provider-token",
    ...overrides
  };
}

test("track DTO is an explicit public allowlist", () => {
  const dto = toTrackDto(privateRecord());

  assert.deepEqual(Object.keys(dto).sort(), ["album", "artist", "extension", "id", "playable", "source", "title"]);
  const serialized = JSON.stringify(dto);
  assert.doesNotMatch(serialized, /secret-sentinel|secret-provider-token|filePath|folder|size|addedAt/);
});

test("library responses sanitize every non-empty record", () => {
  const response = toLibraryResponse([
    privateRecord(),
    privateRecord({ id: "remote-track", filePath: "kugou://private-hash", folder: "KuGou API" })
  ], 42);

  assert.equal(response.total, 42);
  assert.equal(response.tracks.length, 2);
  assert.doesNotMatch(JSON.stringify(response), /\/Users\/private|secret-sentinel|kugou:\/\/private-hash/);
});

test("library route uses the DTO boundary and disables locator search", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");

  assert.match(source, /toLibraryResponse\(getTracks\(limit, query, \{ searchFilePath: false \}\), countTracks\(\)\)/);
  assert.doesNotMatch(source, /res\.json\(\{\s*tracks:\s*getTracks/);
});
