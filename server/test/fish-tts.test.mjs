import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import { abortKind } from "../application/errors.ts";
import { withDeadline } from "../application/operations.ts";
import { FishSpeechSynthesis } from "../adapters/fish/fish-tts.ts";

// Local stand-in for the Fish TTS endpoint (fake key; nothing leaves the machine).
const plan = [];
const seen = [];
let server;
let endpoint;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, model: req.headers.model, body: JSON.parse(body) });
      const step = plan.shift() ?? "ok";
      if (step === "ok") {
        res.setHeader("content-type", "audio/mpeg");
        return res.end(Buffer.alloc(1024, 1));
      }
      if (step === "stall") {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.write(Buffer.alloc(16, 1));
        return; // body never finishes
      }
      res.statusCode = Number(step);
      res.end("nope");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${server.address().port}/v1/tts`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const fish = (overrides = {}) =>
  new FishSpeechSynthesis({ apiKey: "fake-key", endpoint, model: "s2.1-pro-free", voiceId: "voice-1", format: "mp3", latency: "normal", proxy: "", retryDelayMs: 5, ...overrides });

test("descriptor carries provider/model/voice/format/options for the cache key", () => {
  assert.deepEqual(fish().descriptor, { provider: "fish", model: "s2.1-pro-free", voice: "voice-1", format: "mp3", options: '{"latency":"normal"}' });
  assert.equal(fish({ apiKey: "" }).configured, false);
});

test("keeps the existing request shape and retries once on 5xx", async () => {
  plan.push("503", "ok");
  const bytes = await fish().synthesize("你好", { signal: new AbortController().signal });
  assert.equal(bytes.length, 1024);
  const [failed, ok] = seen.slice(-2);
  assert.equal(failed.auth, "Bearer fake-key");
  assert.equal(ok.model, "s2.1-pro-free");
  assert.deepEqual(ok.body, { text: "你好", format: "mp3", latency: "normal", reference_id: "voice-1" });
});

test("401 is auth-required and not retried", async () => {
  const before = seen.length;
  plan.push("401");
  await assert.rejects(fish().synthesize("x", { signal: new AbortController().signal }), (error) => error.info.class === "auth-required");
  assert.equal(seen.length - before, 1);
});

test("the deadline covers the response body read", async () => {
  plan.push("stall");
  const scoped = withDeadline(new AbortController().signal, 150);
  const started = Date.now();
  await assert.rejects(fish().synthesize("x", { signal: scoped.signal }));
  assert.equal(abortKind(scoped.signal), "timed-out");
  assert.ok(Date.now() - started < 2_000, "did not wait for the stalled body");
  scoped.dispose();
});
