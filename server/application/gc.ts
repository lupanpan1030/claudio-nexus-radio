import { asId, type QueueItemId, type TrackRef } from "@claudio/contracts";
import type { ProviderRegistry } from "../ports/providers.js";
import type { Clock } from "../ports/runtime.js";
import type { CueStore, PreparationStore, ReservationStore, ResolvedSourceStore, ScrubCursor, StreamHandleStore } from "../ports/stores.js";
import type { VoiceService } from "./narration/voice-service.js";
import type { NowService } from "./now/now-service.js";
import type { PlaybackPolicy } from "./policy.js";
import type { PreparationService } from "./preparation/preparation-service.js";

export interface GcReport {
  readonly expired: number;
  readonly preparations: number;
  readonly cues: number;
  readonly handles: number;
  readonly reservations: number;
  readonly voiceFiles: number;
  readonly scrubbedBindings: number;
}

/**
 * Bindings examined per GC run. Each run continues after the last record the
 * previous run examined and starts over once it reaches the end, so records
 * that stay protected cannot keep later ones from ever being examined.
 */
const SCRUB_BATCH = 200;

/**
 * Expiry and collection. Records are removed only when expired past the GC
 * age and not referenced by a running job or the executor's current/next item.
 *
 * Resolved-source rows are never removed: they are the revision → ref /
 * recording identity that started facts, lyrics and history check against.
 * Only the private, short-lived parts of their bindings (as the provider
 * defines them through `scrubBinding`) are erased once the binding is past
 * its load deadline plus the stream grace and no retained handle, running
 * job, or executor-reported current/next item still uses that revision. What
 * a provider needs to prove continuity on refresh stays. Lyrics assets are
 * kept: they are cached per exact revision, so they never describe another
 * recording.
 */
export class PlaybackGc {
  /** In memory only: after a restart the scan starts from the oldest record again. */
  private scrubCursor: ScrubCursor | null = null;

  constructor(
    private readonly deps: {
      readonly preparations: PreparationService;
      readonly preparationStore: PreparationStore;
      readonly cueStore: CueStore;
      readonly handles: StreamHandleStore;
      readonly reservations: ReservationStore;
      readonly resolvedSources: ResolvedSourceStore;
      readonly providers: ProviderRegistry;
      readonly voices: VoiceService;
      readonly now: NowService;
      readonly clock: Clock;
      readonly policy: PlaybackPolicy;
    }
  ) {}

  run(): GcReport {
    const { preparations, preparationStore, cueStore, handles, reservations, voices, now, clock, policy } = this.deps;
    const at = clock.now();
    const expired = preparations.expireDue(at);
    const protectedItems = new Set([...preparations.activeItemIds(), ...now.referencedItemIds()]);
    const removedPreparations = preparationStore.deleteExpired(at - policy.gcAfterMs, protectedItems);
    const keep = new Set(
      preparationStore.listByStatus(["active", "ready", "failed", "cancelled", "interrupted", "expired"]).map((record) => record.preparationId as string)
    );
    return {
      expired,
      preparations: removedPreparations,
      cues: cueStore.deleteOlderThan(at - policy.gcAfterMs, keep),
      handles: handles.deleteRetainedBefore(at),
      reservations: reservations.deleteExpired(at),
      voiceFiles: voices.collect(at),
      scrubbedBindings: this.scrubBindings(at, protectedItems)
    };
  }

  private scrubBindings(at: number, protectedItems: ReadonlySet<string>): number {
    const { resolvedSources, handles, providers, preparationStore, policy } = this.deps;
    const due = resolvedSources.listScrubbable(at - policy.streamGraceMs, policy.maxTtlMs, SCRUB_BATCH, this.scrubCursor);
    const last = due.at(-1);
    this.scrubCursor = due.length === SCRUB_BATCH && last ? { lastSeenAt: last.lastSeenAt, sourceRevision: last.sourceRevision } : null;
    if (due.length === 0) return 0;
    const inUse = new Set(handles.retainedRevisions(at));
    // An expired preparation no longer carries its source value, so items are protected by their track:
    // every revision of a ref the executor reports, or a running/referenced preparation chose, is kept.
    const refKey = (ref: TrackRef) => `${ref.providerId}\n${ref.mediaId}`;
    const usedRefs = new Set<string>();
    const reported = this.deps.now.get()?.item?.track;
    if (reported) usedRefs.add(refKey(reported));
    for (const itemId of protectedItems) {
      const stages = preparationStore.latestForItem(asId<QueueItemId>(itemId))?.stages;
      if (stages?.candidate.status === "ready") usedRefs.add(refKey(stages.candidate.value.track));
      if (stages?.source.status === "ready") inUse.add(stages.source.value.sourceRevision);
    }
    let scrubbed = 0;
    for (const record of due) {
      if (inUse.has(record.sourceRevision) || usedRefs.has(refKey(record.track))) continue;
      const source = providers.get(record.track.providerId)?.source;
      if (!source) continue;
      let replacement;
      try {
        replacement = source.scrubBinding?.(record.binding) ?? null;
      } catch {
        continue;
      }
      // Bindings without private parts are only marked, so they are not examined again.
      if (resolvedSources.markScrubbed(record.sourceRevision, record.lastSeenAt, replacement ?? record.binding, at) && replacement) scrubbed += 1;
    }
    return scrubbed;
  }
}
