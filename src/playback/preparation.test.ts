import assert from "node:assert/strict";
import { test } from "node:test";
import { asId, type CueId, type OperationId, type QueueItemId, type SourceRevision, type TransitionId } from "@claudio/contracts";
import { PortError } from "@claudio/playback-web";
import { HttpPreparePort, PreparationClient } from "./preparation";
import { HttpCuePort, createStreamUrls } from "./ports";
import { interpretHandshake } from "./protocol";
import { FakePlaybackServer, TEST_PATHS, flush, json, mediaWire, ref } from "./test-support";

const op = (n: number) => asId<OperationId>(`op-${n}`);
const item = (n: string) => asId<QueueItemId>(`item-${n}`);

function setup() {
  const server = new FakePlaybackServer();
  const client = new PreparationClient(server.fetch, TEST_PATHS, { waitMs: 50, requestTimeoutMs: 2000, cancelTimeoutMs: 500 });
  return { server, client, port: new HttpPreparePort(client) };
}

test("explicit track: one POST prepare, source ready returns at once with runtime-clock expiry", async () => {
  const { server, port } = setup();
  const media = await port.resolve({ opId: op(1), itemId: item("a"), track: ref("A"), purpose: "program", previousRevision: null }, new AbortController().signal);
  assert.equal(server.count("POST", "/api/v1/playback/prepare"), 1);
  assert.equal(media.sourceRevision, "rev-A");
  assert.equal(media.stream.expiresAt, null);
  const body = server.requests[0]?.body as { target: unknown; narration: unknown; wantLyrics: boolean };
  assert.deepEqual(body.target, { kind: "track", track: ref("A") });
  assert.equal(body.narration, null);
});

test("adopted radio preparation is awaited by GET, never re-POSTed", async () => {
  const { server, client, port } = setup();
  server.autoReady = false;
  const started = await client.start({ itemId: item("r"), purpose: "standby", target: { kind: "radio-candidate", afterItemId: null }, narration: null, wantLyrics: false }, new AbortController().signal);
  port.adopt(item("r"), started);
  const pending = port.resolve({ opId: op(2), itemId: item("r"), track: ref("R1"), purpose: "standby", previousRevision: null }, new AbortController().signal);
  await flush();
  assert.equal(server.count("POST", "/api/v1/playback/prepare"), 1, "only the refill's own POST");
  server.publish(started.preparationId, { candidate: { status: "ready", value: { track: ref("R1"), display: null } }, source: { status: "ready", value: mediaWire(ref("R1")) } });
  const media = await pending;
  assert.equal(media.track.mediaId, "R1");
  assert.ok(server.count("GET", /\/preparations\//) >= 1);
  assert.equal(server.count("POST", "/api/v1/playback/prepare"), 1);
});

test("abort settles locally and sends one best-effort DELETE; a late version is not applied", async () => {
  const { server, port } = setup();
  server.autoReady = false;
  const controller = new AbortController();
  const pending = port.resolve({ opId: op(3), itemId: item("b"), track: ref("B"), purpose: "standby", previousRevision: null }, controller.signal);
  await flush();
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof PortError && error.info.code === "aborted");
  await flush();
  assert.equal(server.count("DELETE", /\/preparations\/prep-1$/), 1);
  assert.equal(port.preparationFor(item("b")), null);
});

test("refresh and retry go through resolve with the previous revision, not a new prepare", async () => {
  const { server, port } = setup();
  await port.resolve({ opId: op(4), itemId: item("c"), track: ref("C"), purpose: "program", previousRevision: null }, new AbortController().signal);
  const refreshed = await port.resolve({ opId: op(5), itemId: item("c"), track: ref("C"), purpose: "refresh", previousRevision: asId<SourceRevision>("rev-C") }, new AbortController().signal);
  const resolveBody = server.requests.find((request) => request.path === "/api/v1/playback/resolve")?.body as { reason: string; preparationId: string | null; previousRevision: string };
  assert.equal(resolveBody.reason, "refresh");
  assert.equal(resolveBody.preparationId, "prep-1");
  assert.equal(resolveBody.previousRevision, "rev-C");
  assert.equal(refreshed.sourceRevision, "rev-C-r");
  assert.equal(server.count("POST", "/api/v1/playback/prepare"), 1);
});

test("server errors keep their class; undecodable bodies are invalid; failed stages map to PortError", async () => {
  const { server, port } = setup();
  server.failNextPrepare = { status: 401, code: "login_required", class: "auth-required" };
  await assert.rejects(port.resolve({ opId: op(6), itemId: item("d"), track: ref("D"), purpose: "program", previousRevision: null }, new AbortController().signal), (error: unknown) => error instanceof PortError && error.info.class === "auth-required" && error.info.code === "login_required");
  const bad = new PreparationClient(async () => json(200, { protocolVersion: 1, nonsense: true }), TEST_PATHS);
  await assert.rejects(new HttpPreparePort(bad).resolve({ opId: op(7), itemId: item("e"), track: ref("E"), purpose: "program", previousRevision: null }, new AbortController().signal), (error: unknown) => error instanceof PortError && error.info.code === "bad_response");
});

test("request deadline covers a hung server and is classified as timeout", async () => {
  const hung = new PreparationClient((_input, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))), TEST_PATHS, { waitMs: 10, requestTimeoutMs: 30, cancelTimeoutMs: 10 });
  await assert.rejects(new HttpPreparePort(hung).resolve({ opId: op(8), itemId: item("f"), track: ref("F"), purpose: "program", previousRevision: null }, new AbortController().signal), (error: unknown) => error instanceof PortError && error.info.code === "timeout");
});

test("cue port long-polls narration until script and voice are ready and checks identities", async () => {
  let calls = 0;
  const script = { assetId: "s1", version: 1, text: "下一首是 B。", subtitle: { timing: "plain-text", segments: [{ text: "下一首是 B。" }] } };
  const voice = { assetId: "v1", scriptAssetId: "s1", stream: { handle: "/api/v1/playback/streams/v1", expiresAt: "2030-01-01T00:00:00.000Z" }, duration: { kind: "known", ms: 3000, source: "decoded" }, playbackRate: 0.86 };
  const fetchFn = async (_input: string, init: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init.body));
    return json(200, { protocolVersion: 1, cueId: body.cueId, transitionId: body.transitionId, version: calls, script: calls > 1 ? { status: "ready", value: script } : { status: "in-progress" }, voice: calls > 2 ? { status: "ready", value: voice } : { status: "pending" } });
  };
  const cues = new HttpCuePort(fetchFn, TEST_PATHS, { preparationFor: () => null }, { waitMs: 10, requestTimeoutMs: 1000, cancelTimeoutMs: 100 });
  const binding = { cueId: asId<CueId>("cue-1"), transitionId: asId<TransitionId>("tr-1"), fromItemId: item("a"), toItemId: item("b"), fromRevision: null, toRevision: null } as const;
  const asset = await cues.request({ opId: op(9), binding, from: ref("A"), to: ref("B") }, new AbortController().signal);
  assert.equal(calls, 3);
  assert.equal(asset.voice.stream.expiresAt, Date.parse("2030-01-01T00:00:00.000Z"));
  assert.equal(asset.script.text, "下一首是 B。");
});

test("stream handles are only accepted under the announced same-origin streams route", () => {
  const urls = createStreamUrls(TEST_PATHS, "http://claudio.test");
  assert.deepEqual(urls.music(asId("/api/v1/playback/streams/abc")), { url: "http://claudio.test/api/v1/playback/streams/abc", crossOrigin: null });
  assert.throws(() => urls.music(asId("https://evil.example/x.mp3")), PortError);
  assert.throws(() => urls.voice(asId("//evil.example/api/v1/playback/streams/x")), PortError);
});

test("handshake: v1 accepted with extra paths; legacy mode or other versions refuse to start", () => {
  const ready = interpretHandshake(200, { protocolVersion: 1, playbackProtocol: "v1", serverInstanceId: "s1", paths: { ...TEST_PATHS } });
  assert.equal(ready.status, "ready");
  assert.equal(ready.status === "ready" && ready.paths.narrationCue, "/api/v1/playback/narration/:cueId");
  assert.equal(interpretHandshake(200, { protocolVersion: 1, playbackProtocol: "legacy", serverInstanceId: "s1", paths: {} }).status, "mismatch");
  assert.equal(interpretHandshake(200, { protocolVersion: 2, playbackProtocol: "v1", serverInstanceId: "s1" }).status, "mismatch");
  assert.equal(interpretHandshake(404, null).status, "mismatch");
  assert.equal(interpretHandshake(502, null).status, "unreachable");
});
