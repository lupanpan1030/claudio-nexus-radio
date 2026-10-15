import { createHash, randomBytes } from "node:crypto";
import {
  asId,
  type QueueItemId,
  type ResolvedMediaWire,
  type SourceRevision,
  type StreamHandle,
  type TrackRef
} from "@claudio/contracts";
import type { CatalogEntry } from "../ports/catalog.js";
import type { MediaStream, ResolvedSource, SourceBinding } from "../ports/media-source.js";
import type { ProviderRegistry } from "../ports/providers.js";
import type { Clock } from "../ports/runtime.js";
import type { ResolvedSourceRecord, ResolvedSourceStore, StreamHandleRecord, StreamHandleStore } from "../ports/stores.js";
import { appError, throwIfAborted } from "./errors.js";
import { withDeadline } from "./operations.js";
import type { PlaybackPolicy } from "./policy.js";

/**
 * Opaque handles are same-origin stream paths: the executor may use them as a
 * media src as-is, while the token behind them maps to a private binding.
 */
export class StreamHandles {
  constructor(private readonly prefix: string) {}

  issue(): { token: string; handle: StreamHandle } {
    const token = randomBytes(24).toString("base64url");
    return { token, handle: asId<StreamHandle>(`${this.prefix}${token}`) };
  }

  handleFor(token: string): StreamHandle {
    return asId<StreamHandle>(`${this.prefix}${token}`);
  }
}

export interface SourceResolution {
  readonly entry: CatalogEntry;
  readonly media: ResolvedMediaWire;
  /** Load deadline of the issued handle (epoch ms). */
  readonly expiresAt: number;
}

export interface ResolveInput {
  readonly itemId: QueueItemId;
  readonly track: TrackRef;
  readonly reason: "initial" | "refresh" | "retry";
  readonly previousRevision: SourceRevision | null;
  /** Upper bound for the handle's load deadline (e.g. the preparation expiry). */
  readonly notAfter: number;
}

export class SourceResolver {
  constructor(
    private readonly deps: {
      readonly providers: ProviderRegistry;
      readonly resolvedSources: ResolvedSourceStore;
      readonly handles: StreamHandleStore;
      readonly handleFormat: StreamHandles;
      readonly clock: Clock;
      readonly policy: PlaybackPolicy;
    }
  ) {}

  /** Resolves a catalog ref into one concrete recording and issues a fresh handle for it. */
  async resolve(input: ResolveInput, signal: AbortSignal): Promise<SourceResolution> {
    const { providers, resolvedSources, clock, policy } = this.deps;
    const provider = providers.get(input.track.providerId);
    const entry = providers.describe(input.track);
    if (!provider || !entry) throw appError("unavailable", "track_not_found", "track is not in the catalog");
    if (!entry.playable) throw appError("unavailable", "track_not_playable", "track has no playable source");

    // A revision this server issued names one ref: refreshing another ref from it is a caller error, not a fresh start.
    // An unknown revision (never issued here, or collected) carries no binding: the ref is located again and keeps
    // the old revision only if the provider proves the same recording again.
    const previousRecord = input.previousRevision ? resolvedSources.get(input.previousRevision) : null;
    if (previousRecord && !sameRef(previousRecord.track, input.track)) {
      throw appError("invalid", "previous_revision_mismatch", "previousRevision belongs to another track");
    }
    const previous = previousRecord ? { sourceRevision: previousRecord.sourceRevision, binding: previousRecord.binding } : null;

    const scoped = withDeadline(signal, policy.sourceDeadlineMs);
    let resolved: ResolvedSource;
    try {
      resolved = await provider.source.resolve(input.track, { signal: scoped.signal, reason: input.reason, previous });
      throwIfAborted(scoped.signal);
    } finally {
      scoped.dispose();
    }

    const now = clock.now();
    const known = resolvedSources.get(resolved.sourceRevision);
    if (known && (!sameRef(known.track, input.track) || known.recordingId !== resolved.recording.recordingId)) {
      // A revision string may never name two different recordings.
      throw appError("unavailable", "revision_conflict", "provider produced a revision already bound elsewhere");
    }
    const record: Omit<ResolvedSourceRecord, "bindingScrubbedAt"> = {
      sourceRevision: resolved.sourceRevision,
      track: input.track,
      legacyTrackId: entry.legacyTrackId,
      recordingId: resolved.recording.recordingId,
      confidence: resolved.recording.confidence,
      duration: resolved.duration,
      binding: resolved.binding,
      firstSeenAt: known?.firstSeenAt ?? now,
      lastSeenAt: now,
      expiresAt: resolved.expiresAt
    };
    resolvedSources.upsert(record);

    const expiresAt = Math.min(resolved.expiresAt ?? Number.POSITIVE_INFINITY, input.notAfter, now + policy.maxTtlMs);
    const { token, handle } = this.deps.handleFormat.issue();
    this.deps.handles.insert({
      token,
      kind: "media",
      providerId: input.track.providerId,
      sourceRevision: resolved.sourceRevision,
      binding: resolved.binding,
      expiresAt,
      retainUntil: expiresAt + policy.streamGraceMs,
      createdAt: now
    });

    return {
      entry,
      expiresAt,
      media: {
        track: input.track,
        recording: resolved.recording,
        sourceRevision: resolved.sourceRevision,
        stream: { handle, expiresAt: new Date(expiresAt).toISOString() },
        duration: resolved.duration,
        capabilities: resolved.capabilities
      }
    };
  }
}

export type VoiceStreamOpener = (binding: SourceBinding, range: string | null, signal: AbortSignal) => Promise<MediaStream>;

/**
 * Serves an issued handle: exactly its bound recording, or a classified
 * failure. A media handle that was never opened is refused once its load
 * deadline has passed; the first successful open (whatever its method or
 * Range) activates it, and an activated handle keeps serving Range requests
 * until retainUntil. Admission is judged at the time the request arrived, so
 * a slow upstream that answers after the deadline does not turn a request
 * admitted in time into a refusal, nor a late request into an admission.
 * Activation only means some loader opened the handle: it is not "playing",
 * writes no started fact, and cannot tell a second fresh load of the same
 * handle from a continuing one (the executor checks expiry before loading).
 */
export class StreamAccess {
  constructor(
    private readonly deps: {
      readonly providers: ProviderRegistry;
      readonly handles: StreamHandleStore;
      readonly clock: Clock;
      readonly openVoice: VoiceStreamOpener;
    }
  ) {}

  async open(token: string, range: string | null, signal: AbortSignal): Promise<MediaStream> {
    const record = this.deps.handles.get(token);
    if (!record) throw appError("expired", "unknown_stream_handle", "stream handle is unknown or was collected");
    const admittedAt = this.deps.clock.now();
    if (admittedAt > record.retainUntil) throw appError("expired", "stream_expired", "stream handle expired");
    if (record.firstOpenedAt === null && record.expiresAt !== null && admittedAt > record.expiresAt) {
      throw appError("expired", "stream_never_opened", "the handle was not opened before its load deadline; resolve again");
    }
    const stream = await this.openRecord(record, range, signal);
    if (stream.status !== 416 && record.firstOpenedAt === null) this.deps.handles.markOpened(token, admittedAt);
    return stream;
  }

  private openRecord(record: StreamHandleRecord, range: string | null, signal: AbortSignal): Promise<MediaStream> {
    if (record.kind === "voice") return this.deps.openVoice(record.binding, range, signal);
    if (!record.providerId) throw appError("invalid", "stream_handle_corrupt");
    if (record.binding.revoked === true) throw appError("auth-required", "stream_revoked", "provider account changed");
    const provider = this.deps.providers.get(record.providerId);
    if (!provider) throw appError("unavailable", "provider_unavailable");
    return provider.source.open(record.binding, { range, signal });
  }

  describe(token: string): StreamHandleRecord | null {
    return this.deps.handles.get(token);
  }
}

/**
 * A source revision scoped to one TrackRef: `evidence` identifies the
 * recording as served (content hash, provider hash...). Same ref + same
 * evidence → same revision; the same recording under another ref → another
 * revision, so revisions never collide across catalog entries.
 */
export function refScopedRevision(prefix: string, ref: TrackRef, evidence: readonly string[]): SourceRevision {
  const digest = createHash("sha256")
    .update(JSON.stringify([ref.providerId, ref.mediaId, ...evidence]))
    .digest("hex")
    .slice(0, 40);
  return asId<SourceRevision>(`${prefix}${digest}`);
}

export function sameRef(a: TrackRef, b: TrackRef): boolean {
  return a.providerId === b.providerId && a.mediaId === b.mediaId;
}
