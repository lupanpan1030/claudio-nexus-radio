import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { callLlmText, extractJson } from "./llm.js";
import type { Track } from "./types.js";

type FewShot = { id: number; title: string; body: string };

export type DjFewShotSelection = {
  content: string;
  selected: Array<{ id: number; title: string }>;
  source: "model" | "positive-library-fallback";
};

const personaPath = path.resolve(process.cwd(), "prompts", "dj-persona.md");
const fewShotPath = path.resolve(process.cwd(), "prompts", "dj-fewshot.md");

export async function readDjPersona() {
  return (await fs.readFile(personaPath, "utf8")).trim();
}

export async function selectDjFewShots(track: Track, signal?: AbortSignal): Promise<DjFewShotSelection> {
  const candidates = await readPositiveFewShots(track);
  const fallback = toSelection(candidates, "positive-library-fallback");
  if (candidates.length < 2) return fallback;

  const candidateText = candidates.map((sample) => `[${sample.id}] ${sample.title}\n${sample.body}`).join("\n\n");
  const messages = [
    {
      role: "system" as const,
      content: "你只负责为电台串词挑选参考范式，不写串词。请根据当前歌曲，选择最适合帮助本次创作的 2-3 条范式。只返回严格 JSON：{\"selected\":[编号]}。"
    },
    { role: "user" as const, content: `当前歌曲：${track.artist}《${track.title}》\n专辑：${track.album || "未知"}\n\n范式：\n${candidateText}` }
  ];
  const options = {
    responseFormat: "json_object" as const,
    temperature: 0.2,
    model: config.djAiModel,
    timeoutMs: Math.max(config.djAiTimeoutMs, 12000),
    signal
  };
  const first = await callLlmText(messages, "dj-fewshot-selector", options);
  let selectedIds = first ? parseSelectedIds(first, candidates) : [];
  if (selectedIds.length < 2) {
    const retry = await callLlmText(
      [...messages, { role: "user" as const, content: "请现在只返回 2-3 个有效范式编号的 JSON。" }],
      "dj-fewshot-selector-retry",
      { ...options, temperature: 0 }
    );
    selectedIds = retry ? parseSelectedIds(retry, candidates) : [];
  }

  const selected = selectedIds
    .map((id) => candidates.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is FewShot => Boolean(candidate));
  return selected.length >= 2 ? toSelection(selected, "model") : fallback;
}

export async function buildDjSystemPrompt(track?: Track | null, fewShotContent?: string) {
  const persona = await readDjPersona();
  const content = fewShotContent ?? toSelection(await readPositiveFewShots(track), "positive-library-fallback").content;
  return [persona, "参考范式：", content].filter(Boolean).join("\n\n");
}

async function readPositiveFewShots(currentTrack?: Track | null): Promise<FewShot[]> {
  const content = await fs.readFile(fewShotPath, "utf8");
  const currentTitle = currentTrack ? normalizeIdentity(stripTitleDecoration(currentTrack.title)) : "";
  const currentArtist = currentTrack ? normalizeIdentity(currentTrack.artist) : "";
  return content
    .split(/(?=^### \[歌曲：)/mu)
    .map((section, index) => {
      const match = section.match(/^### \[歌曲：(.+?)\]\s*\n([\s\S]*)$/mu);
      if (!match) return undefined;
      const title = match[1].trim();
      return { id: index, title, body: match[2].split(/^\s*-?(?:why|rejected)：.*$/mu)[0].trim() };
    })
    .filter((sample): sample is FewShot => Boolean(sample?.body))
    .filter((sample) => {
      if (!currentTitle || !currentArtist) return true;
      const identity = normalizeIdentity(sample.title);
      return !(identity.includes(currentTitle) && identity.includes(currentArtist));
    });
}

function parseSelectedIds(text: string, candidates: FewShot[]) {
  try {
    const parsed = JSON.parse(extractJson(text)) as { selected?: unknown };
    const validIds = new Set(candidates.map((sample) => sample.id));
    return Array.isArray(parsed.selected)
      ? [...new Set(parsed.selected.map(Number).filter((id) => validIds.has(id)))].slice(0, 3)
      : [];
  } catch {
    return [];
  }
}

function toSelection(samples: FewShot[], source: DjFewShotSelection["source"]): DjFewShotSelection {
  return {
    content: samples.map((sample) => `### [歌曲：${sample.title}]\n\n${sample.body}`).join("\n\n"),
    selected: samples.map((sample) => ({ id: sample.id, title: sample.title })),
    source
  };
}

function normalizeIdentity(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function stripTitleDecoration(value: string) {
  return value.replace(/\s*[（(][^）)]*[）)]\s*/g, " ").trim();
}
