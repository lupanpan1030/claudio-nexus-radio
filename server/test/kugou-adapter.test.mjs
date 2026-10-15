import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { KuGouClient } from "../adapters/kugou/client.ts";
import { KuGouLyrics, KuGouMediaSource } from "../adapters/kugou/kugou-source.ts";
import { runMigrations } from "../adapters/sqlite/migrations.ts";
import { TrackRowReader } from "../adapters/sqlite/track-catalog.ts";
import { makeWav } from "../testing/wav.ts";

// A local stand-in for the KuGouMusicApi service: no real account, no real endpoint.
const HASH = "0123456789ABCDEF0123456789ABCDEF";
const SEARCHED = "FEDCBA9876543210FEDCBA9876543210";
const audio = makeWav(1500, { seed: 6 });
const upstream = { servedHash: HASH, urlCalls: 0, audioStatus: 200, requests: [] };
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    upstream.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), cookie: req.headers.cookie ?? null });
    const json = (body) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/song/url") {
      upstream.urlCalls += 1;
      if (url.searchParams.get("quality") === "320") return json({ status: 0, error_code: 2 });
      return json({ status: 1, url: [`${base}/audio/${url.searchParams.get("hash")}?sig=${upstream.urlCalls}`], hash: upstream.servedHash });
    }
    if (url.pathname === "/search/lyric") return json({ candidates: [{ id: 77, accesskey: "AK", duration: 1500 }] });
    if (url.pathname === "/lyric") {
      return json(url.searchParams.get("fmt") === "krc" ? { decodeContent: "[1000,800]<0,400,0>新<400,400,0>歌\n" } : {});
    }
    if (url.pathname.startsWith("/audio/")) {
      if (upstream.audioStatus !== 200) {
        res.statusCode = upstream.audioStatus;
        return res.end();
      }
      const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
      res.setHeader("content-type", "audio/wav");
      res.setHeader("accept-ranges", "bytes");
      if (range) {
        const [start, end] = [Number(range[1]), Number(range[2])];
        res.statusCode = 206;
        res.setHeader("content-range", `bytes ${start}-${end}/${audio.length}`);
        return res.end(Buffer.from(audio.subarray(start, end + 1)));
      }
      return res.end(Buffer.from(audio));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function build({ credentials = null, searchHits = [] } = {}) {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const insert = db.prepare(
    "INSERT INTO tracks (id, title, artist, album, file_path, folder, extension, source, playable, size, added_at) VALUES (?, ?, ?, 'KuGou', ?, 'KuGou API', 'remote', 'kugou-api', 1, 0, 'now')"
  );
  insert.run("kg-hash", "Song", "Artist", `kugou://${HASH}`);
  insert.run("kg-name", "Named", "Singer", `kugou://${encodeURIComponent("Singer\nNamed")}`);
  const state = { credentials };
  const client = new KuGouClient({ baseUrl: base, credentials: () => state.credentials });
  const source = new KuGouMediaSource({
    rows: new TrackRowReader(db),
    client,
    search: async () => searchHits,
    score: (wanted, hit) => (hit.title === wanted.title && hit.artist === wanted.artist ? 100 : 10),
    urlTtlMs: 60_000,
    clock: { now: () => 1_000 }
  });
  return { source, client, state, lyrics: new KuGouLyrics(client) };
}

const ctx = (previous = null) => ({ signal: new AbortController().signal, reason: previous ? "refresh" : "initial", previous });
const ref = (mediaId) => ({ providerId: "kugou", mediaId });

test("the synced hash is the recording; refreshing the signed URL keeps the revision", async () => {
  upstream.servedHash = HASH;
  const { source } = build();
  const first = await source.resolve(ref("kg-hash"), ctx());
  assert.deepEqual(first.recording, { recordingId: `kugou:${HASH}`, confidence: "provider-asserted" });
  assert.match(first.sourceRevision, /^kg-[0-9a-f]{40}$/);
  assert.equal(first.expiresAt, 61_000);
  assert.deepEqual(first.duration, { kind: "unknown" }, "no unverified length field is trusted");
  const refreshed = await source.resolve(ref("kg-hash"), ctx({ sourceRevision: first.sourceRevision, binding: first.binding }));
  assert.notEqual(refreshed.binding.url, first.binding.url, "a new signed URL");
  assert.equal(refreshed.sourceRevision, first.sourceRevision);
  upstream.servedHash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const other = await source.resolve(ref("kg-hash"), ctx({ sourceRevision: first.sourceRevision, binding: first.binding }));
  assert.notEqual(other.sourceRevision, first.sourceRevision, "a different served file is a different revision");
  upstream.servedHash = HASH;
});

test("streams proxy exactly the bound URL with Range; failures and account changes never fall back", async () => {
  upstream.audioStatus = 200;
  const credentials = { cookie: "token=abc", userid: "u1", loggedInAt: "2026-10-16T00:00:00Z" };
  const { source, state } = build({ credentials });
  const resolved = await source.resolve(ref("kg-hash"), ctx());
  assert.equal(upstream.requests.filter((item) => item.path === "/song/url").at(-1).cookie, "token=abc", "signed-in source first");
  const stream = await source.open(resolved.binding, { range: "bytes=0-43", signal: new AbortController().signal });
  assert.equal(stream.status, 206);
  assert.equal(stream.headers["content-range"], `bytes 0-43/${audio.length}`);
  let bytes = 0;
  for await (const chunk of stream.body) bytes += chunk.length;
  assert.equal(bytes, 44);

  upstream.audioStatus = 403;
  await assert.rejects(source.open(resolved.binding, { range: null, signal: new AbortController().signal }), (error) => error.info.class === "expired");
  upstream.audioStatus = 200;
  state.credentials = { ...credentials, userid: "u2" };
  await assert.rejects(source.open(resolved.binding, { range: null, signal: new AbortController().signal }), (error) => error.info.code === "kugou_account_changed");
});

test("a row without a hash can only be matched by search, and is marked unverified", async () => {
  const { source } = build({ searchHits: [{ title: "Named", artist: "Singer", hash: SEARCHED }] });
  const resolved = await source.resolve(ref("kg-name"), ctx());
  assert.deepEqual(resolved.recording, { recordingId: `kugou:${SEARCHED}`, confidence: "unverified" });
  const weak = build({ searchHits: [{ title: "Other", artist: "Singer", hash: SEARCHED }] });
  await assert.rejects(weak.source.resolve(ref("kg-name"), ctx()), (error) => error.info.code === "kugou_no_match");
});

test("lyrics are looked up by the bound hash only, keep provider word timing, and refuse a duration mismatch", async () => {
  const { source, lyrics } = build();
  const resolved = await source.resolve(ref("kg-hash"), ctx());
  const lookup = { recording: resolved.recording, sourceRevision: resolved.sourceRevision, duration: { kind: "unknown" }, binding: resolved.binding };
  const raw = await lyrics.fetch(lookup, { signal: new AbortController().signal });
  assert.deepEqual(raw, { kind: "text", format: "krc", text: "[1000,800]<0,400,0>新<400,400,0>歌\n", documentKey: "kugou-lyric:77:krc" });
  const search = upstream.requests.filter((item) => item.path === "/search/lyric").at(-1);
  assert.equal(search.query.hash, HASH);
  assert.equal(search.query.keywords, undefined, "never searched by title");
  const mismatch = await lyrics.fetch({ ...lookup, duration: { kind: "known", ms: 200_000, source: "media-element" } }, { signal: new AbortController().signal });
  assert.deepEqual(mismatch, { kind: "unmatched" });
});

test("login-required responses are classified for the caller", async () => {
  const client = new KuGouClient({ baseUrl: base, credentials: () => null });
  await assert.rejects(client.get("/song/url", {}, { auth: true, signal: new AbortController().signal }), (error) => error.info.class === "auth-required");
  const unreachable = new KuGouClient({ baseUrl: "http://127.0.0.1:9", credentials: () => null });
  await assert.rejects(unreachable.get("/x", {}, { auth: false, signal: new AbortController().signal }), (error) => error.info.code === "kugou_unreachable");
});
