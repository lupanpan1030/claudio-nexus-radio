import type { Clock } from "../ports/runtime.js";
import type { CueStore, PreparationStore, ReservationStore, StreamHandleStore } from "../ports/stores.js";
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
}

/**
 * Expiry and collection. Records are removed only when expired past the GC
 * age and not referenced by a running job or the executor's current/next item.
 */
export class PlaybackGc {
  constructor(
    private readonly deps: {
      readonly preparations: PreparationService;
      readonly preparationStore: PreparationStore;
      readonly cueStore: CueStore;
      readonly handles: StreamHandleStore;
      readonly reservations: ReservationStore;
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
      voiceFiles: voices.collect(at)
    };
  }
}
