import {
  asId,
  isStageSettled,
  PROTOCOL_VERSION,
  type CandidateV1,
  type PreparationId,
  type PreparationStatusV1,
  type PreparedItemV1,
  type PrepareRequestV1,
  type QueueItemId,
  type TrackRef
} from "@claudio/contracts";
import type { ProviderRegistry } from "../../ports/providers.js";
import type { RadioCandidatePort } from "../../ports/radio.js";
import type { Clock, IdSource } from "../../ports/runtime.js";
import type {
  CandidateAuditStore,
  ListeningHistoryPort,
  PreparationRecord,
  PreparationStages,
  PreparationStore,
  ReservationStore
} from "../../ports/stores.js";
import { OperationAbort, appError, throwIfAborted } from "../errors.js";
import type { LyricsService } from "../lyrics/lyrics-service.js";
import type { CueService } from "../narration/cue-service.js";
import { raceAbort, withDeadline } from "../operations.js";
import type { PlaybackPolicy } from "../policy.js";
import { sameRef, type SourceResolver } from "../sources.js";
import { advance, failed, inProgress, pending, ready, settledFromError, skipped, terminate } from "../stages.js";
import { Watchers } from "../watchers.js";

interface PreparationJob {
  readonly controller: AbortController;
  record: PreparationRecord;
  readonly cleanups: (() => void)[];
}

const TERMINAL: readonly PreparationStatusV1[] = ["failed", "cancelled", "interrupted", "expired"];
const RECENT_LISTENING_WINDOW = 60;

/**
 * Staged preparation of one queue item. Candidate and source are published
 * first so music can load while script/voice/lyrics continue. Preparing never
 * records a play; a radio candidate is only *reserved* (released on cancel).
 * Running jobs live in memory; every published version is persisted, and a
 * restart turns unfinished records into "interrupted".
 */
export class PreparationService {
  private readonly jobs = new Map<string, PreparationJob>();
  private readonly watchers = new Watchers<PreparationRecord>();

  constructor(
    private readonly deps: {
      readonly store: PreparationStore;
      readonly reservations: ReservationStore;
      readonly audits: CandidateAuditStore;
      readonly history: ListeningHistoryPort;
      readonly providers: ProviderRegistry;
      readonly radio: RadioCandidatePort;
      readonly sources: SourceResolver;
      readonly lyrics: LyricsService;
      readonly cues: CueService;
      readonly clock: Clock;
      readonly ids: IdSource;
      readonly policy: PlaybackPolicy;
      readonly ownerInstance: string;
    }
  ) {}

  /**
   * Starts (or, for an identical repeat, returns) a preparation and answers
   * once the source stage settles or the response wait elapses.
   */
  async prepare(request: PrepareRequestV1, signal: AbortSignal): Promise<PreparedItemV1> {
    const { store, clock, policy } = this.deps;
    const now = clock.now();
    const existing = store.latestForItem(request.itemId);
    if (existing && (existing.status === "active" || existing.status === "ready") && existing.expiresAt > now) {
      if (JSON.stringify(existing.request) === JSON.stringify(request)) {
        return this.toWire(await this.waitForSource(existing.preparationId, policy.prepareResponseWaitMs, signal));
      }
      this.cancel(existing.preparationId);
    }
    this.enforceActiveLimit(request);

    const preparationId = asId<PreparationId>(this.deps.ids.next("prep"));
    const record: PreparationRecord = {
      preparationId,
      itemId: request.itemId,
      request,
      version: 0,
      status: "active",
      stages: {
        candidate: inProgress(),
        source: pending(),
        lyrics: request.wantLyrics ? pending() : skipped("not-requested"),
        script: request.narration ? pending() : skipped("no-narration"),
        voice: request.narration ? pending() : skipped("no-narration")
      },
      cueId: request.narration?.cueId ?? null,
      expiresAt: now + policy.maxTtlMs,
      createdAt: now,
      updatedAt: now,
      ownerInstance: this.deps.ownerInstance
    };
    store.insert(record);
    const job: PreparationJob = { controller: new AbortController(), record, cleanups: [] };
    this.jobs.set(preparationId, job);
    void this.run(job);
    return this.toWire(await this.waitForSource(preparationId, policy.prepareResponseWaitMs, signal));
  }

  /** The current record; one past its expiry is settled as expired on read rather than at the next GC tick. */
  get(preparationId: PreparationId): PreparationRecord | null {
    const record = this.jobs.get(preparationId)?.record ?? this.deps.store.get(preparationId);
    return record ? this.expireIfDue(record) : null;
  }

  /**
   * A resolve that names a preparation refreshes that preparation's source:
   * the preparation must exist, belong to the item, and have settled its
   * candidate on the very same track. Its source revision may have moved on
   * through earlier refreshes; only the target is pinned.
   */
  checkRefreshTarget(preparationId: PreparationId, itemId: QueueItemId, track: TrackRef): void {
    const record = this.get(preparationId);
    if (!record || record.itemId !== itemId) throw appError("invalid", "preparation_mismatch", "preparationId does not belong to this item");
    const candidate = record.stages.candidate;
    if (candidate.status !== "ready") throw appError("invalid", "preparation_without_candidate", "the preparation has no settled candidate to refresh");
    if (!sameRef(candidate.value.track, track)) throw appError("invalid", "preparation_track_mismatch", "the preparation prepared another track");
  }

  /**
   * Long-poll: returns once a version newer than `afterVersion` exists (when
   * afterVersion >= 0) or the preparation leaves "active", bounded by waitMs (wall time).
   */
  async wait(preparationId: PreparationId, afterVersion: number, waitMs: number, signal: AbortSignal): Promise<PreparationRecord | null> {
    const deadline = Date.now() + Math.min(waitMs, this.deps.policy.maxLongPollMs);
    let current = this.get(preparationId);
    while (current && current.status === "active" && !(afterVersion >= 0 && current.version > afterVersion)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal.aborted) break;
      current = (await this.watchers.next(preparationId, remaining, signal)) ?? this.get(preparationId);
    }
    return current ? this.expireIfDue(current) : null;
  }

  cancel(preparationId: PreparationId): PreparationRecord | null {
    return this.finish(preparationId, "cancelled");
  }

  /** Marks due records expired. Media already playing is unaffected; handles stop starting new loads. */
  expireDue(now: number): number {
    let count = 0;
    for (const record of this.deps.store.listByStatus(["active", "ready"])) {
      if (record.expiresAt > now) continue;
      this.finish(record.preparationId, "expired");
      count += 1;
    }
    return count;
  }

  private expireIfDue(record: PreparationRecord): PreparationRecord {
    if ((record.status !== "active" && record.status !== "ready") || record.expiresAt > this.deps.clock.now()) return record;
    return this.finish(record.preparationId, "expired") ?? record;
  }

  recoverAfterRestart(): number {
    let count = 0;
    for (const record of this.deps.store.listByStatus(["active"])) {
      if (this.jobs.has(record.preparationId)) continue;
      this.finish(record.preparationId, "interrupted");
      count += 1;
    }
    return count;
  }

  /** Items whose preparations must survive GC (running jobs). */
  activeItemIds(): ReadonlySet<string> {
    return new Set([...this.jobs.values()].map((job) => job.record.itemId));
  }

  close(): void {
    for (const preparationId of [...this.jobs.keys()]) this.finish(asId<PreparationId>(preparationId), "interrupted");
  }

  toWire(record: PreparationRecord): PreparedItemV1 {
    return {
      protocolVersion: PROTOCOL_VERSION,
      preparationId: record.preparationId,
      version: record.version,
      itemId: record.itemId,
      status: record.status,
      expiresAt: new Date(record.expiresAt).toISOString(),
      stages: record.stages
    };
  }

  private async waitForSource(preparationId: PreparationId, waitMs: number, signal: AbortSignal): Promise<PreparationRecord> {
    const deadline = Date.now() + waitMs;
    let current = this.get(preparationId);
    while (current && !isStageSettled(current.stages.source) && current.status === "active") {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal.aborted) break;
      current = (await this.watchers.next(preparationId, remaining, signal)) ?? this.get(preparationId);
    }
    if (!current) throw appError("unavailable", "preparation_not_found");
    return current;
  }

  private enforceActiveLimit(request: PrepareRequestV1): void {
    const others = [...this.jobs.values()]
      .map((job) => job.record)
      .filter((record) => record.itemId !== request.itemId)
      .sort((a, b) => priority(a) - priority(b) || a.createdAt - b.createdAt);
    while (others.length >= this.deps.policy.activeItemLimit) {
      const victim = others.shift();
      if (victim) this.cancel(victim.preparationId);
    }
  }

  private async run(job: PreparationJob): Promise<void> {
    const signal = job.controller.signal;
    const request = job.record.request;
    let candidate: CandidateV1;
    try {
      candidate = await this.chooseCandidate(job, signal);
    } catch (error) {
      this.publish(job, (stages) => ({
        candidate: advance(stages.candidate, settledFromError(error, signal)),
        source: advance(stages.source, skipped("candidate-unavailable")),
        lyrics: advance(stages.lyrics, skipped("candidate-unavailable")),
        script: advance(stages.script, skipped("candidate-unavailable")),
        voice: advance(stages.voice, skipped("candidate-unavailable"))
      }));
      return;
    }
    this.publish(job, (stages) => ({
      ...stages,
      candidate: advance(stages.candidate, ready(candidate)),
      source: advance(stages.source, inProgress())
    }));

    if (request.narration) this.startCue(job, candidate.track);

    let resolution;
    try {
      resolution = await this.deps.sources.resolve(
        { itemId: request.itemId, track: candidate.track, reason: "initial", previousRevision: null, notAfter: job.record.expiresAt },
        signal
      );
      throwIfAborted(signal);
    } catch (error) {
      if (request.target.kind === "radio-candidate" && !signal.aborted) {
        this.deps.reservations.coolDown(job.record.preparationId, this.deps.clock.now() + this.deps.policy.failedCandidateCooldownMs);
      }
      const cueId = job.record.cueId;
      if (cueId && this.deps.cues.get(cueId)?.preparationId === job.record.preparationId) this.deps.cues.cancel(cueId);
      this.publish(job, (stages) => ({
        ...stages,
        source: advance(stages.source, settledFromError(error, signal)),
        lyrics: advance(stages.lyrics, skipped("source-unavailable")),
        script: advance(stages.script, skipped("source-unavailable")),
        voice: advance(stages.voice, skipped("source-unavailable"))
      }));
      return;
    }
    const media = resolution.media;
    if (job.record.cueId) this.deps.cues.noteTargetRevision(job.record.cueId, media.sourceRevision);
    this.publish(
      job,
      (stages) => ({
        ...stages,
        source: advance(stages.source, ready(media)),
        lyrics: request.wantLyrics ? advance(stages.lyrics, inProgress()) : stages.lyrics
      }),
      Math.min(job.record.expiresAt, resolution.expiresAt)
    );

    if (!request.wantLyrics) return;
    try {
      const result = await this.deps.lyrics.forRevision(
        { track: candidate.track, sourceRevision: media.sourceRevision, recordingId: media.recording.recordingId },
        signal
      );
      this.publish(job, (stages) => ({ ...stages, lyrics: advance(stages.lyrics, ready(result)) }));
    } catch (error) {
      this.publish(job, (stages) => ({ ...stages, lyrics: advance(stages.lyrics, settledFromError(error, signal)) }));
    }
  }

  private async chooseCandidate(job: PreparationJob, signal: AbortSignal): Promise<CandidateV1> {
    const { providers, radio, reservations, audits, history, clock, policy } = this.deps;
    const request = job.record.request;
    if (request.target.kind === "track") {
      const entry = providers.describe(request.target.track);
      if (!entry) throw appError("unavailable", "track_not_found", "track is not in the catalog");
      if (!entry.playable) throw appError("unavailable", "track_not_playable", "track has no playable source");
      return { track: entry.ref, display: entry.display };
    }

    const listening = history.recentRefs(RECENT_LISTENING_WINDOW);
    const recent = [...listening.started, ...listening.legacy];
    // Refs this job lost to another item while its pick was in flight; excluded from the re-pick.
    const lost: TrackRef[] = [];
    const scoped = withDeadline(signal, policy.candidateDeadlineMs);
    try {
      for (let attempt = 0; attempt <= policy.candidateReservationRetries; attempt += 1) {
        const pick = await raceAbort(radio.pick({ exclude: [...this.currentExclusions(job), ...lost], recent, signal: scoped.signal }), scoped.signal);
        throwIfAborted(scoped.signal);
        if (!pick) throw appError("unavailable", "no_candidate", "no radio candidate is available");
        if (this.jobs.get(job.record.preparationId) !== job) throw new OperationAbort("cancelled");
        // The pick awaited: other preparations may have reserved meanwhile. Check and reserve in one synchronous step.
        const reserved = reservations.tryReserve({
          itemId: request.itemId,
          preparationId: job.record.preparationId,
          track: pick.entry.ref,
          until: job.record.expiresAt,
          at: clock.now()
        });
        if (!reserved) {
          lost.push(pick.entry.ref);
          continue;
        }
        audits.insert({
          preparationId: job.record.preparationId,
          itemId: request.itemId,
          selected: pick.entry.ref,
          policy: pick.policy,
          reason: pick.reason,
          considered: pick.considered.slice(0, 12),
          createdAt: clock.now()
        });
        return { track: pick.entry.ref, display: pick.entry.display, reason: pick.reason.slice(0, 1000) };
      }
      throw appError("unavailable", "no_candidate", "every radio candidate picked was reserved by another item");
    } finally {
      scoped.dispose();
    }
  }

  /** Refs reserved by other items, cooling down after a failure, or already chosen by another running job. */
  private currentExclusions(job: PreparationJob): TrackRef[] {
    const exclude: TrackRef[] = [...this.deps.reservations.activeRefs(this.deps.clock.now())];
    for (const other of this.jobs.values()) {
      const stage = other.record.stages.candidate;
      if (other !== job && stage.status === "ready") exclude.push(stage.value.track);
    }
    return exclude;
  }

  private startCue(job: PreparationJob, target: TrackRef): void {
    const narration = job.record.request.narration;
    if (!narration) return;
    const mirror = (cue: { script: PreparationStages["script"]; voice: PreparationStages["voice"] }) =>
      this.publish(job, (stages) => ({ ...stages, script: advance(stages.script, cue.script), voice: advance(stages.voice, cue.voice) }));
    try {
      const cue = this.deps.cues.start({
        cueId: narration.cueId,
        transitionId: narration.transitionId,
        preparationId: job.record.preparationId,
        from: { itemId: narration.fromItemId, track: narration.fromTrack, sourceRevision: narration.fromRevision },
        to: { itemId: job.record.itemId, track: target, sourceRevision: null }
      });
      job.cleanups.push(this.deps.cues.subscribe(narration.cueId, mirror));
      mirror(cue);
    } catch (error) {
      this.publish(job, (stages) => ({
        ...stages,
        script: advance(stages.script, failed(settledError(error))),
        voice: advance(stages.voice, skipped("script-unavailable"))
      }));
    }
  }

  /** Terminal transition requested from outside the job (cancel/expire/interrupt). */
  private finish(preparationId: PreparationId, status: "cancelled" | "interrupted" | "expired"): PreparationRecord | null {
    const job = this.jobs.get(preparationId);
    const current = job?.record ?? this.deps.store.get(preparationId);
    if (!current) return null;
    if (TERMINAL.includes(current.status)) return current;
    if (job) {
      this.jobs.delete(preparationId);
      job.controller.abort(new OperationAbort("cancelled"));
      for (const cleanup of job.cleanups) cleanup();
    }
    if (current.cueId && this.deps.cues.get(current.cueId)?.preparationId === preparationId) {
      this.deps.cues.cancel(current.cueId, status === "interrupted" ? "interrupted" : "cancelled");
    }
    if (status === "expired" || status === "cancelled" || status === "interrupted") this.deps.reservations.release(current.itemId);
    const stageEnd = status === "expired" ? "expired" : status;
    const stages: PreparationStages = {
      candidate: terminate(current.stages.candidate, stageEnd),
      source: status === "expired" && current.stages.source.status === "ready" ? { status: "expired" } : terminate(current.stages.source, stageEnd),
      lyrics: terminate(current.stages.lyrics, stageEnd),
      script: terminate(current.stages.script, stageEnd),
      voice: terminate(current.stages.voice, stageEnd)
    };
    return this.persist(null, { ...current, stages, status });
  }

  /** Publishes the job's next version; dropped if the job is no longer the live owner. */
  private publish(job: PreparationJob, change: (stages: PreparationStages) => PreparationStages, expiresAt?: number): void {
    const id = job.record.preparationId;
    if (this.jobs.get(id) !== job) return;
    const stages = change(job.record.stages);
    const status = deriveStatus(stages);
    const next = this.persist(job, { ...job.record, stages, status, expiresAt: expiresAt ?? job.record.expiresAt });
    if (next.version !== job.record.version) {
      // Lost ownership (stored record moved on without us): stop this job.
      this.jobs.delete(id);
      job.controller.abort(new OperationAbort("cancelled"));
      for (const cleanup of job.cleanups) cleanup();
      return;
    }
    if (status !== "active" && this.jobs.get(id) === job) {
      this.jobs.delete(id);
      for (const cleanup of job.cleanups) cleanup();
    }
    if (status === "failed" || next.status === "failed") this.deps.reservations.release(job.record.itemId);
  }

  private persist(job: PreparationJob | null, record: PreparationRecord): PreparationRecord {
    const stored = this.deps.store.get(record.preparationId);
    // A job writes on top of the version it last wrote; anything newer (restart, other owner) wins.
    const expected = job ? job.record.version : stored?.version ?? record.version;
    const next: PreparationRecord = { ...record, version: expected + 1, updatedAt: this.deps.clock.now() };
    if (!this.deps.store.update(next, expected)) return stored ?? record;
    if (job) job.record = next;
    this.watchers.notify(next.preparationId, next);
    return next;
  }
}

function deriveStatus(stages: PreparationStages): PreparationStatusV1 {
  for (const stage of [stages.candidate, stages.source]) {
    if (stage.status === "failed" || stage.status === "timed-out") return "failed";
    if (stage.status === "cancelled") return "cancelled";
  }
  const all = [stages.candidate, stages.source, stages.lyrics, stages.script, stages.voice];
  return all.every(isStageSettled) ? (stages.source.status === "ready" ? "ready" : "failed") : "active";
}

function priority(record: PreparationRecord): number {
  return record.request.purpose === "standby" ? 0 : 1;
}

function settledError(error: unknown) {
  const stage = settledFromError(error, new AbortController().signal);
  return stage.status === "failed" ? stage.error : { class: "unavailable" as const, code: "cue_unavailable" };
}

