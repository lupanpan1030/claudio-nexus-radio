import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { KuGouClient } from "./adapters/kugou/client.ts";
import { KuGouMediaSource } from "./adapters/kugou/kugou-source.ts";
import { TrackRowReader } from "./adapters/sqlite/track-catalog.ts";

// Behavioral replacement for the old index.ts text assertion: the remote proxy
// now lives in the KuGou media source (the legacy route keeps the same rule).
test("remote streams fall back to a browser-playable MIME type", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/octet-stream");
    res.end(Buffer.alloc(8));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const source = new KuGouMediaSource({
      rows: new TrackRowReader(new DatabaseSync(":memory:")),
      client: new KuGouClient({ baseUrl: "http://127.0.0.1:9", credentials: () => null }),
      search: async () => [],
      score: () => 0,
      urlTtlMs: 1000,
      clock: { now: () => 0 }
    });
    const binding = {
      hash: "0123456789ABCDEF0123456789ABCDEF",
      servedHash: null,
      url: `http://127.0.0.1:${server.address().port}/audio`,
      confidence: "provider-asserted",
      accountRevision: null,
      fetchedAt: 0
    };
    const stream = await source.open(binding, { range: null, signal: new AbortController().signal });
    assert.equal(stream.headers["content-type"], "audio/mpeg");
    for await (const _chunk of stream.body) {
      // drain
    }
  } finally {
    server.close();
  }
});
