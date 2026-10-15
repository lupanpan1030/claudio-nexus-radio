import { formatCalendarEnvironment, formatSchedulerHint, getCalendarContext } from "./calendar.js";
import { buildDjSystemPrompt } from "./dj-fewshot.js";
import {
  getMemories,
  getPreferenceProfile,
  getRecentChat,
  getRecentPlays,
  getTasteSummary
} from "./db.js";
import { getUserProfileDocs } from "./userProfile.js";
import { formatSanitizedWeatherLine, sanitizeWeatherForDj } from "./weather.js";
import type {
  ClaudeRequestMode,
  ContextAssembly,
  ContextFragment,
  SanitizedCalendarContext,
  SanitizedWeatherContext,
  Track,
  WeatherContext
} from "./types.js";

type BuildContextParams = {
  mode: ClaudeRequestMode;
  djContentMode?: "model-first";
  userMessage: string;
  weather?: WeatherContext;
  sanitizedWeather?: SanitizedWeatherContext;
  calendar?: SanitizedCalendarContext;
  candidates?: Track[];
  currentTrack?: Track | null;
  queue?: Track[];
  docs?: Awaited<ReturnType<typeof getUserProfileDocs>>;
  toolResults?: string[];
  systemState?: string[];
  memoryNotes?: string[];
  includeRecentChat?: boolean;
  includeLongTermMemory?: boolean;
  includeInterviewTail?: boolean;
  includeTasteSignals?: boolean;
  includeRecentPlays?: boolean;
  minimalDjContext?: boolean;
  djFewShotContent?: string;
  /** Formatted hand-over block (previous track, recent started tracks, recent generated lines); omitted when empty. */
  djHandoverContext?: string;
};

function formatBlock(title: string, content: string) {
  return `## ${title}\n${content.trim() || "(empty)"}`;
}

function stringifyList(items: string[]) {
  return items.length > 0 ? items.join("\n") : "(none)";
}

function summarizeMemoryRows(items: Array<{ source?: unknown; content?: unknown }>, limit = 6) {
  if (items.length === 0) return "(none)";
  return items
    .slice(0, limit)
    .map((item) => `${String(item.source ?? "memory")}: ${String(item.content ?? "").trim()}`)
    .join("\n");
}

function summarizeTasteEvents(
  rows: Array<{ artist?: unknown; title?: unknown; action?: unknown; created_at?: unknown }>,
  limit = 8
) {
  if (rows.length === 0) return "(none)";
  return rows
    .slice(0, limit)
    .map((row) => `${String(row.action ?? "event")} | ${String(row.artist ?? "")} - ${String(row.title ?? "")}`)
    .join("\n");
}

function summarizePreferenceProfile(profile: ReturnType<typeof getPreferenceProfile>) {
  const likedArtists = Array.isArray(profile.likedArtists)
    ? profile.likedArtists
        .slice(0, 6)
        .map((item) => `${String((item as Record<string, unknown>).artist ?? "")} (${String((item as Record<string, unknown>).count ?? 0)})`)
    : [];
  const skippedArtists = Array.isArray(profile.skippedArtists)
    ? profile.skippedArtists
        .slice(0, 4)
        .map((item) => `${String((item as Record<string, unknown>).artist ?? "")} (${String((item as Record<string, unknown>).count ?? 0)})`)
    : [];
  const sceneTags = Array.isArray(profile.sceneTags)
    ? profile.sceneTags
        .slice(0, 6)
        .map((item) => `${String((item as Record<string, unknown>).action ?? "")} (${String((item as Record<string, unknown>).count ?? 0)})`)
    : [];

  return [
    `Liked artists: ${likedArtists.length > 0 ? likedArtists.join(", ") : "(none)"}`,
    `Skipped artists: ${skippedArtists.length > 0 ? skippedArtists.join(", ") : "(none)"}`,
    `Scene tags: ${sceneTags.length > 0 ? sceneTags.join(", ") : "(none)"}`
  ].join("\n");
}

function summarizeCandidates(candidates: Track[]) {
  return candidates.length > 0
    ? candidates
        .slice(0, 80)
        .map((track, index) => `${index + 1}. ${track.id} | ${track.artist} - ${track.title} | ${track.album}`)
        .join("\n")
    : "(no candidates)";
}

function summarizeQueue(queue: Track[]) {
  return queue.length > 0
    ? queue.map((track, index) => `${index + 1}. ${track.artist} - ${track.title}`).join("\n")
    : "(queue empty)";
}

function formatCurrentSong(track?: Track | null) {
  if (!track) return "No locked song is available.";
  return [
    `当前点播歌曲：${track.artist}《${track.title}》`,
    `专辑：${track.album || "(未知)"}`
  ].join("\n");
}

export async function buildContext(params: BuildContextParams): Promise<ContextAssembly> {
  const minimalDjContext = params.mode === "dj-line" && params.djContentMode === "model-first" && params.minimalDjContext === true;
  if (minimalDjContext) {
    const systemPrompt = await buildDjSystemPrompt(params.currentTrack, params.djFewShotContent);
    const currentSong = formatBlock(
      "Current Song",
      [
        `当前点播歌曲：${params.currentTrack?.artist || ""}《${params.currentTrack?.title || ""}》`,
        `专辑：${params.currentTrack?.album || "(未知)"}`,
        "",
        params.userMessage || "请为这首歌写一段可直接播出的私人电台串词。"
      ].join("\n")
    );
    const userInputContext = params.djHandoverContext?.trim()
      ? `${currentSong}\n\n${formatBlock("Hand-over", params.djHandoverContext)}`
      : currentSong;
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: `Mode: ${params.mode}\n\n${userInputContext}` }
    ];

    return {
      mode: params.mode,
      systemPrompt,
      userCorpus: "",
      environmentContext: "",
      memoryContext: "",
      userInputContext,
      executionContext: "",
      fragments: [
        { key: "systemPrompt" as const, title: "System Prompt", content: systemPrompt },
        { key: "userInputContext", title: "User Input", content: userInputContext }
      ],
      assembledPrompt: [formatBlock("System Prompt", systemPrompt), userInputContext].join("\n\n"),
      messages
    };
  }
  const docs = params.docs ?? (await getUserProfileDocs());
  const recentPlays = params.includeRecentPlays === false ? [] : getRecentPlays(10);
  const recentChat = params.includeRecentChat === false ? [] : getRecentChat(10);
  const memories = params.includeLongTermMemory === false ? [] : getMemories(12);
  const tasteSummary = params.includeTasteSignals === false ? [] : getTasteSummary(20);
  const preferenceProfile =
    params.includeTasteSignals === false
      ? { likedArtists: [], skippedArtists: [], sceneTags: [], memories: [] }
      : getPreferenceProfile();
  const systemPrompt = await buildDjSystemPrompt(params.currentTrack, params.djFewShotContent);
  const weatherForContext = params.sanitizedWeather ?? sanitizeWeatherForDj(params.weather);
  const calendarForContext = params.calendar ?? getCalendarContext();

  const userCorpus = formatBlock(
    "User Corpus",
    [
      "### taste.md",
      docs.taste,
      "",
      "### routines.md",
      docs.routines,
      "",
      "### mood-rules.md",
      docs.moodRules,
    ].join("\n")
  );

  const environmentContext = formatBlock(
    "Environment",
    [
      `Now: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      `Weather: ${formatSanitizedWeatherLine(weatherForContext)}`,
      formatCalendarEnvironment(calendarForContext),
      params.mode === "dj-line" && params.djContentMode === "model-first"
        ? "Environment guides rhythm and pacing only; do not turn it into a literal listener scene."
        : "Environment guides music selection and pacing; do not treat it as song background."
    ].join("\n")
  );

  const memoryContext = formatBlock(
    "Memory",
    [
      "### Recent plays",
      stringifyList(recentPlays.slice(0, 8).map((track) => `${track.id} | ${track.artist} - ${track.title}`)),
      "",
      "### Recent chat",
      stringifyList(recentChat.slice(-4).map((item) => `${String(item.role)}: ${String(item.content)}`)),
      "",
      "### Long-term memories",
      summarizeMemoryRows(memories),
      "",
      "### Workflow memory",
      stringifyList(params.memoryNotes ?? []),
      "",
      "### Taste events",
      summarizeTasteEvents(tasteSummary as Array<{ artist?: unknown; title?: unknown; action?: unknown; created_at?: unknown }>),
      "",
      "### Preference profile",
      summarizePreferenceProfile(preferenceProfile)
    ].join("\n")
  );

  const userInputContext = formatBlock(
    params.mode === "dj-line" && params.djContentMode === "model-first" ? "Current Song" : "Request and Candidates",
    [
      `Mode: ${params.mode}`,
      `User message: ${params.userMessage || "(empty)"}`,
      "",
      "### Tool results",
      stringifyList(params.toolResults ?? []),
      "",
      "### Candidate songs",
      summarizeCandidates(params.candidates ?? []),
      "",
      params.mode === "dj-line" && params.djContentMode === "model-first" ? "### Locked song context" : "### Current song",
      params.mode === "dj-line" && params.djContentMode === "model-first"
        ? formatCurrentSong(params.currentTrack)
        : formatCurrentSong(params.currentTrack)
    ].join("\n")
  );

  const executionContext = formatBlock(
    "Execution State",
    [
      `Current track: ${
        params.currentTrack ? `${params.currentTrack.id} | ${params.currentTrack.artist} - ${params.currentTrack.title}` : "(none)"
      }`,
      "",
      "### Queue state",
      summarizeQueue(params.queue ?? []),
      "",
      "### Scheduler state",
      formatSchedulerHint(calendarForContext),
      "",
      "### Runtime flags",
      stringifyList(params.systemState ?? ["Voice broadcast available", "Current API surface must remain backward compatible"])
    ].join("\n")
  );

  const fragments: ContextFragment[] = [
    { key: "systemPrompt" as const, title: "System Prompt", content: systemPrompt },
    { key: "userCorpus", title: "User Corpus", content: minimalDjContext ? "" : userCorpus },
    { key: "environmentContext", title: "Environment", content: minimalDjContext ? "" : environmentContext },
    { key: "memoryContext", title: "Memory", content: minimalDjContext ? "" : memoryContext },
    { key: "userInputContext", title: "User Input", content: userInputContext },
    { key: "executionContext", title: "Execution", content: minimalDjContext ? "" : executionContext }
  ];

  const assembledPrompt = fragments.map((fragment) => formatBlock(fragment.title, fragment.content)).join("\n\n");
  const userContextPrompt = fragments
    .slice(1)
    .filter((fragment) => fragment.content.trim())
    .map((fragment) => formatBlock(fragment.title, fragment.content))
    .join("\n\n");
  const messages = [
    {
      role: "system" as const,
      content: systemPrompt
    },
    {
      role: "user" as const,
      content: [
        `Mode: ${params.mode}`,
        userContextPrompt
      ].join("\n\n")
    }
  ];

  return {
    mode: params.mode,
    systemPrompt,
    userCorpus,
    environmentContext,
    memoryContext,
    userInputContext,
    executionContext,
    fragments,
    assembledPrompt,
    messages
  };
}
