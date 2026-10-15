import express, { type Request, type Response, type Router } from "express";
import {
  API_V1_PATHS,
  asId,
  decode,
  lyricsRequestV1Decoder,
  narrationRequestV1Decoder,
  NOW_CONFLICT_HTTP_STATUS,
  nowProjectionV1Decoder,
  prepareRequestV1Decoder,
  PROTOCOL_VERSION,
  resolveRequestV1Decoder,
  startedRequestV1Decoder,
  type CueId,
  type Decoder,
  type LyricsResponseV1,
  type PreparationId,
  type ResolveResponseV1
} from "@claudio/contracts";
import { appError } from "../application/errors.js";
import type { StartedService } from "../application/history/started-service.js";
import type { LyricsService } from "../application/lyrics/lyrics-service.js";
import type { CueService } from "../application/narration/cue-service.js";
import { NowConflictError, type NowService } from "../application/now/now-service.js";
import type { PlaybackPolicy } from "../application/policy.js";
import type { PreparationService } from "../application/preparation/preparation-service.js";
import type { SourceResolver, StreamAccess } from "../application/sources.js";
import type { ProviderRegistry } from "../ports/providers.js";
import type { CandidateAuditStore } from "../ports/stores.js";
import { sendError, sendInvalid } from "./errors.js";
import { pipeMediaStream, requestSignal } from "./stream.js";

export interface PlaybackServices {
  readonly preparations: PreparationService;
  readonly cues: CueService;
  readonly sources: SourceResolver;
  readonly streams: StreamAccess;
  readonly lyrics: LyricsService;
  readonly started: StartedService;
  readonly now: NowService;
  readonly audits: CandidateAuditStore;
  readonly providers: ProviderRegistry;
  readonly policy: PlaybackPolicy;
  readonly serverInstanceId: string;
}

/** Paths this server adds beyond the shared API_V1_PATHS (reported as contract gaps). */
export const V1_EXTRA_PATHS = Object.freeze({
  protocol: "/api/v1/protocol",
  streams: "/api/v1/playback/streams/:token",
  narrationCue: "/api/v1/playback/narration/:cueId",
  nowStream: "/api/v1/now/stream",
  startedHistory: "/api/v1/history/started",
  candidateHistory: "/api/v1/history/candidates",
  catalogSearch: "/api/v1/catalog/search"
});

export const STREAM_HANDLE_PREFIX = "/api/v1/playback/streams/";

function body<T>(req: Request, res: Response, decoder: Decoder<T>): T | null {
  const result = decode(decoder, req.body);
  if (!result.ok) {
    sendInvalid(res, result.issues);
    return null;
  }
  return result.value;
}

function queryNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

export function createV1Router(services: PlaybackServices, mode: "v1" | "legacy"): Router {
  const router = express.Router();
  const { preparations, cues, sources, streams, lyrics, started, now, audits, providers, policy } = services;

  router.get(V1_EXTRA_PATHS.protocol, (_req, res) => {
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      playbackProtocol: mode,
      serverInstanceId: services.serverInstanceId,
      paths: { ...API_V1_PATHS, ...V1_EXTRA_PATHS },
      providers: providers.list().map((module) => ({ providerId: module.providerId, lyrics: Boolean(module.lyrics) }))
    });
  });

  // One switch: when the server runs the legacy protocol, v1 playback is closed (no half-migration).
  router.use("/api/v1", (_req, res, next) => {
    if (mode === "v1") return next();
    sendError(res, appError("unavailable", "protocol_disabled", "this server runs the legacy playback protocol"));
  });

  router.post(API_V1_PATHS.prepare, async (req, res) => {
    const request = body(req, res, prepareRequestV1Decoder);
    if (!request) return;
    try {
      res.json(await preparations.prepare(request, requestSignal(req, res)));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get(API_V1_PATHS.preparation, async (req, res) => {
    const id = asId<PreparationId>(String(req.params.preparationId ?? ""));
    const afterVersion = queryNumber(req.query.afterVersion, -1, -1, Number.MAX_SAFE_INTEGER);
    const waitMs = queryNumber(req.query.waitMs, 0, 0, policy.maxLongPollMs);
    const record = await preparations.wait(id, afterVersion, waitMs, requestSignal(req, res));
    if (!record) return sendError(res, appError("unavailable", "preparation_not_found"));
    res.json(preparations.toWire(record));
  });

  router.delete(API_V1_PATHS.preparation, (req, res) => {
    const record = preparations.cancel(asId<PreparationId>(String(req.params.preparationId ?? "")));
    if (!record) return sendError(res, appError("unavailable", "preparation_not_found"));
    res.json(preparations.toWire(record));
  });

  router.post(API_V1_PATHS.resolve, async (req, res) => {
    const request = body(req, res, resolveRequestV1Decoder);
    if (!request) return;
    try {
      if (request.preparationId) preparations.checkRefreshTarget(request.preparationId, request.itemId, request.track);
      const resolution = await sources.resolve(
        {
          itemId: request.itemId,
          track: request.track,
          reason: request.reason,
          previousRevision: request.previousRevision,
          notAfter: Number.POSITIVE_INFINITY
        },
        requestSignal(req, res)
      );
      const response: ResolveResponseV1 = { protocolVersion: PROTOCOL_VERSION, itemId: request.itemId, media: resolution.media };
      res.json(response);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post(API_V1_PATHS.narration, async (req, res) => {
    const request = body(req, res, narrationRequestV1Decoder);
    if (!request) return;
    try {
      const signal = requestSignal(req, res);
      const record = cues.start({
        cueId: request.cueId,
        transitionId: request.transitionId,
        preparationId: request.preparationId,
        from: request.from,
        to: request.to
      });
      const afterVersion = queryNumber(req.query.afterVersion, -1, -1, Number.MAX_SAFE_INTEGER);
      const waitMs = queryNumber(req.query.waitMs, 0, 0, policy.maxLongPollMs);
      const latest = (await cues.wait(record.cueId, afterVersion, waitMs, signal)) ?? record;
      res.json(cues.toResponse(latest));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete(V1_EXTRA_PATHS.narrationCue, (req, res) => {
    const record = cues.cancel(asId<CueId>(String(req.params.cueId ?? "")));
    if (!record) return sendError(res, appError("unavailable", "cue_not_found"));
    res.json(cues.toResponse(record));
  });

  router.post(API_V1_PATHS.lyrics, async (req, res) => {
    const request = body(req, res, lyricsRequestV1Decoder);
    if (!request) return;
    try {
      const result = await lyrics.forRevision(
        { track: request.track, sourceRevision: request.sourceRevision, recordingId: request.recordingId },
        requestSignal(req, res)
      );
      const response: LyricsResponseV1 = { protocolVersion: PROTOCOL_VERSION, itemId: request.itemId, sourceRevision: request.sourceRevision, result };
      res.json(response);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post(API_V1_PATHS.started, (req, res) => {
    const request = body(req, res, startedRequestV1Decoder);
    if (!request) return;
    try {
      res.json(started.record(request));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get(API_V1_PATHS.now, (_req, res) => {
    const projection = now.get();
    if (!projection) return sendError(res, appError("unavailable", "projection_not_found", "no executor has reported yet"));
    res.json(projection);
  });

  router.put(API_V1_PATHS.now, (req, res) => {
    const projection = body(req, res, nowProjectionV1Decoder);
    if (!projection) return;
    try {
      res.json(now.accept(projection));
    } catch (error) {
      // The shared 409 body names the accepted owner; it is an error, never a snapshot.
      if (error instanceof NowConflictError) return void res.status(NOW_CONFLICT_HTTP_STATUS).json(error.conflict);
      sendError(res, error);
    }
  });

  router.get(V1_EXTRA_PATHS.nowStream, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (projection: unknown) => res.write(`event: now\ndata: ${JSON.stringify(projection)}\n\n`);
    const current = now.get();
    if (current) send(current);
    const unsubscribe = now.subscribe(send);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.get(V1_EXTRA_PATHS.streams, (req, res) => {
    const token = String(req.params.token ?? "");
    void pipeMediaStream((signal) => streams.open(token, req.headers.range ?? null, signal), req, res);
  });

  router.get(V1_EXTRA_PATHS.startedHistory, (req, res) => {
    const limit = queryNumber(req.query.limit, 50, 1, 200);
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      semantics: "confirmed-started",
      started: started.recent(limit).map((fact) => ({
        itemId: fact.itemId,
        track: fact.track,
        display: providers.describe(fact.track)?.display ?? null,
        recordingId: fact.recordingId,
        sourceRevision: fact.sourceRevision,
        startedAt: fact.startedAt,
        positionMs: fact.positionMs,
        sourceVerified: fact.sourceVerified
      }))
    });
  });

  router.get(V1_EXTRA_PATHS.candidateHistory, (req, res) => {
    const limit = queryNumber(req.query.limit, 20, 1, 100);
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      semantics: "candidate-selection",
      candidates: audits.recent(limit).map((audit) => ({
        itemId: audit.itemId,
        preparationId: audit.preparationId,
        track: audit.selected,
        display: providers.describe(audit.selected)?.display ?? null,
        policy: audit.policy,
        reason: audit.reason,
        considered: audit.considered,
        createdAt: new Date(audit.createdAt).toISOString()
      }))
    });
  });

  router.get(V1_EXTRA_PATHS.catalogSearch, (req, res) => {
    const query = String(req.query.q ?? "");
    const limit = queryNumber(req.query.limit, 50, 1, 500);
    const entries = providers.list().flatMap((module) => module.catalog.search(query, limit));
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      tracks: entries.slice(0, limit).map((entry) => ({ track: entry.ref, display: entry.display, playable: entry.playable }))
    });
  });

  return router;
}
