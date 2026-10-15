import { PROTOCOL_VERSION, type StartedRequestV1, type StartedResponseV1 } from "@claudio/contracts";
import type { ProviderRegistry } from "../../ports/providers.js";
import type { Clock } from "../../ports/runtime.js";
import type { ReservationStore, ResolvedSourceStore, StartedFact, StartedStore } from "../../ports/stores.js";
import { appError } from "../errors.js";
import { sameRef } from "../sources.js";

/**
 * Records "this item became program output and its media confirmed playing".
 * Idempotent per idempotency key and per item: retries, pause/resume and
 * same-item reloads never add a second listen; the same track in another
 * queue item is a separate listen.
 */
export class StartedService {
  constructor(
    private readonly deps: {
      readonly store: StartedStore;
      readonly resolvedSources: ResolvedSourceStore;
      readonly reservations: ReservationStore;
      readonly providers: ProviderRegistry;
      readonly clock: Clock;
    }
  ) {}

  record(request: StartedRequestV1): StartedResponseV1 {
    const source = this.deps.resolvedSources.get(request.sourceRevision);
    if (source && (!sameRef(source.track, request.track) || source.recordingId !== request.recordingId)) {
      throw appError("invalid", "started_source_mismatch", "sourceRevision belongs to another track/recording");
    }
    const entry = this.deps.providers.describe(request.track);
    const fact: StartedFact = {
      idempotencyKey: request.idempotencyKey,
      itemId: request.itemId,
      executorInstanceId: request.executorInstanceId,
      track: request.track,
      legacyTrackId: entry?.legacyTrackId ?? source?.legacyTrackId ?? null,
      recordingId: request.recordingId,
      sourceRevision: request.sourceRevision,
      loadId: request.loadId,
      positionMs: request.positionMs,
      startedAt: request.startedAt,
      receivedAt: this.deps.clock.now(),
      sourceVerified: source !== null
    };
    const status = this.deps.store.record(fact);
    // The listen now counts through started facts; the short-term reservation is no longer needed.
    this.deps.reservations.release(request.itemId);
    return { protocolVersion: PROTOCOL_VERSION, idempotencyKey: request.idempotencyKey, status };
  }

  recent(limit: number): readonly StartedFact[] {
    return this.deps.store.recent(Math.max(1, Math.min(limit, 200)));
  }
}
