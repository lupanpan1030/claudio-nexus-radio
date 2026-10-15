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
  assert.ok(response.tracks.every((track) => !("ref" in track)), "no ref rule (legacy protocol): no ref field");
  assert.doesNotMatch(JSON.stringify(response), /\/Users\/private|secret-sentinel|kugou:\/\/private-hash/);
});

test("with the composition's ref rule every library row carries the server-stated TrackRef and still no locator", async () => {
  // Rule only: records are built here. That real SQLite rows reach it with their stored source is
  // covered through createServices + HTTP in test/library-source-refs.e2e.test.mjs.
  const { legacyRefFor } = await import("./composition.ts");
  const response = toLibraryResponse([
    privateRecord({ id: "local-main" }),
    privateRecord({ id: "local-cache", source: "kugou-cache" }),
    privateRecord({ id: "remote-track", source: "kugou-api", filePath: "kugou://0123456789ABCDEF0123456789ABCDEF", folder: "KuGou API" }),
    privateRecord({ id: "orphan", source: "retired-source" })
  ], 4, legacyRefFor);

  for (const track of response.tracks) {
    assert.deepEqual(Object.keys(track).sort(), ["album", "artist", "extension", "id", "playable", "ref", "source", "title"]);
  }
  assert.deepEqual(response.tracks.map((track) => track.ref), [
    { providerId: "local", mediaId: "local-main" },
    { providerId: "local", mediaId: "local-cache" },
    { providerId: "kugou", mediaId: "remote-track" },
    null
  ]);
  assert.doesNotMatch(JSON.stringify(response), /secret-sentinel|secret-provider-token|kugou:\/\/|0123456789ABCDEF|filePath|folder/);
});

test("library route uses the DTO boundary and disables locator search", async () => {
  // Behavioral replacement for the old index.ts text assertion: the route now lives in http/legacy-routes.ts.
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { startHarness } = await import("./testing/harness.ts");
  const { ControlledWriter, FakeRadio, FakeSpeech } = await import("./testing/fakes.ts");
  const { legacyRefFor } = await import("./composition.ts");
  const calls = [];
  const start = (mode) =>
    startHarness({
      dir: fs.mkdtempSync(path.join(os.tmpdir(), "claudio-library-route-")),
      mode,
      providers: [],
      writer: new ControlledWriter(),
      tts: new FakeSpeech(),
      radio: new FakeRadio(() => []),
      hooks: { refForLegacyTrack: legacyRefFor },
      legacy: {
        getTracks: (...args) => {
          calls.push(args);
          return [privateRecord()];
        },
        countTracks: () => 1,
        toLibraryResponse
      }
    });
  const v1 = await start("v1");
  try {
    const response = await v1.request("GET", "/api/library?q=secret-sentinel&limit=5");
    assert.deepEqual(calls, [[5, "secret-sentinel", { searchFilePath: false }]]);
    assert.deepEqual(Object.keys(response.json.tracks[0]).sort(), ["album", "artist", "extension", "id", "playable", "ref", "source", "title"]);
    assert.deepEqual(response.json.tracks[0].ref, { providerId: "local", mediaId: "private-track" });
    assert.doesNotMatch(JSON.stringify(response.json), /secret-sentinel|secret-provider-token/);
  } finally {
    await v1.close({ closeDb: true });
  }
  const legacy = await start("legacy");
  try {
    const response = await legacy.request("GET", "/api/library");
    assert.deepEqual(Object.keys(response.json.tracks[0]).sort(), ["album", "artist", "extension", "id", "playable", "source", "title"], "the legacy protocol keeps its old shape");
  } finally {
    await legacy.close({ closeDb: true });
  }
});

test("over real HTTP a library row's ref is the ref the v1 catalog and playback use for that row", async () => {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const { decode, trackRefDecoder } = await import("@claudio/contracts");
  const { startHarness } = await import("./testing/harness.ts");
  const { ControlledWriter, FakeRadio, FakeSpeech } = await import("./testing/fakes.ts");
  const { makeWav } = await import("./testing/wav.ts");
  const { runMigrations } = await import("./adapters/sqlite/migrations.ts");
  const { LegacyTrackCatalog, TrackRowReader } = await import("./adapters/sqlite/track-catalog.ts");
  const { LocalFingerprints, LocalMediaSource } = await import("./adapters/local/local-source.ts");
  const { KUGOU_PROVIDER, LOCAL_PROVIDER, legacyRefFor } = await import("./composition.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-library-refs-"));
  const db = new DatabaseSync(path.join(dir, "radio.sqlite"));
  runMigrations(db);
  const insert = db.prepare("INSERT INTO tracks(id,title,artist,album,file_path,folder,extension,source,playable,size,added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const wav = makeWav(1000, { seed: 4 });
  fs.writeFileSync(path.join(dir, "song.wav"), wav);
  insert.run("legacy-local-1", "Local Song", "Fixture", "", path.join(dir, "song.wav"), dir, "wav", "main", 1, wav.length, "2026-10-16T00:00:00Z");
  insert.run("legacy-kg-1", "Remote Song", "Fixture", "", "kugou://0123456789ABCDEF0123456789ABCDEF", "KuGou API", "remote", "kugou-api", 1, 0, "2026-10-16T00:00:00Z");
  insert.run("legacy-orphan", "Orphan Song", "Fixture", "", path.join(dir, "missing.wav"), dir, "wav", "retired", 1, 0, "2026-10-16T00:00:00Z");
  const rows = new TrackRowReader(db);
  const providers = [
    { providerId: LOCAL_PROVIDER, catalog: new LegacyTrackCatalog(rows, LOCAL_PROVIDER, ["main", "kugou-cache"]), source: new LocalMediaSource({ rows, sources: ["main", "kugou-cache"], fingerprints: new LocalFingerprints(db), libraryDir: dir }) },
    // Never opened here: only the catalog side of the KuGou provider is exercised.
    { providerId: KUGOU_PROVIDER, catalog: new LegacyTrackCatalog(rows, KUGOU_PROVIDER, ["kugou-api"]), source: { resolve: async () => { throw new Error("not used"); }, open: async () => { throw new Error("not used"); } } }
  ];
  const getTracks = () =>
    db.prepare("SELECT * FROM tracks ORDER BY id").all().map((row) => ({
      id: row.id, title: row.title, artist: row.artist, album: row.album, filePath: row.file_path, folder: row.folder,
      extension: row.extension, source: row.source, playable: row.playable === 1, size: row.size, addedAt: row.added_at
    }));
  const harness = await startHarness({
    dir,
    db,
    providers,
    writer: new ControlledWriter(),
    tts: new FakeSpeech(),
    radio: new FakeRadio(() => []),
    hooks: { refForLegacyTrack: legacyRefFor },
    legacy: { getTracks, countTracks: () => 3, toLibraryResponse }
  });
  try {
    const library = await harness.request("GET", "/api/library");
    assert.equal(library.status, 200);
    assert.doesNotMatch(JSON.stringify(library.json), /kugou:\/\/|0123456789ABCDEF|song\.wav|missing\.wav/);
    // What a client does: legacy id → server-stated ref, decoded with the shared decoder, never derived.
    const byLegacyId = new Map(library.json.tracks.map((track) => [track.id, decode(trackRefDecoder, track.ref)]));
    assert.deepEqual(byLegacyId.get("legacy-local-1").value, { providerId: "local", mediaId: "legacy-local-1" });
    assert.deepEqual(byLegacyId.get("legacy-kg-1").value, { providerId: "kugou", mediaId: "legacy-kg-1" });
    assert.equal(byLegacyId.get("legacy-orphan").ok, false, "a row no provider serves stays unlinked");
    assert.equal(library.json.tracks.find((track) => track.id === "legacy-orphan").ref, null);

    const search = await harness.request("GET", "/api/v1/catalog/search?q=Song");
    const catalogRefs = search.json.tracks.map((entry) => entry.track);
    for (const id of ["legacy-local-1", "legacy-kg-1"]) {
      assert.ok(catalogRefs.some((ref) => ref.providerId === byLegacyId.get(id).value.providerId && ref.mediaId === byLegacyId.get(id).value.mediaId), `${id}: same ref as the v1 catalog`);
    }
    const resolved = await harness.request("POST", "/api/v1/playback/resolve", {
      protocolVersion: 1,
      itemId: "from-library",
      track: byLegacyId.get("legacy-local-1").value,
      preparationId: null,
      reason: "initial",
      previousRevision: null
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
    assert.deepEqual(resolved.json.media.track, byLegacyId.get("legacy-local-1").value);
  } finally {
    await harness.close({ closeDb: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
