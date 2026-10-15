import type { TrackRef } from "@claudio/contracts";
import { appError } from "../../application/errors.js";
import { raceAbort } from "../../application/operations.js";
import type { CatalogEntry } from "../../ports/catalog.js";
import type { ScriptRequest, ScriptWriterPort, WrittenScript } from "../../ports/narration.js";
import type { RadioCandidate, RadioCandidatePort, RadioCandidateRequest } from "../../ports/radio.js";

/** Legacy single-song DJ line generator, called only in dry-run (no history write-back). */
export type LegacyDjLineGenerator = (input: {
  songId: string;
  reason?: string;
  dryRun: true;
  signal: AbortSignal;
}) => Promise<{ djLine: string; rejectedReason?: string }>;

/**
 * Reuses the existing model-first DJ writer, locked song, few-shots and
 * validator. Dry-run only: the legacy route's write-back to radio_picks /
 * audits / plays by track id never happens from here.
 */
export class LegacyModelScriptWriter implements ScriptWriterPort {
  constructor(private readonly generate: LegacyDjLineGenerator, private readonly configured: () => boolean) {}

  async write(request: ScriptRequest): Promise<WrittenScript> {
    if (!this.configured()) throw appError("unavailable", "script_writer_not_configured", "AI DJ is not configured");
    const songId = request.to.legacyTrackId;
    if (!songId) throw appError("unavailable", "script_writer_unsupported_track", "the DJ writer only knows catalog tracks");
    let result: { djLine: string; rejectedReason?: string };
    try {
      result = await raceAbort(this.generate({ songId, dryRun: true, signal: request.signal }), request.signal);
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw appError("retryable", "script_writer_failed", error instanceof Error ? error.message : undefined, error);
    }
    if (result.rejectedReason) throw appError("unavailable", "script_rejected", result.rejectedReason);
    return { text: result.djLine, writer: "model" };
  }
}

export type LegacyRadioChooser = (options: {
  recentTrackIds: readonly string[];
  excludeTrackIds: ReadonlySet<string>;
}) => Promise<{ track: { id: string }; reason: string; ranked: Array<{ id: string; score: number }> } | null>;

/**
 * The existing rules ranking (taste, scene, family mix, recency) applied to
 * catalog refs. Choosing writes nothing; refs are mapped through the
 * composition's legacy id rule.
 */
export class LegacyRulesRadioCandidates implements RadioCandidatePort {
  constructor(
    private readonly deps: {
      readonly choose: LegacyRadioChooser;
      readonly toLegacyId: (ref: TrackRef) => string | null;
      readonly describeLegacy: (legacyTrackId: string) => CatalogEntry | null;
    }
  ) {}

  async pick(request: RadioCandidateRequest): Promise<RadioCandidate | null> {
    const ids = (refs: readonly TrackRef[]) => refs.map(this.deps.toLegacyId).filter((id): id is string => id !== null);
    const choice = await raceAbort(
      this.deps.choose({ recentTrackIds: ids(request.recent), excludeTrackIds: new Set(ids(request.exclude)) }),
      request.signal
    );
    if (!choice) return null;
    const entry = this.deps.describeLegacy(choice.track.id);
    if (!entry) return null;
    const considered = choice.ranked
      .map((item) => {
        const candidate = this.deps.describeLegacy(item.id);
        return candidate ? { ref: candidate.ref, score: item.score } : null;
      })
      .filter((item): item is { ref: TrackRef; score: number } => item !== null);
    return { entry, reason: choice.reason, policy: "legacy-rules-v1", considered };
  }
}
