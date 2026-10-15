import type { TrackRef } from "@claudio/contracts";
import type { ProviderRegistry } from "../ports/providers.js";
import type { Clock } from "../ports/runtime.js";
import { raceAbort } from "./operations.js";
import type { PlaybackPolicy } from "./policy.js";

interface MemoEntry {
  readonly playable: boolean;
  readonly until: number;
}

/**
 * "Could this play right now?" for filtering lists of candidates (chat,
 * playlist, radio queue). It is not an identity check and never vouches for
 * a recording: playback still resolves and verifies the actual source.
 *
 * The catalog row must say playable; then a provider's cheap check is used
 * when it has one (asked every time, it is cheap). Otherwise a real resolve
 * answers, remembered briefly per ref and provider scope (e.g. signed-in
 * account): positive answers for playabilityMemoMs, negative ones for less.
 * Concurrent checks of one key share a single resolve.
 */
export class PlayabilityChecker {
  private readonly memo = new Map<string, MemoEntry>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly deps: {
      readonly providers: ProviderRegistry;
      readonly clock: Clock;
      readonly policy: PlaybackPolicy;
    }
  ) {}

  async check(ref: TrackRef, signal: AbortSignal): Promise<boolean> {
    const module = this.deps.providers.get(ref.providerId);
    const entry = this.deps.providers.describe(ref);
    if (!module || !entry?.playable) return false;
    const source = module.source;
    if (source.checkPlayable) {
      try {
        return await source.checkPlayable(ref, signal);
      } catch {
        return false;
      }
    }
    const key = JSON.stringify([ref.providerId, ref.mediaId, source.playabilityScope?.() ?? ""]);
    const now = this.deps.clock.now();
    const remembered = this.memo.get(key);
    if (remembered && remembered.until > now) return remembered.playable;
    let flight = this.inFlight.get(key);
    if (!flight) {
      // The shared resolve has its own deadline: one caller leaving does not decide the answer for the others.
      flight = source
        .resolve(ref, { signal: AbortSignal.timeout(this.deps.policy.sourceDeadlineMs), reason: "initial", previous: null })
        .then(
          () => true,
          () => false
        )
        .then((playable) => {
          this.remember(key, playable);
          return playable;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, flight);
    }
    try {
      return await raceAbort(flight, signal);
    } catch {
      return false;
    }
  }

  private remember(key: string, playable: boolean): void {
    const { policy, clock } = this.deps;
    this.memo.delete(key);
    this.memo.set(key, { playable, until: clock.now() + (playable ? policy.playabilityMemoMs : policy.playabilityNegativeMemoMs) });
    while (this.memo.size > policy.playabilityMemoEntries) this.memo.delete(this.memo.keys().next().value as string);
  }
}
