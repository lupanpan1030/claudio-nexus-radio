import fs from "node:fs";
import path from "node:path";
import express, { type Express } from "express";
import { createLegacyRouter, type LegacyApi, type LegacyV1Hooks } from "./legacy-routes.js";
import { createV1Router, type PlaybackServices } from "./v1-routes.js";

export interface AppDeps {
  /** Chosen once at startup; the frontend reads it from /api/v1/protocol. */
  readonly playbackProtocol: "v1" | "legacy";
  readonly playback: PlaybackServices;
  readonly legacy: LegacyApi;
  readonly legacyHooks: LegacyV1Hooks;
  /** Built SPA directory to serve, if any. */
  readonly staticDir?: string | null;
}

export interface ClaudioApp {
  readonly app: Express;
  /** Stops in-flight playback jobs (marked interrupted) and releases app resources. Idempotent. */
  close(): Promise<void>;
}

/**
 * Pure factory: importing or calling it never listens, opens a database or
 * scans the library. Everything it serves is injected.
 */
export function createApp(deps: AppDeps): ClaudioApp {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(createV1Router(deps.playback, deps.playbackProtocol));
  app.use(createLegacyRouter(deps.legacy, deps.playbackProtocol, deps.legacyHooks));

  const staticDir = deps.staticDir;
  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  let closed = false;
  return {
    app,
    async close() {
      if (closed) return;
      closed = true;
      deps.playback.preparations.close();
      deps.playback.cues.close();
    }
  };
}
