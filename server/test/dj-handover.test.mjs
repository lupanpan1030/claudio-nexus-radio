import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { LegacyModelScriptWriter } from "../adapters/legacy/legacy-planning.ts";
import { PlayabilityChecker } from "../application/playability.ts";
import { DEFAULT_PLAYBACK_POLICY } from "../application/policy.ts";
import { formatHandoverContext } from "../dj-handover.ts";
import { ProviderRegistry } from "../ports/providers.ts";
import { ControlledWriter, FakeProvider, FakeRadio, FakeSpeech, fakeTrack } from "../testing/fakes.ts";
import { ManualClock, startHarness } from "../testing/harness.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-dj-handover-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("each cue's writer sees the outgoing track, what actually started (newest first) and earlier generated lines — and it moves along", async () => {
  // A second provider with no legacy rows: the writer still gets real metadata.
  const provider = new FakeProvider("fixture-h");
  const [a, b, c, d] = ["ha", "hb", "hc", "hd"].map((id, index) => provider.add(fakeTrack(id, index + 3, { title: `Title ${id}`, artist: `Artist ${id}` })));
  const writer = new ControlledWriter();
  writer.immediate = "接下来";
  const harness = await startHarness({ dir: fs.mkdtempSync(path.join(root, "case-")), providers: [provider.module()], writer, tts: new FakeSpeech(), radio: new FakeRadio(() => []) });
  const started = async (itemId, media) =>
    harness.request("POST", "/api/v1/playback/started", {
      protocolVersion: 1,
      idempotencyKey: `k-${itemId}`,
      executorInstanceId: "exec",
      itemId,
      track: media.track,
      recordingId: media.recording.recordingId,
      sourceRevision: media.sourceRevision,
      loadId: `load-${itemId}`,
      positionMs: 0,
      startedAt: "2026-10-16T12:00:00.000Z"
    });
  const prepareWithCue = async (itemId, track, from) => {
    const { json } = await harness.request("POST", "/api/v1/playback/prepare", {
      protocolVersion: 1,
      itemId,
      purpose: "program",
      target: { kind: "track", track },
      narration: { transitionId: `tr-${itemId}`, cueId: `cue-${itemId}`, fromItemId: from.itemId, fromTrack: from.track, fromRevision: null },
      wantLyrics: false
    });
    const settled = await harness.request("GET", `/api/v1/playback/preparations/${json.preparationId}?afterVersion=-1&waitMs=2000`);
    let record = settled.json;
    for (let tries = 0; record.status === "active" && tries < 20; tries += 1) {
      record = (await harness.request("GET", `/api/v1/playback/preparations/${json.preparationId}?afterVersion=${record.version}&waitMs=500`)).json;
    }
    assert.equal(record.stages.script.status, "ready");
    return record;
  };
  const titles = (entries) => entries.map((entry) => entry.display.title);
  try {
    for (const [itemId, track] of [["item-a", a], ["item-b", b]]) {
      const media = (await harness.request("POST", "/api/v1/playback/resolve", { protocolVersion: 1, itemId, track, preparationId: null, reason: "initial", previousRevision: null })).json.media;
      await started(itemId, media);
    }
    const third = await prepareWithCue("item-c", c, { itemId: "item-b", track: b });
    const first = writer.requests.at(-1);
    assert.equal(first.from.display.title, "Title hb");
    assert.equal(first.to.display.title, "Title hc");
    assert.equal(first.to.legacyTrackId, null, "no legacy id, yet titled metadata");
    assert.deepEqual(titles(first.recentStarted), ["Title hb", "Title ha"]);
    assert.deepEqual(first.recentGenerated, []);

    await started("item-c", third.stages.source.value);
    await prepareWithCue("item-d", d, { itemId: "item-c", track: c });
    const second = writer.requests.at(-1);
    assert.equal(second.from.display.title, "Title hc");
    assert.deepEqual(titles(second.recentStarted), ["Title hc", "Title hb", "Title ha"], "the history moved on");
    assert.deepEqual(second.recentGenerated, [third.stages.script.value.text], "earlier generated text is offered for de-duplication");
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("the legacy model writer passes from/to metadata and the hand-over history, also for entries without a legacy row", async () => {
  const calls = [];
  const writer = new LegacyModelScriptWriter(async (input) => {
    calls.push(input);
    return { djLine: "好，下一首。" };
  }, () => true);
  const entry = (id, title, legacyTrackId = null) => ({ ref: { providerId: "p", mediaId: id }, display: { title, artist: "歌手", album: "专辑" }, playable: true, legacyTrackId });
  const result = await writer.write({
    to: entry("t", "下一首"),
    from: entry("f", "上一首", "legacy-f"),
    recentStarted: [entry("f", "上一首", "legacy-f"), entry("e", "更早")],
    recentGenerated: ["刚才生成的一句"],
    signal: new AbortController().signal
  });
  assert.equal(result.text, "好，下一首。");
  assert.deepEqual(calls[0].track, { legacyTrackId: null, title: "下一首", artist: "歌手", album: "专辑" });
  assert.deepEqual(calls[0].handover, {
    from: { title: "上一首", artist: "歌手", album: "专辑" },
    recentStarted: [
      { title: "上一首", artist: "歌手", album: "专辑" },
      { title: "更早", artist: "歌手", album: "专辑" }
    ],
    recentGenerated: ["刚才生成的一句"]
  });
  assert.equal(calls[0].dryRun, true);
});

test("the hand-over block labels started tracks as played and generated lines as not necessarily aired", () => {
  const text = formatHandoverContext({
    from: { title: "旧歌", artist: "甲" },
    recentStarted: [{ title: "旧歌", artist: "甲" }, { title: "更旧", artist: "乙", album: "专" }],
    recentGenerated: ["  一句\n已经生成  ", "x".repeat(300)]
  });
  assert.match(text, /上一首（正在结束）：甲《旧歌》/);
  assert.match(text, /最近实际播放过（新→旧）：\n- 甲《旧歌》\n- 乙《更旧》（专辑：专）/);
  assert.match(text, /不代表已经播出/);
  assert.match(text, /- 一句 已经生成\n/);
  assert.ok(text.includes(`${"x".repeat(120)}…`), "long lines are clipped");
  assert.equal(formatHandoverContext({ from: null, recentStarted: [], recentGenerated: [] }), "");
});

test("list playability: catalog first, cheap provider checks every time, otherwise a briefly remembered resolve keyed by provider scope", async () => {
  const clock = new ManualClock();
  const cheap = new FakeProvider("cheap");
  const cheapRef = cheap.add(fakeTrack("c1", 3));
  let cheapChecks = 0;
  cheap.checkPlayable = async () => ((cheapChecks += 1), true);
  const remote = new FakeProvider("remote");
  const remoteRef = remote.add(fakeTrack("r1", 4));
  const hiddenRef = remote.add(fakeTrack("r2", 5, { playable: false }));
  let account = "u1";
  remote.playabilityScope = () => account;
  const checker = new PlayabilityChecker({ providers: new ProviderRegistry([cheap.module(), remote.module()]), clock, policy: DEFAULT_PLAYBACK_POLICY });
  const signal = () => new AbortController().signal;

  assert.equal(await checker.check(cheapRef, signal()), true);
  assert.equal(await checker.check(cheapRef, signal()), true);
  assert.equal(cheapChecks, 2, "cheap checks are not memoized (they follow the file)");
  assert.equal(cheap.resolveCalls, 0, "no hashing resolve for list filtering");

  assert.equal(await checker.check(hiddenRef, signal()), false);
  assert.equal(remote.resolveCalls, 0, "a catalog row marked unplayable is never resolved");

  const together = await Promise.all([checker.check(remoteRef, signal()), checker.check(remoteRef, signal()), checker.check(remoteRef, signal())]);
  assert.deepEqual(together, [true, true, true]);
  assert.equal(remote.resolveCalls, 1, "concurrent checks share one resolve");
  assert.equal(await checker.check(remoteRef, signal()), true);
  assert.equal(remote.resolveCalls, 1, "remembered");
  account = "u2";
  assert.equal(await checker.check(remoteRef, signal()), true);
  assert.equal(remote.resolveCalls, 2, "another account is another answer");
  clock.advance(DEFAULT_PLAYBACK_POLICY.playabilityMemoMs + 1);
  remote.tracks.delete("r1");
  assert.equal(await checker.check(remoteRef, signal()), false, "catalog no longer describes it");
  remote.add(fakeTrack("r1", 4));
  const failing = remote.resolve.bind(remote);
  remote.resolve = async () => {
    throw new Error("upstream down");
  };
  assert.equal(await checker.check(remoteRef, signal()), false);
  remote.resolve = failing;
  assert.equal(await checker.check(remoteRef, signal()), false, "a failure is remembered briefly");
  clock.advance(DEFAULT_PLAYBACK_POLICY.playabilityNegativeMemoMs + 1);
  assert.equal(await checker.check(remoteRef, signal()), true, "then asked again");
});
