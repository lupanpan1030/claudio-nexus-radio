import {
  PROTOCOL_VERSION,
  isNewerPreparation,
  isStageSettled,
  preparationPath,
  preparedItemV1Decoder,
  resolveResponseV1Decoder,
  resolvedMediaFromWire,
  sameTrack,
  type ErrorInfo,
  type PreparationId,
  type PreparedItemV1,
  type PrepareRequestV1,
  type QueueItemId,
  type ResolvedMedia,
  type ResolveRequestV1,
  type Stage
} from "@claudio/contracts";
import { PortError, type PreparePort, type PrepareRequest } from "@claudio/playback-web";
import { bestEffort, portError, requestJson, type FetchLike } from "./http";
import type { ProtocolPaths } from "./protocol";

export interface PreparationTimings {
  /** Per long-poll wait the server is asked to hold (capped server-side). */
  readonly waitMs: number;
  /** Client deadline per HTTP exchange; must exceed waitMs. */
  readonly requestTimeoutMs: number;
  /** Deadline of the best-effort DELETE sent on cancel. */
  readonly cancelTimeoutMs: number;
}

export const DEFAULT_PREPARATION_TIMINGS: PreparationTimings = Object.freeze({ waitMs: 8000, requestTimeoutMs: 12_000, cancelTimeoutMs: 3000 });

type StageName = keyof PreparedItemV1["stages"];

/** Maps a terminal non-ready stage to the error the core understands. */
export function stageFailure(stage: Stage<unknown>, what: string): PortError | null {
  switch (stage.status) {
    case "ready":
    case "pending":
    case "in-progress":
      return null;
    case "failed":
      return new PortError(stage.error);
    case "skipped":
      return portError("unavailable", `${what}_skipped`, stage.reason);
    case "cancelled":
      return portError("retryable", `${what}_cancelled`);
    case "timed-out":
      return portError("retryable", `${what}_timed_out`);
    case "interrupted":
      return portError("retryable", `${what}_interrupted`);
    case "expired":
      return portError("expired", `${what}_expired`);
  }
}

/**
 * Thin client over the v1 preparation endpoints. Every answer is decoded with
 * the shared validators and checked against the identities that were asked.
 */
export class PreparationClient {
  constructor(
    private readonly fetchFn: FetchLike,
    private readonly paths: ProtocolPaths,
    private readonly timings: PreparationTimings = DEFAULT_PREPARATION_TIMINGS
  ) {}

  async start(request: Omit<PrepareRequestV1, "protocolVersion">, signal: AbortSignal): Promise<PreparedItemV1> {
    const body: PrepareRequestV1 = { protocolVersion: PROTOCOL_VERSION, ...request };
    const item = await requestJson(this.fetchFn, { method: "POST", path: this.paths.prepare, body, signal, timeoutMs: this.timings.requestTimeoutMs }, preparedItemV1Decoder);
    if (item.itemId !== request.itemId) throw portError("invalid", "preparation_item_mismatch");
    return item;
  }

  /**
   * Long-polls until `stage` settles, the preparation ends, or the caller
   * aborts. Versions never go backwards: an older publication is ignored.
   */
  async waitForStage(current: PreparedItemV1, stage: StageName, signal: AbortSignal): Promise<PreparedItemV1> {
    let latest = current;
    while (!isStageSettled(latest.stages[stage]) && (latest.status === "active" || latest.status === "ready")) {
      const path = `${preparationPath(latest.preparationId)}?afterVersion=${latest.version}&waitMs=${this.timings.waitMs}`;
      const next = await requestJson(this.fetchFn, { method: "GET", path, signal, timeoutMs: this.timings.requestTimeoutMs }, preparedItemV1Decoder);
      if (next.preparationId !== latest.preparationId || next.itemId !== latest.itemId) throw portError("invalid", "preparation_identity_mismatch");
      if (isNewerPreparation(latest, next)) latest = next;
    }
    return latest;
  }

  async resolve(request: Omit<ResolveRequestV1, "protocolVersion">, signal: AbortSignal): Promise<ResolvedMedia> {
    const body: ResolveRequestV1 = { protocolVersion: PROTOCOL_VERSION, ...request };
    const response = await requestJson(this.fetchFn, { method: "POST", path: this.paths.resolve, body, signal, timeoutMs: this.timings.requestTimeoutMs }, resolveResponseV1Decoder);
    if (response.itemId !== request.itemId) throw portError("invalid", "resolve_item_mismatch");
    if (!sameTrack(response.media.track, request.track)) throw portError("invalid", "resolve_track_mismatch");
    return resolvedMediaFromWire(response.media);
  }

  /** Best effort: the caller has already settled locally; the network may fail. */
  cancel(preparationId: PreparationId): Promise<boolean> {
    return bestEffort(this.fetchFn, "DELETE", preparationPath(preparationId), this.timings.cancelTimeoutMs);
  }
}

/** Final source of a preparation, or the classified reason there is none. */
export function sourceOf(item: PreparedItemV1, expected: PrepareRequest["track"]): ResolvedMedia {
  if (item.status === "expired") throw portError("expired", "preparation_expired");
  if (item.status === "cancelled") throw portError("retryable", "preparation_cancelled");
  if (item.status === "interrupted") throw portError("retryable", "preparation_interrupted");
  const source = item.stages.source;
  if (source.status !== "ready") {
    throw stageFailure(source, "source") ?? (item.status === "failed" ? portError("unavailable", "preparation_failed") : portError("retryable", "source_not_ready"));
  }
  if (!sameTrack(source.value.track, expected)) throw portError("invalid", "source_track_mismatch");
  return resolvedMediaFromWire(source.value);
}

interface Registration {
  readonly preparationId: PreparationId;
  latest: PreparedItemV1 | null;
}

/**
 * PreparePort over HTTP. Items whose preparation was started by someone else
 * on this page (RadioRefill pre-allocates the queue item id and prepares a
 * radio candidate) are adopted: the port then waits on that preparation and
 * never POSTs a second prepare for the same item, which would make the server
 * cancel and rebuild it. Explicit tracks POST prepare; refresh/retry resolve.
 */
export class HttpPreparePort implements PreparePort {
  private readonly registry = new Map<QueueItemId, Registration>();

  constructor(
    private readonly client: PreparationClient,
    private readonly options: { readonly maxEntries?: number; readonly onCancelFailed?: (preparationId: PreparationId) => void } = {}
  ) {}

  /** Records a preparation another component started for `itemId` on this page. */
  adopt(itemId: QueueItemId, prepared: PreparedItemV1): void {
    this.registry.delete(itemId);
    this.registry.set(itemId, { preparationId: prepared.preparationId, latest: prepared });
    this.trim();
  }

  preparationFor(itemId: QueueItemId): PreparationId | null {
    return this.registry.get(itemId)?.preparationId ?? null;
  }

  /** Forgets the item and cancels its server preparation (best effort). */
  release(itemId: QueueItemId): void {
    const registration = this.registry.get(itemId);
    if (!registration) return;
    this.registry.delete(itemId);
    void this.client.cancel(registration.preparationId).then((ok) => {
      if (!ok) this.options.onCancelFailed?.(registration.preparationId);
    });
  }

  async resolve(request: PrepareRequest, signal: AbortSignal): Promise<ResolvedMedia> {
    const registration = this.registry.get(request.itemId) ?? null;
    if (request.purpose === "refresh" || request.previousRevision !== null) {
      return this.client.resolve(
        {
          itemId: request.itemId,
          track: request.track,
          preparationId: registration?.preparationId ?? null,
          reason: request.purpose === "refresh" ? "refresh" : "retry",
          previousRevision: request.previousRevision
        },
        signal
      );
    }
    let current: PreparedItemV1;
    if (registration?.latest && registration.latest.status !== "cancelled" && registration.latest.status !== "expired") {
      current = registration.latest;
    } else {
      current = await this.client.start(
        { itemId: request.itemId, purpose: request.purpose === "standby" ? "standby" : "program", target: { kind: "track", track: request.track }, narration: null, wantLyrics: false },
        signal
      );
      this.registry.set(request.itemId, { preparationId: current.preparationId, latest: current });
      this.trim();
    }
    const onAbort = () => this.release(request.itemId);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const settled = await this.client.waitForStage(current, "source", signal);
      if (signal.aborted) throw portError("retryable", "aborted", undefined, true);
      const entry = this.registry.get(request.itemId);
      if (entry && entry.preparationId === settled.preparationId) entry.latest = settled;
      return sourceOf(settled, request.track);
    } catch (error) {
      // Cancelled by the core: whatever the network said meanwhile is irrelevant.
      if (signal.aborted) throw portError("retryable", "aborted", undefined, true);
      // A failed preparation is terminal; the next attempt for this item starts a new one.
      this.registry.delete(request.itemId);
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Cancels every registered preparation; used when the owner page shuts down. */
  releaseAll(): void {
    for (const itemId of [...this.registry.keys()]) this.release(itemId);
  }

  private trim(): void {
    const max = this.options.maxEntries ?? 64;
    while (this.registry.size > max) {
      const oldest = this.registry.keys().next().value;
      if (oldest === undefined) return;
      this.registry.delete(oldest);
    }
  }
}

export function errorInfoFromUnknown(error: unknown): ErrorInfo {
  if (error instanceof PortError) return error.info;
  return { class: "retryable", code: "unexpected", message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) };
}
