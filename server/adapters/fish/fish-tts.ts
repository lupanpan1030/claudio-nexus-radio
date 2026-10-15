import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { appError, isAbort } from "../../application/errors.js";
import { abortableDelay } from "../../application/operations.js";
import type { SpeechFormat, SpeechSynthesisPort, SpeechVoiceDescriptor } from "../../ports/narration.js";

export interface FishTtsConfig {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly model: string;
  readonly voiceId: string;
  readonly format: string;
  readonly latency: string;
  readonly proxy: string;
  /** Pause before the single retry on 429/5xx. */
  readonly retryDelayMs?: number;
}

export function normalizeSpeechFormat(value: string): SpeechFormat {
  const format = value.toLowerCase();
  return format === "wav" || format === "ogg" ? format : "mp3";
}

/**
 * Fish Audio TTS with the request shape the existing integration used. The
 * caller's signal aborts the request and the body read; one retry on 429/5xx.
 */
export class FishSpeechSynthesis implements SpeechSynthesisPort {
  readonly descriptor: SpeechVoiceDescriptor;
  readonly configured: boolean;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(private readonly config: FishTtsConfig) {
    this.descriptor = {
      provider: "fish",
      model: config.model,
      voice: config.voiceId,
      format: normalizeSpeechFormat(config.format),
      options: JSON.stringify({ latency: config.latency })
    };
    this.configured = Boolean(config.apiKey && config.endpoint);
    this.dispatcher = config.proxy ? new ProxyAgent(config.proxy) : undefined;
  }

  async synthesize(text: string, options: { readonly signal: AbortSignal }): Promise<Uint8Array> {
    if (!this.configured) throw appError("unavailable", "tts_not_configured");
    let lastError: unknown = appError("retryable", "tts_failed");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await undiciFetch(this.config.endpoint, {
          method: "POST",
          dispatcher: this.dispatcher,
          signal: options.signal,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            model: this.config.model
          },
          body: JSON.stringify({
            text,
            format: this.descriptor.format,
            latency: this.config.latency,
            ...(this.config.voiceId ? { reference_id: this.config.voiceId } : {})
          })
        });
        if (response.ok) return new Uint8Array(await response.arrayBuffer());
        const detail = (await response.text().catch(() => "")).slice(0, 180);
        if (response.status === 401 || response.status === 403) {
          throw appError("auth-required", "tts_auth_failed", "speech provider rejected the API key");
        }
        lastError = appError(
          response.status === 429 || response.status >= 500 ? "retryable" : "unavailable",
          "tts_http_error",
          `speech provider returned ${response.status}${detail ? ` ${detail}` : ""}`
        );
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          await abortableDelay(this.config.retryDelayMs ?? 500, options.signal);
          continue;
        }
        throw lastError;
      } catch (error) {
        if (isAbort(error) || options.signal.aborted) throw error;
        if (error instanceof Error && error.name === "AppError") throw error;
        lastError = appError("retryable", "tts_unreachable", error instanceof Error ? error.message : undefined, error);
        if (attempt === 0) {
          await abortableDelay(this.config.retryDelayMs ?? 500, options.signal);
          continue;
        }
      }
    }
    throw lastError;
  }
}
