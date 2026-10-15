import type { TrackRef } from "@claudio/contracts";
import type { CatalogEntry } from "./catalog.js";

export interface RadioCandidateRequest {
  /** Hard exclusions: refs reserved by other active preparations or recently failed. */
  readonly exclude: readonly TrackRef[];
  /** Listening recency, most recent first (started facts first, then legacy selections). */
  readonly recent: readonly TrackRef[];
  readonly signal: AbortSignal;
}

export interface RadioCandidate {
  readonly entry: CatalogEntry;
  readonly reason: string;
  /** Policy label stored with the candidate audit. */
  readonly policy: string;
  /** Ranked alternatives considered, for the audit only. */
  readonly considered: readonly { readonly ref: TrackRef; readonly score: number }[];
}

/** Chooses one radio candidate. Choosing never records a play. */
export interface RadioCandidatePort {
  pick(request: RadioCandidateRequest): Promise<RadioCandidate | null>;
}
