import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import zlib from "node:zlib";
import { decode, lyricsAvailabilityDecoder } from "@claudio/contracts";
import { KuGouClient } from "../adapters/kugou/client.ts";
import { KuGouLyrics } from "../adapters/kugou/kugou-source.ts";
import { LocalServiceStarter } from "../adapters/runtime/local-service.ts";
import { toAvailability } from "../application/lyrics/lyrics-service.ts";

// ---------------------------------------------------------------------------
// The bundled KuGouMusicApi's own /search/lyric and /lyric modules, run
// unmodified with their outbound HTTP (useAxios) mocked: no account, no network.
const UPSTREAM_DIR = process.env.CLAUDIO_KUGOU_API_REVIEWED_DIR ?? "/tmp/claudio-implementation-20261016/kugou-api-reviewed";
const UPSTREAM_HEAD = "06560e3e053bda1ab830750db6f645bab703f824";

function upstreamAvailable() {
  if (!fs.existsSync(path.join(UPSTREAM_DIR, "module/lyric.js"))) return `upstream clone not found at ${UPSTREAM_DIR}`;
  const head = spawnSync("git", ["-C", UPSTREAM_DIR, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  return head === UPSTREAM_HEAD ? null : `upstream clone is at ${head}, not the reviewed ${UPSTREAM_HEAD}`;
}

/** CommonJS loader with an explicit require allowlist (third-party packages replaced by stand-ins). */
function loadCommonJs(file, shims) {
  const module = { exports: {} };
  const wrapper = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${fs.readFileSync(file, "utf8")}\n})`, { filename: file });
  wrapper(module.exports, (id) => {
    if (id in shims) return shims[id];
    throw new Error(`unexpected require("${id}") from ${file}`);
  }, module, file, path.dirname(file));
  return module.exports;
}

function upstreamModules() {
  // pako.inflate on zlib data is zlib inflate; crypto-js/big-integer are only used by unrelated helpers.
  const util = loadCommonJs(path.join(UPSTREAM_DIR, "util/util.js"), {
    pako: { inflate: (bytes) => new Uint8Array(zlib.inflateSync(Buffer.from(bytes))) },
    "crypto-js": {},
    "big-integer": () => assert.fail("not used")
  });
  const config = JSON.parse(fs.readFileSync(path.join(UPSTREAM_DIR, "util/config.json"), "utf8"));
  const shared = { decodeLyrics: util.decodeLyrics, appid: config.liteAppid, clientver: config.liteClientver };
  return {
    lyric: loadCommonJs(path.join(UPSTREAM_DIR, "module/lyric.js"), { "../util": shared }),
    searchLyric: loadCommonJs(path.join(UPSTREAM_DIR, "module/search_lyric.js"), { "../util": shared })
  };
}

/** Encodes text the way a KRC download carries it: "krc1" header + XOR-ed zlib stream, base64. */
function encodeKrc(text) {
  const key = [64, 71, 97, 119, 94, 50, 116, 71, 81, 54, 49, 45, 206, 210, 110, 105];
  const deflated = zlib.deflateSync(Buffer.from(text, "utf8"));
  const xored = Buffer.from(deflated.map((byte, index) => byte ^ key[index % key.length]));
  return Buffer.concat([Buffer.from("krc1"), xored]).toString("base64");
}

/**
 * Plays the bundled server: query → module(query, useAxios) → JSON body.
 * `remote(upstreamPath, params)` stands in for lyrics.kugou.com and returns its body.
 */
function upstreamFetch(modules, remote, calls) {
  return async (input) => {
    const url = new URL(String(input));
    const query = { cookie: {}, ...Object.fromEntries(url.searchParams) };
    const module = url.pathname === "/lyric" ? modules.lyric : url.pathname === "/search/lyric" ? modules.searchLyric : null;
    if (!module) return new Response(JSON.stringify({ code: 404 }), { status: 404 });
    const answer = await module(query, async (config) => {
      calls.push({ path: url.pathname, url: config.url, params: config.params });
      return { status: 200, body: remote(config.url, config.params), cookie: [], headers: {} };
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  };
}

const binding = { hash: "0123456789ABCDEF0123456789ABCDEF", url: "https://cdn.invalid/a.mp3", confidence: "provider-asserted", accountRevision: null, fetchedAt: 0 };
const lookup = { recording: { recordingId: "kugou:0123456789ABCDEF0123456789ABCDEF", confidence: "provider-asserted" }, sourceRevision: "kg-x", duration: { kind: "unknown" }, binding };
const signal = () => new AbortController().signal;
const KRC = "[id:$00000000]\n[1000,800]<0,400,0>新<400,400,0>歌\n[2000,600]<0,600,0>来\n";
const LRC = "[00:01.00]新歌\n[00:02.00]来\n";

test("upstream /lyric: a contenttype-0 KRC download is decoded by upstream and accepted as KRC", async (t) => {
  const missing = upstreamAvailable();
  if (missing) return t.skip(missing);
  const calls = [];
  const fetch = upstreamFetch(upstreamModules(), (pathname) =>
    pathname === "/v1/search"
      ? { status: 200, candidates: [{ id: "77", accesskey: "AK" }] }
      : { status: 200, fmt: "krc", contenttype: 0, content: encodeKrc(KRC) }
  , calls);
  const lyrics = new KuGouLyrics(new KuGouClient({ baseUrl: "http://bundled.invalid", credentials: () => null, fetch }));
  const raw = await lyrics.fetch(lookup, { signal: signal() });
  assert.deepEqual(raw, { kind: "text", format: "krc", text: KRC, documentKey: "kugou-lyric:77:krc" });
  assert.deepEqual(calls[0].params.hash, binding.hash, "upstream search got the bound hash");
  assert.equal(calls[0].params.keyword, "", "and no title");
  assert.deepEqual([calls[1].url, calls[1].params.fmt, calls[1].params.id, calls[1].params.accesskey], ["/download", "krc", "77", "AK"]);
  const availability = toAvailability({ sourceRevision: "kg-x", recordingId: lookup.recording.recordingId }, raw);
  assert.equal(availability.asset.timing, "native-word");
  assert.ok(decode(lyricsAvailabilityDecoder, availability).ok);
});

test("upstream /lyric: fmt=krc with contenttype≠0 returns decoded LRC, which is labelled LRC (never KRC)", async (t) => {
  const missing = upstreamAvailable();
  if (missing) return t.skip(missing);
  const calls = [];
  const fetch = upstreamFetch(upstreamModules(), (pathname) =>
    pathname === "/v1/search"
      ? { status: 200, candidates: [{ id: "78", accesskey: "AK" }] }
      : { status: 200, fmt: "lrc", contenttype: 2, content: Buffer.from(LRC).toString("base64") }
  , calls);
  const lyrics = new KuGouLyrics(new KuGouClient({ baseUrl: "http://bundled.invalid", credentials: () => null, fetch }));
  const raw = await lyrics.fetch(lookup, { signal: signal() });
  assert.equal(calls.filter((call) => call.url === "/download").length, 1, "accepted on the first (krc) request");
  assert.equal(calls[1].params.fmt, "krc");
  assert.deepEqual(raw, { kind: "text", format: "lrc", text: LRC, documentKey: "kugou-lyric:78:lrc" });
  const availability = toAvailability({ sourceRevision: "kg-x", recordingId: lookup.recording.recordingId }, raw);
  assert.equal(availability.asset.timing, "native-line");
  assert.deepEqual(availability.asset.lines.map((line) => line.text), ["新歌", "来"]);
});

test("upstream /lyric: unrecognisable or empty content is not accepted under any label", async (t) => {
  const missing = upstreamAvailable();
  if (missing) return t.skip(missing);
  const calls = [];
  const fetch = upstreamFetch(upstreamModules(), (pathname, params) =>
    pathname === "/v1/search"
      ? { status: 200, candidates: [{ id: "79", accesskey: "AK" }] }
      : params.fmt === "krc"
        ? { status: 200, contenttype: 1, content: Buffer.from([0xff, 0x00, 0x13, 0x37]).toString("base64") }
        : { status: 200, contenttype: 0, content: Buffer.from("not krc").toString("base64") }
  , calls);
  const lyrics = new KuGouLyrics(new KuGouClient({ baseUrl: "http://bundled.invalid", credentials: () => null, fetch }));
  assert.deepEqual(await lyrics.fetch(lookup, { signal: signal() }), { kind: "missing", reason: "not-found" });
  assert.deepEqual(calls.filter((call) => call.url === "/download").map((call) => call.params.fmt), ["krc", "lrc"]);
});

// ---------------------------------------------------------------------------
// Bundled-service autostart seam: fake readiness only, nothing is spawned.

function fakeService({ enabled = true, bootsAfterPolls = 1, launchable = true } = {}) {
  const state = { up: false, launches: 0, probes: 0, polls: 0 };
  const starter = new LocalServiceStarter({
    enabled,
    probe: async () => {
      state.probes += 1;
      if (state.launches > 0) state.polls += 1;
      if (state.launches > 0 && state.polls > bootsAfterPolls) state.up = true;
      return state.up;
    },
    launch: () => {
      if (!launchable) return false;
      state.launches += 1;
      return true;
    },
    bootDeadlineMs: 200,
    pollMs: 5,
    retryAfterMs: 60_000
  });
  const fetch = async () => {
    if (!state.up) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  };
  return { state, starter, fetch };
}

test("an unreachable bundled API is started once for concurrent requests, then the request is retried", async () => {
  const fx = fakeService({ bootsAfterPolls: 2 });
  const client = new KuGouClient({ baseUrl: "http://127.0.0.1:3400", credentials: () => null, fetch: fx.fetch, ensureReady: (s) => fx.starter.ensure(s) });
  const results = await Promise.all(Array.from({ length: 5 }, () => client.get("/song/url", { hash: "x" }, { auth: false, signal: signal() })));
  assert.deepEqual(results, Array(5).fill({ ok: 1 }));
  assert.equal(fx.state.launches, 1, "one launch for five concurrent requests");
  assert.equal(fx.starter.launches, 1);
  await client.get("/song/url", {}, { auth: false, signal: signal() });
  assert.equal(fx.state.launches, 1, "a reachable service is not started again");
});

test("autostart disabled never probes or launches; the request fails as unreachable", async () => {
  const fx = fakeService({ enabled: false });
  const client = new KuGouClient({ baseUrl: "http://127.0.0.1:3400", credentials: () => null, fetch: fx.fetch, ensureReady: (s) => fx.starter.ensure(s) });
  await assert.rejects(client.get("/song/url", {}, { auth: false, signal: signal() }), (error) => error.info.code === "kugou_unreachable");
  assert.deepEqual([fx.state.probes, fx.state.launches], [0, 0]);
});

test("a start that never becomes ready ends within its deadline and is not retried immediately", async () => {
  const fx = fakeService({ bootsAfterPolls: Number.POSITIVE_INFINITY });
  const client = new KuGouClient({ baseUrl: "http://127.0.0.1:3400", credentials: () => null, fetch: fx.fetch, ensureReady: (s) => fx.starter.ensure(s) });
  const began = Date.now();
  await assert.rejects(client.get("/x", {}, { auth: false, signal: signal() }), (error) => error.info.code === "kugou_unreachable");
  assert.ok(Date.now() - began < 2000, "bounded by bootDeadlineMs");
  await assert.rejects(client.get("/x", {}, { auth: false, signal: signal() }), (error) => error.info.code === "kugou_unreachable");
  assert.equal(fx.state.launches, 1, "the failure cool-down prevents a launch storm");
  const nothing = fakeService({ launchable: false });
  assert.equal(await nothing.starter.ensure(signal()), false, "nothing to launch → not ready");
});

test("a caller's abort ends its own wait without cancelling the shared start", async () => {
  const fx = fakeService({ bootsAfterPolls: 6 });
  const client = new KuGouClient({ baseUrl: "http://127.0.0.1:3400", credentials: () => null, fetch: fx.fetch, ensureReady: (s) => fx.starter.ensure(s) });
  const controller = new AbortController();
  const aborted = client.get("/x", {}, { auth: false, signal: controller.signal });
  const patient = client.get("/x", {}, { auth: false, signal: signal() });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(aborted, (error) => error.name !== "AppError" || error.info.code !== "kugou_unreachable");
  assert.deepEqual(await patient, { ok: 1 });
  assert.equal(fx.state.launches, 1);
});
