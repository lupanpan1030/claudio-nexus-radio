import assert from "node:assert/strict";
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
  // Behavioral replacement for the old index.ts text assertion: the route now lives in http/legacy-routes.ts.
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { startHarness } = await import("./testing/harness.ts");
  const { ControlledWriter, FakeRadio, FakeSpeech } = await import("./testing/fakes.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-library-route-"));
  const calls = [];
  const harness = await startHarness({
    dir,
    providers: [],
    writer: new ControlledWriter(),
    tts: new FakeSpeech(),
    radio: new FakeRadio(() => []),
    legacy: {
      getTracks: (...args) => {
        calls.push(args);
        return [privateRecord()];
      },
      countTracks: () => 1,
      toLibraryResponse
    }
  });
  try {
    const response = await harness.request("GET", "/api/library?q=secret-sentinel&limit=5");
    assert.deepEqual(calls, [[5, "secret-sentinel", { searchFilePath: false }]]);
    assert.deepEqual(Object.keys(response.json.tracks[0]).sort(), ["album", "artist", "extension", "id", "playable", "source", "title"]);
    assert.doesNotMatch(JSON.stringify(response.json), /secret-sentinel|secret-provider-token/);
  } finally {
    await harness.close({ closeDb: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
