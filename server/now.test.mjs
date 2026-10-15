import assert from "node:assert/strict";
import test from "node:test";

const { getNowPlayingSnapshot, updateNowPlayingSnapshot } = await import("./now.ts");

test("now-playing projection keeps provider source without leaking private track fields", () => {
  updateNowPlayingSnapshot({
    currentTrack: {
      id: "remote-track",
      title: "Remote Track",
      artist: "Remote Artist",
      album: "Remote Album",
      extension: "remote",
      source: "kugou-api",
      playable: true,
      filePath: "kugou://private-hash",
      folder: "private/folder",
      size: 999
    }
  });

  const track = getNowPlayingSnapshot().currentTrack;
  assert.equal(track?.source, "kugou-api");
  assert.deepEqual(Object.keys(track ?? {}).sort(), ["album", "artist", "extension", "id", "playable", "source", "title"]);
  assert.doesNotMatch(JSON.stringify(track), /private-hash|private\/folder/);
});
