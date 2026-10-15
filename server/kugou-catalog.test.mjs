import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

const { createKuGouCatalogSearchPort, toKuGouApiTrack } = await import("./kugou-catalog.ts");

function expectedId(key) {
  return `kg-${crypto.createHash("sha1").update(key).digest("hex").slice(0, 16)}`;
}

test("KuGou adapter maps provider DTOs and preserves search order", async () => {
  let received;
  const port = createKuGouCatalogSearchPort(async (query, limit) => {
    received = { query, limit };
    return [
      { title: "First", artist: "Artist A", album: "Album A", hash: "hash/one" },
      { title: "Second", sourceId: "source-two" },
      { title: "First", artist: "Artist A", album: "Album A", hash: "hash/one" }
    ];
  });

  const tracks = await port.search("test query", 8);

  assert.deepEqual(received, { query: "test query", limit: 8 });
  assert.deepEqual(tracks.map((item) => item.title), ["First", "Second", "First"]);
  assert.equal(tracks[0].id, expectedId("hash/one"));
  assert.equal(tracks[0].filePath, "kugou://hash%2Fone");
  assert.equal(tracks[0].folder, "KuGou API");
  assert.equal(tracks[0].extension, "remote");
  assert.equal(tracks[0].source, "kugou-api");
  assert.equal(tracks[0].playable, true);
  assert.equal(tracks[0].size, 0);
  assert.equal(Number.isNaN(Date.parse(tracks[0].addedAt)), false);
  assert.equal(tracks[1].id, expectedId("source-two"));
  assert.equal(tracks[1].artist, "Unknown Artist");
  assert.equal(tracks[1].album, "KuGou");
  assert.equal(tracks[2].id, tracks[0].id);
});

test("KuGou adapter keeps fallback identifiers stable", () => {
  const song = { title: "Fallback Song", artist: "Fallback Artist" };
  const first = toKuGouApiTrack(song);
  const second = toKuGouApiTrack(song);
  const key = "fallback artist\nfallback song";

  assert.equal(first.id, expectedId(key));
  assert.equal(second.id, first.id);
  assert.equal(first.filePath, `kugou://${encodeURIComponent(key)}`);
});

test("KuGou adapter propagates raw provider failures", async () => {
  const expected = new Error("raw search failed");
  const port = createKuGouCatalogSearchPort(async () => {
    throw expected;
  });

  await assert.rejects(port.search("test", 8), (error) => error === expected);
});
