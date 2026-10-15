// Localhost fixture server for the browser suite: serves the built test page,
// generated WAV fixtures (single-range 206 supported), a 404 route, and
// controllable streams that can stall (pause sending), resume or disconnect.
// Adapted from the R2 capability probe tooling; not a production Range server.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".map": "application/json", ".wav": "audio/wav", ".json": "application/json" };

export async function startFixtureServer({ pageDir, mediaDir }) {
  const controls = new Map();
  const trace = [];
  const log = (type, details = {}) => trace.push({ type, at: performance.now(), ...details });

  function configure(id, options = {}) {
    if (controls.has(id)) throw new Error(`control ${id} already exists`);
    const state = {
      id,
      fixture: options.fixture ?? "a12.wav",
      paused: false,
      disconnected: false,
      totalBytesSent: 0,
      credit: options.initialBytes ?? Infinity,
      chunkBytes: options.chunkBytes ?? 16384,
      intervalMs: options.intervalMs ?? 20,
      requests: new Set()
    };
    if (!/^[\w.-]+\.wav$/.test(state.fixture)) throw new Error("bad fixture name");
    controls.set(id, state);
    log("configured", { id, fixture: state.fixture, initialBytes: state.credit });
    return status(id);
  }

  function status(id) {
    const s = controls.get(id);
    return s ? { id, fixture: s.fixture, paused: s.paused, disconnected: s.disconnected, totalBytesSent: s.totalBytesSent, activeRequests: s.requests.size } : null;
  }

  function control(id, action) {
    const s = controls.get(id);
    if (!s) throw new Error(`unknown control ${id}`);
    log("control", { id, action });
    if (action === "pause") {
      s.paused = true;
      for (const r of s.requests) clearTimeout(r.timer);
    } else if (action === "resume") {
      if (s.disconnected) throw new Error("disconnected control is terminal");
      s.paused = false;
      s.credit = Infinity;
      for (const r of s.requests) r.pump();
    } else if (action === "disconnect") {
      s.disconnected = true;
      for (const r of s.requests) {
        clearTimeout(r.timer);
        r.res.destroy();
      }
    } else throw new Error(`unknown action ${action}`);
    return status(id);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const api = /^\/controls\/([\w-]+)$/.exec(url.pathname);
      if (api) {
        let value;
        if (req.method === "GET") value = status(api[1]);
        else {
          let body = "";
          for await (const chunk of req) body += chunk;
          const input = JSON.parse(body || "{}");
          value = req.method === "PUT" ? configure(api[1], input) : control(api[1], input.action);
        }
        res.writeHead(value ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
        return;
      }
      if (url.pathname.startsWith("/missing/")) {
        log("media-request", { path: url.pathname, status: 404 });
        res.writeHead(404, { "Cache-Control": "no-store" });
        res.end();
        return;
      }
      const controlled = /^\/controlled\/([\w-]+)\.wav$/.exec(url.pathname);
      const state = controlled ? controls.get(controlled[1]) : null;
      let file;
      if (controlled) {
        if (!state) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (state.disconnected) {
          log("retry-rejected", { id: state.id });
          res.destroy();
          return;
        }
        file = join(mediaDir, state.fixture);
      } else if (url.pathname.startsWith("/media/")) {
        file = join(mediaDir, normalize(url.pathname.slice("/media/".length)).replace(/^(\.\.[/\\])+/, ""));
      } else {
        const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname.slice(1)).replace(/^(\.\.[/\\])+/, "");
        file = join(pageDir, rel);
      }
      let data;
      try {
        data = await readFile(file);
      } catch {
        res.writeHead(404);
        res.end();
        return;
      }
      if (file.endsWith(".wav")) log("media-request", { path: url.pathname, range: req.headers.range ?? null });
      let start = 0;
      let end = data.length - 1;
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      if (range) {
        start = Number(range[1]);
        end = Math.min(range[2] ? Number(range[2]) : end, end);
        if (start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${data.length}` });
          res.end();
          return;
        }
      }
      res.writeHead(range ? 206 : 200, {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Content-Length": end - start + 1,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${data.length}` } : {})
      });
      if (!state) {
        res.end(data.subarray(start, end + 1));
        return;
      }
      res.flushHeaders();
      let offset = start;
      const request = {
        res,
        timer: null,
        pump: () => {
          clearTimeout(request.timer);
          if (res.destroyed || res.writableEnded || state.paused || state.disconnected) return;
          const length = Math.min(state.chunkBytes, end - offset + 1, state.credit);
          if (length <= 0) {
            state.paused = true;
            log("quota-paused", { id: state.id, bytes: state.totalBytesSent });
            return;
          }
          res.write(data.subarray(offset, offset + length));
          offset += length;
          state.totalBytesSent += length;
          state.credit -= length;
          if (offset > end) {
            res.end();
            log("stream-finished", { id: state.id });
          } else if (state.credit === 0) {
            state.paused = true;
            log("quota-paused", { id: state.id, bytes: state.totalBytesSent });
          } else request.timer = setTimeout(request.pump, state.intervalMs);
        }
      };
      state.requests.add(request);
      log("stream-opened", { id: state.id, start, end });
      res.on("close", () => {
        clearTimeout(request.timer);
        state.requests.delete(request);
        log("stream-closed", { id: state.id, offset });
      });
      request.pump();
    } catch (error) {
      log("server-error", { message: String(error) });
      if (!res.headersSent) {
        res.writeHead(400);
        res.end(String(error));
      } else res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    configure,
    control,
    status,
    trace,
    async close() {
      for (const s of controls.values()) for (const r of s.requests) {
        clearTimeout(r.timer);
        r.res.destroy();
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
