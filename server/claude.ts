import { callLlmText, extractJson } from "./llm.js";
import type { ClaudeDecision, ClaudeSegue, ContextAssembly } from "./types.js";

type ResolveDecisionParams = {
  context: ContextAssembly;
  candidateIds: string[];
  fallbackDecision: ClaudeDecision;
  preferredCount?: number;
  label: string;
  sayInstruction?: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  reasoningEffort?: string;
  musicKnowledgeMode?: "restricted" | "model-first";
  minimalExecutionContract?: boolean;
  signal?: AbortSignal;
};

type RawDecision = {
  say?: unknown;
  play?: unknown;
  reason?: unknown;
  segue?: unknown;
};

const allowedSegues = new Set<ClaudeSegue>(["fade_in", "direct", "talk_first"]);

function normalizeSegue(value: unknown): ClaudeSegue {
  return typeof value === "string" && allowedSegues.has(value as ClaudeSegue)
    ? (value as ClaudeSegue)
    : "fade_in";
}

function normalizeDecision(
  value: RawDecision,
  candidateIds: string[],
  fallbackDecision: ClaudeDecision,
  preferredCount: number
): ClaudeDecision | undefined {
  const safeCandidateIds = new Set(candidateIds);
  const play = Array.isArray(value.play)
    ? value.play
        .map((item) => String(item ?? "").trim())
        .filter((songId) => songId && safeCandidateIds.has(songId))
    : [];

  const normalizedPlay = [...new Set(play)].slice(0, Math.max(1, preferredCount));
  if (normalizedPlay.length === 0 && candidateIds.length === 1 && preferredCount === 1) {
    normalizedPlay.push(candidateIds[0]);
  }
  if (normalizedPlay.length === 0) return undefined;

  const say = String(value.say ?? "").trim() || fallbackDecision.say;
  const reason = String(value.reason ?? "").trim() || fallbackDecision.reason;

  return {
    say,
    play: normalizedPlay,
    reason,
    segue: normalizeSegue(value.segue)
  };
}

export async function resolveClaudeDecision(params: ResolveDecisionParams): Promise<ClaudeDecision> {
  const preferredCount = Math.max(1, params.preferredCount ?? 1);
  const executionContract = [
    "Return strict JSON only.",
    'Required shape: {"say": string, "play": string[], "reason": string, "segue": "fade_in"|"direct"|"talk_first"}',
    `Pick only from these candidate IDs: ${params.candidateIds.join(", ") || "(none)"}`,
    `For this request, prefer ${preferredCount} song id${preferredCount > 1 ? "s" : ""} in play.`,
    params.sayInstruction ?? "say is for the DJ voice line.",
    "reason is internal only.",
    "Do not output markdown."
  ];
  const instruction = params.minimalExecutionContract
    ? executionContract.join("\n")
    : [
    ...executionContract,
    params.musicKnowledgeMode === "model-first"
      ? "You may use general cultural knowledge and creative judgment. Do not state a precise song, artist, or release fact as certain unless you are confident it is correct."
      : "Do not mention song origin, film/game/anime source, song history, production background, chart facts, or artist biography.",
    "Do not mention rain, weather, clouds, sunshine, temperature, or season unless the prompt provides verified weather.",
    "Avoid repeating fixed templates such as '接下来是', '这一首是', '这一首来自', or other generic host lead-ins unless the request is direct playback."
  ].join("\n");

  const messages = params.context.messages.map((message, index) =>
    index === params.context.messages.length - 1 && message.role === "user"
      ? { ...message, content: `${message.content}\n\n## Task\n${instruction}` }
      : message
  );
  const text = await callLlmText(
    messages,
    params.label,
    {
      responseFormat: "json_object",
      temperature: params.temperature ?? 0.4,
      model: params.model,
      timeoutMs: params.timeoutMs,
      reasoningEffort: params.reasoningEffort,
      signal: params.signal
    }
  );

  if (!text) return params.fallbackDecision;

  try {
    const parsed = JSON.parse(extractJson(text)) as RawDecision;
    return normalizeDecision(parsed, params.candidateIds, params.fallbackDecision, preferredCount) ?? params.fallbackDecision;
  } catch (error) {
    console.warn(`${params.label} decision parse failed: ${error instanceof Error ? error.message : error}`);
    return params.fallbackDecision;
  }
}
