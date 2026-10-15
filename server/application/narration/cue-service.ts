import {
  asId,
  isStageSettled,
  PROTOCOL_VERSION,
  type AssetId,
  type CueId,
  type NarrationResponseV1,
  type NarrationScript,
  type PreparationId,
  type QueueItemId,
  type SourceRevision,
  type TrackRef,
  type TransitionId
} from "@claudio/contracts";
import type { ScriptWriterPort } from "../../ports/narration.js";
import type { ProviderRegistry } from "../../ports/providers.js";
import type { Clock, IdSource } from "../../ports/runtime.js";
import type { CatalogEntry } from "../../ports/catalog.js";
import type { CueRecord, CueStore, ScriptStore, StartedStore } from "../../ports/stores.js";
import { OperationAbort, appError, throwIfAborted } from "../errors.js";
import { raceAbort, withDeadline } from "../operations.js";
import type { PlaybackPolicy } from "../policy.js";
import { advance, inProgress, pending, ready, settledFromError, skipped, terminate } from "../stages.js";
import { Watchers } from "../watchers.js";
import type { VoiceService } from "./voice-service.js";

export interface CueEndpoint {
  readonly itemId: QueueItemId;
  readonly track: TrackRef;
  readonly sourceRevision: SourceRevision | null;
}

export interface CueStart {
  readonly cueId: CueId;
  readonly transitionId: TransitionId;
  readonly preparationId: PreparationId | null;
  readonly from: CueEndpoint;
  readonly to: CueEndpoint;
}

/** How much listening history and recent wording a script writer is given. */
const RECENT_STARTED = 8;
const RECENT_GENERATED = 6;

interface CueJob {
  readonly controller: AbortController;
  record: CueRecord;
}

/**
 * Script + voice for one cue. Results are stored under the cue (and its
 * preparation), never under a track id, so earlier plays of the same track
 * are never rewritten. Stages only move forward; a cancelled cue drops any
 * result that arrives afterwards.
 */
export class CueService {
  private readonly jobs = new Map<string, CueJob>();
  private readonly watchers = new Watchers<CueRecord>();
  private readonly subscribers = new Map<string, Set<(record: CueRecord) => void>>();

  constructor(
    private readonly deps: {
      readonly store: CueStore;
      readonly scripts: ScriptStore;
      readonly started: StartedStore;
      readonly writer: ScriptWriterPort;
      readonly voices: VoiceService;
      readonly providers: ProviderRegistry;
      readonly clock: Clock;
      readonly ids: IdSource;
      readonly policy: PlaybackPolicy;
    }
  ) {}

  /** Starts a cue, or returns the existing one for a compatible repeat of the same cueId. */
  start(input: CueStart): CueRecord {
    const existing = this.deps.store.get(input.cueId);
    if (existing) {
      if (
        existing.transitionId !== input.transitionId ||
        existing.fromItemId !== input.from.itemId ||
        existing.toItemId !== input.to.itemId ||
        !sameTrack(existing.toTrack, input.to.track) ||
        !sameTrack(existing.fromTrack, input.from.track)
      ) {
        throw appError("invalid", "cue_conflict", "cueId already names a different hand-over");
      }
      return existing;
    }
    const now = this.deps.clock.now();
    const record: CueRecord = {
      cueId: input.cueId,
      transitionId: input.transitionId,
      preparationId: input.preparationId,
      fromItemId: input.from.itemId,
      toItemId: input.to.itemId,
      fromTrack: input.from.track,
      toTrack: input.to.track,
      fromRevision: input.from.sourceRevision,
      toRevision: input.to.sourceRevision,
      version: 0,
      script: inProgress(),
      voice: pending(),
      createdAt: now,
      updatedAt: now
    };
    this.deps.store.insert(record);
    const job: CueJob = { controller: new AbortController(), record };
    this.jobs.set(input.cueId, job);
    void this.run(job);
    return record;
  }

  get(cueId: CueId): CueRecord | null {
    return this.jobs.get(cueId)?.record ?? this.deps.store.get(cueId);
  }

  /**
   * Long-poll: returns once a version newer than `afterVersion` exists (when
   * afterVersion >= 0) or the cue settles, bounded by waitMs (wall time).
   */
  async wait(cueId: CueId, afterVersion: number, waitMs: number, signal: AbortSignal): Promise<CueRecord | null> {
    const deadline = Date.now() + Math.min(waitMs, this.deps.policy.maxLongPollMs);
    let current = this.get(cueId);
    while (current && !isCueSettled(current) && !(afterVersion >= 0 && current.version > afterVersion)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal.aborted) break;
      current = (await this.watchers.next(cueId, remaining, signal)) ?? this.get(cueId);
    }
    return current;
  }

  subscribe(cueId: CueId, listener: (record: CueRecord) => void): () => void {
    let set = this.subscribers.get(cueId);
    if (!set) {
      set = new Set();
      this.subscribers.set(cueId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.subscribers.delete(cueId);
    };
  }

  /** Records the next item's resolved revision once known (binding evidence for the stored cue). */
  noteTargetRevision(cueId: CueId, revision: SourceRevision): void {
    const job = this.jobs.get(cueId);
    const record = job?.record ?? this.deps.store.get(cueId);
    if (!record || record.toRevision === revision) return;
    this.write(job ?? null, { ...record, toRevision: revision }, false);
  }

  cancel(cueId: CueId, status: "cancelled" | "interrupted" = "cancelled"): CueRecord | null {
    const job = this.jobs.get(cueId);
    if (!job) return this.deps.store.get(cueId);
    this.jobs.delete(cueId);
    job.controller.abort(new OperationAbort("cancelled"));
    const record = { ...job.record, script: terminate(job.record.script, status), voice: terminate(job.record.voice, status) };
    return this.write(null, record, true);
  }

  /** After a restart no job is running: unsettled stages become "interrupted". */
  recoverAfterRestart(): number {
    let count = 0;
    for (const record of this.deps.store.listUnsettled()) {
      if (this.jobs.has(record.cueId)) continue;
      this.write(null, { ...record, script: terminate(record.script, "interrupted"), voice: terminate(record.voice, "interrupted") }, true);
      count += 1;
    }
    return count;
  }

  close(): void {
    for (const cueId of [...this.jobs.keys()]) this.cancel(asId<CueId>(cueId), "interrupted");
  }

  toResponse(record: CueRecord): NarrationResponseV1 {
    return {
      protocolVersion: PROTOCOL_VERSION,
      cueId: record.cueId,
      transitionId: record.transitionId,
      version: record.version,
      script: record.script,
      voice: record.voice
    };
  }

  private async run(job: CueJob): Promise<void> {
    const { providers, writer, scripts, voices, clock, ids, policy } = this.deps;
    const signal = job.controller.signal;
    const record = job.record;
    let script: NarrationScript;
    try {
      const to = providers.describe(record.toTrack);
      if (!to) throw appError("unavailable", "track_not_found", "next track is not in the catalog");
      const from = providers.describe(record.fromTrack);
      const recentGenerated = scripts.recent(RECENT_GENERATED).map((entry) => entry.text);
      const scoped = withDeadline(signal, policy.scriptDeadlineMs);
      try {
        const written = await raceAbort(
          writer.write({ to, from, recentStarted: this.recentStarted(), recentGenerated, signal: scoped.signal }),
          scoped.signal
        );
        throwIfAborted(scoped.signal);
        const text = written.text.trim().slice(0, 4000);
        if (!text) throw appError("unavailable", "script_empty", "script writer returned no text");
        script = {
          assetId: asId<AssetId>(ids.next("scr")),
          version: 1,
          text,
          // No trustworthy sentence timing exists: one plain-text segment, no invented times.
          subtitle: { timing: "plain-text", segments: [{ text }] }
        };
        if (!this.isCurrent(job)) return;
        scripts.insert({ script, cueId: record.cueId, writer: written.writer, createdAt: clock.now() });
      } finally {
        scoped.dispose();
      }
    } catch (error) {
      this.publish(job, (current) => ({
        ...current,
        script: advance(current.script, settledFromError(error, signal)),
        voice: advance(current.voice, skipped("script-unavailable"))
      }));
      return;
    }
    this.publish(job, (current) => ({ ...current, script: advance(current.script, ready(script)), voice: advance(current.voice, inProgress()) }));

    try {
      const voice = await voices.synthesize({ scriptAssetId: script.assetId, text: script.text }, signal);
      this.publish(job, (current) => ({ ...current, voice: advance(current.voice, ready(voice)) }));
    } catch (error) {
      this.publish(job, (current) => ({ ...current, voice: advance(current.voice, settledFromError(error, signal)) }));
    }
  }

  /** Distinct catalog entries of recent started facts, newest first; entries no longer in a catalog are skipped. */
  private recentStarted(): CatalogEntry[] {
    const seen = new Set<string>();
    const entries: CatalogEntry[] = [];
    for (const fact of this.deps.started.recent(RECENT_STARTED * 3)) {
      const key = `${fact.track.providerId}\n${fact.track.mediaId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = this.deps.providers.describe(fact.track);
      if (entry) entries.push(entry);
      if (entries.length >= RECENT_STARTED) break;
    }
    return entries;
  }

  /**
   * A job may write only while it owns the cue in this process AND the stored
   * version is the one it last wrote (a restart/other owner bumps it).
   */
  private isCurrent(job: CueJob): boolean {
    if (this.jobs.get(job.record.cueId) !== job) return false;
    if (this.deps.store.get(job.record.cueId)?.version === job.record.version) return true;
    this.jobs.delete(job.record.cueId);
    job.controller.abort(new OperationAbort("cancelled"));
    return false;
  }

  /** Publishes a new version unless the job was cancelled/replaced (late result → dropped). */
  private publish(job: CueJob, change: (record: CueRecord) => CueRecord): void {
    if (!this.isCurrent(job)) return;
    const next = change(job.record);
    const settled = isCueSettled(next);
    this.write(job, next, true);
    if (settled && this.jobs.get(next.cueId) === job) this.jobs.delete(next.cueId);
  }

  private write(job: CueJob | null, record: CueRecord, notify: boolean): CueRecord {
    const stored = this.deps.store.get(record.cueId);
    const expected = job ? job.record.version : stored?.version ?? record.version;
    const next: CueRecord = { ...record, version: expected + 1, updatedAt: this.deps.clock.now() };
    if (!this.deps.store.update(next, expected)) return stored ?? record;
    if (job) job.record = next;
    if (notify) {
      this.watchers.notify(next.cueId, next);
      for (const listener of this.subscribers.get(next.cueId) ?? []) listener(next);
    }
    return next;
  }
}

export function isCueSettled(record: CueRecord): boolean {
  return isStageSettled(record.script) && isStageSettled(record.voice);
}

function sameTrack(a: TrackRef, b: TrackRef): boolean {
  return a.providerId === b.providerId && a.mediaId === b.mediaId;
}
