import { resolveClaudeDecision } from "./claude.js";
import { config } from "./config.js";
import { buildContext } from "./context.js";
import { buildLockedDjFallbackDecision } from "./dj-contract.js";
import { selectDjFewShots } from "./dj-fewshot.js";
import type { ClaudeDecision, Track } from "./types.js";

export function buildModelFirstDjLineInstruction() {
  return "Write a natural spoken Chinese paragraph for the locked song.";
}

export async function generateModelFirstDjLine(input: {
  track: Track;
  query?: string;
  reason?: string;
  contextProfile?: "full" | "minimal";
  /** Formatted hand-over block for the minimal DJ context. */
  handoverContext?: string;
  signal?: AbortSignal;
}) {
  const contextProfile = input.contextProfile ?? "minimal";
  const fewShotSelection = await selectDjFewShots(input.track, input.signal);
  const fallbackDecision = buildLockedDjFallbackDecision({
    track: input.track,
    say: "",
    selectionReason: input.reason || "model-first experiment"
  });
  const context = await buildContext({
    mode: "dj-line",
    djContentMode: "model-first",
    userMessage: input.query || "请为这首歌写一段可直接播出的私人电台串词。",
    candidates: [input.track],
    currentTrack: input.track,
    includeRecentChat: false,
    includeLongTermMemory: false,
    includeInterviewTail: false,
    includeTasteSignals: false,
    includeRecentPlays: false,
    minimalDjContext: contextProfile === "minimal",
    djFewShotContent: fewShotSelection.content,
    djHandoverContext: input.handoverContext
  });
  const decision = await resolveClaudeDecision({
    context,
    candidateIds: [input.track.id],
    fallbackDecision,
    preferredCount: 1,
    label: "dj-model-first",
    sayInstruction: buildModelFirstDjLineInstruction(),
    temperature: Math.max(0.7, config.djAiTemperature),
    model: config.djAiModel,
    timeoutMs: Math.max(config.djAiTimeoutMs, 12000),
    reasoningEffort: config.djAiReasoningEffort,
    musicKnowledgeMode: "model-first",
    minimalExecutionContract: true,
    signal: input.signal
  });

  return {
    decision,
    usedFallbackDecision: decision === fallbackDecision,
    context,
    fewShotSelection
  } satisfies {
    decision: ClaudeDecision;
    usedFallbackDecision: boolean;
    context: Awaited<ReturnType<typeof buildContext>>;
    fewShotSelection: Awaited<ReturnType<typeof selectDjFewShots>>;
  };
}
