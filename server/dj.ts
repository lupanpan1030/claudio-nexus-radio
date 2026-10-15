import { validateLockedDjDecision } from "./dj-contract.js";
import { formatHandoverContext, type DjHandoverContext } from "./dj-handover.js";
import { generateModelFirstDjLine } from "./dj-model-first.js";
export {
  generateProgramLine,
  type ProgramLineInput,
  type ProgramLineResult,
  type ProgramLineType
} from "./dj-program.js";
import {
  assessTrackLine,
  invalidContextDjLineReason,
  type TrackLineQuality,
  type TrackLineMode
} from "./dj-validator.js";
export type { TrackLineMode } from "./dj-validator.js";
export { invalidDjLineReason, invalidProgramLineReason } from "./dj-validator.js";
import { hasLlm } from "./llm.js";
import {
  getTrack,
  updateLatestPlayLine,
  updateLatestRecommendationAuditLine,
  updateLatestRadioPickLine
} from "./db.js";
import type { ClaudeDecision, RadioPick, Track } from "./types.js";

type DjLineInput = {
  songId: string;
  query?: string;
  reason?: string;
  moodTags?: string[];
  previousLine?: string;
  lineMode?: TrackLineMode;
  recentLinesOverride?: string[];
  /** Skips the legacy history line write-back (radio_picks/audits/plays). */
  dryRun?: boolean;
  signal?: AbortSignal;
};

type DjLineResult = {
  songId: string;
  djLine: string;
  source: "ai" | "rules";
  usedLlm: boolean;
  rejectedReason?: string;
  rawDjLine?: string;
  decision?: ClaudeDecision;
  lineMode?: TrackLineMode;
  quality?: TrackLineQuality;
};

function cleanLine(value: string) {
  return value
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

export async function generateDjLine(input: DjLineInput): Promise<DjLineResult> {
  const track = getTrack(input.songId);
  if (!track) {
    throw new Error("track not found");
  }
  return generateDjLineForTrack({ ...input, track });
}

/**
 * Same writer for a track given by metadata (e.g. a catalog entry without a
 * legacy row), with the v1 hand-over context. Only title/artist/album reach
 * the prompt; nothing is written back unless dryRun is false.
 */
export async function generateDjLineForTrack(input: Omit<DjLineInput, "songId"> & { track: Track; handover?: DjHandoverContext }): Promise<DjLineResult> {
  const { track } = input;
  const lineMode: TrackLineMode = "plain_note";
  if (!hasLlm()) throw new Error("AI DJ is not configured");

  const { decision, usedFallbackDecision } = await generateModelFirstDjLine({
    track,
    query: input.query,
    reason: input.reason,
    contextProfile: "minimal",
    handoverContext: input.handover ? formatHandoverContext(input.handover) : undefined,
    signal: input.signal
  });
  if (input.signal?.aborted) throw new Error("DJ line request was cancelled");
  const djLine = cleanLine(decision.say);
  const validation = validateLockedDjDecision({
    decision,
    track,
    say: djLine,
    invalidReason: invalidContextDjLineReason(djLine, track),
    usedFallbackDecision
  });
  if (!validation.ok || !validation.decision) {
    if (input.dryRun) {
      return {
        songId: track.id,
        djLine,
        source: "ai",
        usedLlm: true,
        rejectedReason: validation.reason ?? "AI DJ output is invalid",
        rawDjLine: djLine,
        decision,
        lineMode,
        quality: assessTrackLine(djLine, lineMode)
      };
    }
    throw new Error(validation.reason ?? "AI DJ output is invalid");
  }

  if (!input.dryRun) {
    updateLatestRadioPickLine(track.id, djLine);
    updateLatestRecommendationAuditLine(track.id, djLine);
    updateLatestPlayLine(track.id, djLine);
  }

  return {
    songId: track.id,
    djLine,
    source: "ai",
    usedLlm: true,
    rawDjLine: djLine,
    decision: validation.decision,
    lineMode,
    quality: assessTrackLine(djLine, lineMode)
  };
}

export function pickToDjLineInput(pick: RadioPick, query = ""): DjLineInput {
  return {
    songId: pick.songId,
    query,
    reason: pick.reason,
    moodTags: pick.moodTags,
    previousLine: pick.djLine
  };
}
