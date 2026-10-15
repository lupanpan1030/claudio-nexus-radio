import { config } from "./config.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

type ResponsesApiResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
  }>;
};

type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type LlmCallOptions = {
  temperature?: number;
  responseFormat?: "json_object" | "text";
  model?: string;
  timeoutMs?: number;
  reasoningEffort?: string;
  profile?: "default" | "chat";
  /** Aborts the HTTP request and body read; an aborted call returns undefined without trying fallbacks. */
  signal?: AbortSignal;
};

let lastProvider = "";
const llmDispatcher = config.llmProxy ? new ProxyAgent(config.llmProxy) : undefined;

export function hasLlm() {
  return Boolean(config.aiKey && config.aiModel && config.aiBaseUrl);
}

export function getLastLlmProvider() {
  return lastProvider;
}

function llmAttempts(modelOverride = "", profile: "default" | "chat" = "default") {
  if (profile === "chat") {
    return config.chatAiKey && config.chatAiModel && config.chatAiBaseUrl
      ? [{ provider: config.chatAiProvider, baseUrl: config.chatAiBaseUrl, key: config.chatAiKey, model: modelOverride || config.chatAiModel }]
      : [];
  }
  const attempts = [
    {
      provider: config.aiProvider || "primary",
      baseUrl: config.aiBaseUrl,
      key: config.aiKey,
      model: modelOverride || config.aiModel
    }
  ];

  if (config.aiBackupKey && config.aiBackupKey !== config.aiKey) {
    attempts.push({
      provider: `${config.aiProvider || "primary"}-backup`,
      baseUrl: config.aiBaseUrl,
      key: config.aiBackupKey,
      model: modelOverride || config.aiModel
    });
  }

  if (config.aiProvider !== "openai" && process.env.OPENAI_API_KEY) {
    attempts.push({
      provider: "openai",
      baseUrl: process.env.OPENAI_BASE_URL ?? config.aiBaseUrl,
      key: process.env.OPENAI_API_KEY,
      model: modelOverride || process.env.OPENAI_MODEL || "gpt-5.3"
    });
  }

  return attempts.filter((attempt) => attempt.key && attempt.model && attempt.baseUrl);
}

export function extractJson(text: string) {
  const clean = text.trim();
  if (clean.startsWith("{") && clean.endsWith("}")) return clean;
  const match = clean.match(/\{[\s\S]*\}/);
  return match?.[0] ?? clean;
}

function isAbortLikeError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || /aborted|abort/i.test(error.message);
}

async function postChatCompletion(params: {
  baseUrl: string;
  key: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  const request = undiciFetch(`${params.baseUrl}/chat/completions`, {
      method: "POST",
      dispatcher: llmDispatcher,
      signal: params.signal,
      headers: {
        Authorization: `Bearer ${params.key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params.body)
    });
  return withRequestTimeout(request, params.timeoutMs);
}

async function postResponses(params: {
  baseUrl: string;
  key: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}) {
  const request = undiciFetch(`${params.baseUrl}/responses`, {
      method: "POST",
      dispatcher: llmDispatcher,
      signal: params.signal,
      headers: {
        Authorization: `Bearer ${params.key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(params.body)
    });
  return withRequestTimeout(request, params.timeoutMs);
}

async function withRequestTimeout(request: Promise<Response>, timeoutMs?: number) {
  if (!timeoutMs) return request;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`request timed out after ${timeoutMs}ms`);
      error.name = "AbortError";
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    void request.then((response) => response.arrayBuffer()).catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildResponsesBody(messages: LlmMessage[], model: string, options: LlmCallOptions) {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const input = messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
  const body: Record<string, unknown> = {
    model,
    instructions: instructions || "Return a helpful answer.",
    input,
    temperature: options.temperature ?? 0.35
  };

  if (options.responseFormat === "json_object") {
    body.text = { format: { type: "json_object" } };
  }

  if (options.reasoningEffort) {
    body.reasoning = { effort: options.reasoningEffort };
  }

  return body;
}

function extractResponsesText(data: ResponsesApiResponse) {
  if (data.output_text?.trim()) return data.output_text.trim();
  for (const output of data.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.text?.trim()) return content.text.trim();
    }
  }
  return "";
}

export async function callLlmText(
  messages: LlmMessage[],
  label: string,
  options: LlmCallOptions = {}
): Promise<string | undefined> {
  const attempts = llmAttempts(options.model, options.profile);
  if (attempts.length === 0) return undefined;

  for (const attempt of attempts) {
    if (options.signal?.aborted) return undefined;
    const baseUrl = attempt.baseUrl.replace(/\/$/, "");
    const body: Record<string, unknown> = {
      model: attempt.model,
      messages,
      temperature: options.temperature ?? 0.35
    };

    if (options.responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }

    if (options.reasoningEffort) {
      body.reasoning_effort = options.reasoningEffort;
      body.reasoning = { effort: options.reasoningEffort };
    }

    let response: Response;
    try {
      response = await postChatCompletion({
        baseUrl,
        key: attempt.key,
        body,
        timeoutMs: options.timeoutMs,
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) return undefined;
      if (!isAbortLikeError(error)) {
        console.warn(`${label} ${attempt.provider} LLM request failed: ${error instanceof Error ? error.message : error}`);
        continue;
      }

      const retryBody = { ...body };
      delete retryBody.reasoning;
      delete retryBody.reasoning_effort;

      try {
        console.warn(`${label} ${attempt.provider} LLM request aborted; retrying once without reasoning payload`);
        response = await postChatCompletion({
          baseUrl,
          key: attempt.key,
          body: retryBody,
          timeoutMs: options.timeoutMs ? Math.round(options.timeoutMs * 1.5) : undefined,
          signal: options.signal
        });
      } catch (retryError) {
        console.warn(
          `${label} ${attempt.provider} LLM retry failed: ${
            retryError instanceof Error ? retryError.message : retryError
          }`
        );
        continue;
      }
    }

    if (!response.ok) {
      const details = await response.text();
      if (/instructions are required/i.test(details)) {
        const responsesBody = buildResponsesBody(messages, attempt.model, options);
        const retryResponse = await postResponses({
          baseUrl,
          key: attempt.key,
          body: responsesBody,
          timeoutMs: options.timeoutMs ? Math.round(options.timeoutMs * 1.5) : undefined,
          signal: options.signal
        });
        if (retryResponse.ok) {
          const retryData = (await retryResponse.json()) as ResponsesApiResponse;
          const retryText = extractResponsesText(retryData);
          if (retryText) {
            lastProvider = attempt.provider;
            return retryText;
          }
        } else {
          const retryDetails = await retryResponse.text();
          console.warn(
            `${label} ${attempt.provider} Responses retry failed: ${retryResponse.status} ${retryDetails.slice(0, 500)}`
          );
        }
      }
      if (options.reasoningEffort && /reasoning|reasoning_effort/i.test(details)) {
        const retryBody = { ...body };
        delete retryBody.reasoning;
        delete retryBody.reasoning_effort;
        const retryResponse = await postChatCompletion({
          baseUrl,
          key: attempt.key,
          body: retryBody,
          timeoutMs: options.timeoutMs,
          signal: options.signal
        });
        if (retryResponse.ok) {
          const retryData = (await retryResponse.json()) as ChatCompletionResponse;
          const retryText = retryData.choices?.[0]?.message?.content?.trim();
          if (retryText) {
            lastProvider = attempt.provider;
            return retryText;
          }
        }
      }
      console.warn(
        `${label} ${attempt.provider} LLM request failed: ${response.status} ${details.slice(0, 500)}`
      );
      continue;
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) continue;

    lastProvider = attempt.provider;
    return text;
  }

  return undefined;
}

export async function callLlmJson<T>(payload: unknown, label: string): Promise<T | undefined> {
  const text = await callLlmText(
    [
      {
        role: "user",
        content: JSON.stringify(payload)
      }
    ],
    label,
    { responseFormat: "json_object", temperature: 0.35 }
  );

  if (!text) return undefined;

  try {
    return JSON.parse(extractJson(text)) as T;
  } catch (error) {
    console.warn(`${label} LLM JSON parse failed: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}
