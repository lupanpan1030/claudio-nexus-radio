import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { directTrackPick, resolveDirectTrack } = await import("./direct.ts");

function track(overrides = {}) {
  return {
    id: "catalog-track",
    title: "My Soul",
    artist: "July",
    album: "My Soul",
    filePath: "provider://opaque-locator",
    folder: "provider-internal",
    extension: "remote",
    source: "main",
    playable: true,
    size: 0,
    addedAt: "2026-08-15T00:00:00.000Z",
    ...overrides
  };
}

function catalog(search) {
  return { search };
}

test("direct requests resolve from normalized application track records", async () => {
  let receivedQuery = "";
  let receivedLimit = 0;
  const result = await resolveDirectTrack("播放 My Soul", catalog(async (query, limit) => {
    receivedQuery = query;
    receivedLimit = limit;
    return [
      track({
        id: "first-version",
        title: "My Soul (忧伤还是快乐)",
        artist: "July",
        album: "My Soul"
      }),
      track({
        id: "duplicate-version",
        title: "My Soul (忧伤还是快乐)",
        artist: "July",
        album: "Another Album"
      }),
      track({
        id: "unrelated-result",
        title: "July",
        artist: "July"
      })
    ];
  }));

  assert.equal(receivedQuery, "My Soul");
  assert.equal(receivedLimit, 8);
  assert.equal(result.reason, "matched");
  assert.equal(result.match?.id, "first-version");
  assert.match(result.match?.artist ?? "", /July/i);
});

test("API search keeps the provider's first version when the title suffix is only descriptive", async () => {
  const result = await resolveDirectTrack("播放 My Soul", catalog(async () => [
    track({ id: "july-my-soul", title: "My Soul (忧伤还是快乐)", artist: "July" }),
    track({ id: "zhang-my-soul", title: "My Soul", artist: "张新成" })
  ]));

  assert.equal(result.reason, "matched");
  assert.match(result.match?.artist ?? "", /July/i);
});

test("next-track wording still resolves through the API search path", async () => {
  let receivedQuery = "";
  const result = await resolveDirectTrack("下一首播放 遇见", catalog(async (query) => {
    receivedQuery = query;
    return [track({ id: "encounter", title: "遇见", artist: "孙燕姿" })];
  }));

  assert.equal(receivedQuery, "遇见");
  assert.equal(result.reason, "matched");
  assert.match(result.match?.artist ?? "", /孙燕姿/);
});

test("catalog failures are reported without a provider fallback", async () => {
  const result = await resolveDirectTrack("播放 My Soul", catalog(async () => {
    throw new Error("provider unavailable");
  }));

  assert.equal(result.reason, "api-unavailable");
  assert.equal(result.match, undefined);
  assert.deepEqual(result.candidates, []);
});

test("non-direct requests never call the catalog", async () => {
  let calls = 0;
  const result = await resolveDirectTrack("推荐适合工作的歌单", catalog(async () => {
    calls += 1;
    return [];
  }));

  assert.equal(calls, 0);
  assert.equal(result.reason, "no-intent");
});

test("current composition preserves the existing KuGou audit reason without coupling the core", async () => {
  const pick = directTrackPick(track(), "KuGou API");
  const source = await readFile(new URL("./direct.ts", import.meta.url), "utf8");
  const chatSource = await readFile(new URL("./chat.ts", import.meta.url), "utf8");

  assert.equal(pick.reason, "KuGou API direct match: July - My Soul");
  assert.equal(pick.decision?.reason, pick.reason);
  assert.doesNotMatch(source, /kugou|酷狗/i);
  assert.match(chatSource, /directTrackPick\(track, "KuGou API"\)/);
});
