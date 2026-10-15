import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { appError } from "../application/errors.ts";
import { ControlledWriter, FakeProvider, FakeRadio, FakeSpeech, fakeTrack } from "../testing/fakes.ts";
import { ManualClock, startHarness } from "../testing/harness.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudio-binding-scrub-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const URL_TTL = 20 * 60_000;

/** A provider whose bindings carry a short-lived signed URL next to the content evidence that proves continuity. */
class SignedUrlProvider extends FakeProvider {
  constructor(providerId, clock) {
    super(providerId);
    this.clock = clock;
    this.issued = 0;
  }
  async resolve(ref, context) {
    const resolved = await super.resolve(ref, context);
    this.issued += 1;
    return { ...resolved, expiresAt: this.clock.now() + URL_TTL, binding: { ...resolved.binding, signedUrl: `https://cdn.example/a?sig=${this.issued}` } };
  }
  scrubBinding(binding) {
    if (binding.scrubbed) return null;
    const { signedUrl: _dropped, ...kept } = binding;
    return { ...kept, scrubbed: true };
  }
  async open(binding, request) {
    if (binding.scrubbed) throw appError("expired", "signed_url_scrubbed");
    return super.open(binding, request);
  }
}

const lrc = { format: "lrc", text: "[00:00.50]第一句\n[00:01.00]第二句\n" };

function row(db, revision) {
  const found = db.prepare("SELECT * FROM playback_resolved_sources WHERE source_revision = ?").get(revision);
  return found ? { ...found, binding: JSON.parse(found.binding_json) } : null;
}

test("expired private binding data is erased unless something still uses it; identity rows stay and refresh keeps continuity", async () => {
  const clock = new ManualClock();
  const provider = new SignedUrlProvider("fixture-s", clock);
  const [a, b, c] = ["x1", "x2", "x3"].map((id, index) => provider.add(fakeTrack(id, index + 3, { lyrics: lrc })));
  const harness = await startHarness({
    dir: fs.mkdtempSync(path.join(root, "case-")),
    providers: [provider.module()],
    writer: new ControlledWriter(),
    tts: new FakeSpeech(),
    radio: new FakeRadio(() => []),
    clock
  });
  const resolve = (itemId, track, previousRevision = null) =>
    harness.request("POST", "/api/v1/playback/resolve", {
      protocolVersion: 1,
      itemId,
      track,
      preparationId: null,
      reason: previousRevision ? "refresh" : "initial",
      previousRevision
    });
  const startedBody = (key, itemId, media) => ({
    protocolVersion: 1,
    idempotencyKey: key,
    executorInstanceId: "exec",
    itemId,
    track: media.track,
    recordingId: media.recording.recordingId,
    sourceRevision: media.sourceRevision,
    loadId: `load-${key}`,
    positionMs: 0,
    startedAt: "2026-10-16T12:00:00.000Z"
  });
  try {
    const played = (await resolve("item-1", a)).json.media;
    assert.equal((await harness.request("POST", "/api/v1/playback/started", startedBody("k1", "item-1", played))).status, 200);
    const prepared = (
      await harness.request("POST", "/api/v1/playback/prepare", {
        protocolVersion: 1,
        itemId: "item-2",
        purpose: "program",
        target: { kind: "track", track: b },
        narration: null,
        wantLyrics: false
      })
    ).json;
    const current = prepared.stages.source.value;
    const held = (await resolve("item-3", c)).json.media;
    // A handle still retained (e.g. a long-paused load) on the third revision.
    harness.assembly.stores.handles.insert({
      token: "held-token",
      kind: "media",
      providerId: "fixture-s",
      sourceRevision: held.sourceRevision,
      binding: row(harness.db, held.sourceRevision).binding,
      expiresAt: clock.now() + URL_TTL,
      retainUntil: clock.now() + 365 * 24 * 3600_000,
      createdAt: clock.now()
    });

    // Before the deadline plus the stream grace nothing is touched.
    clock.advance(URL_TTL + 60_000);
    assert.equal(harness.assembly.gc.run().scrubbedBindings, 0);

    clock.advance(3 * 3600_000);
    await harness.request("PUT", "/api/v1/now", {
      protocolVersion: 1,
      executorInstanceId: "exec",
      generation: 1,
      seq: 1,
      observedAt: "2026-10-16T15:30:00.000Z",
      transport: "paused",
      item: { itemId: "item-2", track: b, display: null },
      positionMs: 1000,
      nextItemId: null,
      speaking: false
    });
    const report = harness.assembly.gc.run();
    assert.equal(report.scrubbedBindings, 1, "only the unused revision is scrubbed");

    const scrubbed = row(harness.db, played.sourceRevision);
    assert.equal(scrubbed.binding.signedUrl, undefined, "the signed URL is gone");
    assert.equal(scrubbed.binding.scrubbed, true);
    assert.ok(scrubbed.binding.hash, "continuity evidence stays");
    assert.equal(scrubbed.recording_id, played.recording.recordingId, "the identity row stays");
    assert.equal(scrubbed.binding_scrubbed_at, clock.now());
    assert.ok(row(harness.db, current.sourceRevision).binding.signedUrl, "the executor's current item is protected");
    assert.ok(row(harness.db, held.sourceRevision).binding.signedUrl, "a retained handle protects its revision");
    assert.equal(harness.assembly.gc.run().scrubbedBindings, 0, "nothing is scrubbed twice");

    // History and lyrics still verify against the kept identity.
    const again = await harness.request("POST", "/api/v1/playback/started", startedBody("k2", "item-1b", played));
    assert.equal(again.json.status, "recorded");
    assert.equal(harness.db.prepare("SELECT source_verified FROM playback_started WHERE idempotency_key = 'k2'").get().source_verified, 1);
    const lyrics = await harness.request("POST", "/api/v1/playback/lyrics", {
      protocolVersion: 1,
      itemId: "item-1b",
      track: played.track,
      recordingId: played.recording.recordingId,
      sourceRevision: played.sourceRevision
    });
    assert.equal(lyrics.json.result.status, "available");

    // A refresh from the scrubbed revision proves the same recording again and restores a usable binding.
    const refreshed = await resolve("item-1b", a, played.sourceRevision);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.json.media.sourceRevision, played.sourceRevision);
    const restored = row(harness.db, played.sourceRevision);
    assert.ok(restored.binding.signedUrl);
    assert.equal(restored.binding_scrubbed_at, null);
    const stream = await fetch(`${harness.baseUrl}${refreshed.json.media.stream.handle}`);
    assert.equal(stream.status, 200);
    await stream.arrayBuffer();
  } finally {
    await harness.close({ closeDb: true });
  }
});

test("the scrub scan moves past records that stay protected: later expired bindings are erased, protected ones kept, each run bounded", async () => {
  const clock = new ManualClock();
  const provider = new SignedUrlProvider("fixture-g", clock);
  // Every resolution is a new revision, so one ref accumulates many rows.
  const [current, victim, next, late] = ["g1", "g2", "g3", "g4"].map((id, index) => provider.add(fakeTrack(id, index + 3, { continuityUnprovable: true })));
  const harness = await startHarness({
    dir: fs.mkdtempSync(path.join(root, "case-")),
    providers: [provider.module()],
    writer: new ControlledWriter(),
    tts: new FakeSpeech(),
    radio: new FakeRadio(() => []),
    clock
  });
  const store = harness.assembly.stores.resolvedSources;
  const pages = [];
  const list = store.listScrubbable.bind(store);
  store.listScrubbable = (...args) => {
    const page = list(...args);
    pages.push({ limit: args[2], rows: page.length });
    return page;
  };
  const resolve = async (itemId, track) => {
    const response = await harness.request("POST", "/api/v1/playback/resolve", { protocolVersion: 1, itemId, track, preparationId: null, reason: "initial", previousRevision: null });
    assert.equal(response.status, 200);
    clock.advance(1);
    return response.json.media.sourceRevision;
  };
  const projection = (seq, item, nextItemId) => ({
    protocolVersion: 1,
    executorInstanceId: "exec",
    generation: 1,
    seq,
    observedAt: new Date(clock.now()).toISOString(),
    transport: item ? "paused" : "idle",
    item,
    positionMs: item ? 0 : null,
    nextItemId,
    speaking: false
  });
  const signed = (revision) => Boolean(row(harness.db, revision).binding.signedUrl);
  const run = () => {
    const before = pages.length;
    const report = harness.assembly.gc.run();
    assert.equal(pages.length - before, 1, "one bounded page per run");
    return { scrubbed: report.scrubbedBindings, examined: pages.at(-1).rows };
  };
  try {
    // The oldest full page belongs to the executor's current ref; unprotected and next-item rows come after it.
    const currentRevisions = [];
    for (let index = 0; index < 200; index += 1) currentRevisions.push(await resolve(`cur-${index}`, current));
    const victimRevision = await resolve("victim", victim);
    const prepared = await harness.request("POST", "/api/v1/playback/prepare", {
      protocolVersion: 1,
      itemId: "item-next",
      purpose: "program",
      target: { kind: "track", track: next },
      narration: null,
      wantLyrics: false
    });
    const nextRevision = prepared.json.stages.source.value.sourceRevision;
    clock.advance(1);
    const lateRevision = await resolve("late", late);
    const now = projection(1, { itemId: "cur-199", track: current, display: null }, "item-next");
    assert.equal((await harness.request("PUT", "/api/v1/now", now)).status, 200);
    clock.advance(24 * 3600_000);

    assert.deepEqual(run(), { scrubbed: 0, examined: 200 }, "the first page is all protected");
    assert.deepEqual(run(), { scrubbed: 2, examined: 3 }, "the next run continues after it instead of re-reading it");
    assert.equal(signed(victimRevision), false);
    assert.equal(signed(lateRevision), false);
    assert.ok(currentRevisions.every(signed), "every revision of the current ref keeps its binding");
    assert.ok(signed(nextRevision), "the next item keeps its binding");
    assert.deepEqual(run(), { scrubbed: 0, examined: 200 }, "having reached the end, the scan starts over");
    assert.deepEqual(run(), { scrubbed: 0, examined: 1 });
    assert.ok(pages.every((page) => page.limit === 200 && page.rows <= 200));

    // Once nothing references them any more, the protected rows are erased in later bounded runs.
    assert.equal((await harness.request("PUT", "/api/v1/now", projection(2, null, null))).status, 200);
    assert.deepEqual(run(), { scrubbed: 200, examined: 200 });
    assert.deepEqual(run(), { scrubbed: 1, examined: 1 });
    assert.deepEqual(run(), { scrubbed: 0, examined: 0 });
    assert.ok(!currentRevisions.some(signed) && !signed(nextRevision));
    assert.equal(harness.db.prepare("SELECT COUNT(*) AS n FROM playback_resolved_sources").get().n, 203, "identity rows stay");
  } finally {
    await harness.close({ closeDb: true });
  }
});
