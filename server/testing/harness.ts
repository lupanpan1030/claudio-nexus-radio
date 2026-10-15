import type { AddressInfo } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { asId, type MediaId, type ProviderId } from "@claudio/contracts";
import type { PlaybackPolicy } from "../application/policy.js";
import { createApp } from "../http/app.js";
import type { LegacyApi, LegacyV1Hooks } from "../http/legacy-routes.js";
import { assemblePlayback, type PlaybackAssembly } from "../playback-assembly.js";
import type { ScriptWriterPort, SpeechSynthesisPort } from "../ports/narration.js";
import type { ProviderModule } from "../ports/providers.js";
import type { RadioCandidatePort } from "../ports/radio.js";
import type { Clock } from "../ports/runtime.js";

export class ManualClock implements Clock {
  constructor(public current = Date.UTC(2026, 9, 16, 12, 0, 0)) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export interface HarnessOptions {
  readonly dir: string;
  readonly providers: readonly ProviderModule[];
  readonly writer: ScriptWriterPort;
  readonly tts: SpeechSynthesisPort;
  readonly radio: RadioCandidatePort;
  readonly db?: DatabaseSync;
  readonly clock?: Clock;
  readonly policy?: Partial<PlaybackPolicy>;
  readonly mode?: "v1" | "legacy";
  readonly legacy?: Partial<LegacyApi>;
}

export interface Harness {
  readonly baseUrl: string;
  readonly assembly: PlaybackAssembly;
  readonly db: DatabaseSync;
  readonly legacyCalls: string[];
  request(method: string, pathname: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any; headers: Headers }>;
  /** Closes app + HTTP server. Leaves the DB open unless `closeDb` is set. */
  close(options?: { closeDb?: boolean; interrupt?: boolean }): Promise<void>;
}

/**
 * Legacy functions are stubs that record calls; tests override what they use.
 * Unlisted legacy features answer 501 through a thrown error.
 */
function legacyStub(overrides: Partial<LegacyApi>, calls: string[]): LegacyApi {
  const base: Record<string, unknown> = {
    config: { libraryDir: "", aiProvider: "", aiModel: "", djAiModel: "", djAiTimeoutMs: 0, djAiReasoningEffort: "" },
    ...overrides
  };
  return new Proxy(base, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) {
        const value = target[key];
        return typeof value === "function"
          ? (...args: unknown[]) => {
              calls.push(key);
              return (value as (...inner: unknown[]) => unknown)(...args);
            }
          : value;
      }
      return () => {
        calls.push(key);
        throw new Error(`legacy ${key} not stubbed`);
      };
    }
  }) as unknown as LegacyApi;
}

export async function startHarness(options: HarnessOptions): Promise<Harness> {
  const db = options.db ?? new DatabaseSync(path.join(options.dir, "radio.sqlite"));
  const assembly = assemblePlayback({
    db,
    providers: options.providers,
    radio: options.radio,
    writer: options.writer,
    tts: options.tts,
    voiceDir: path.join(options.dir, "tts-v2"),
    legacyRef: (row) => ({ providerId: asId<ProviderId>("legacy"), mediaId: asId<MediaId>(row.id) }),
    clock: options.clock,
    policy: options.policy
  });
  const legacyCalls: string[] = [];
  const services = assembly.services;
  const hooks: LegacyV1Hooks = {
    chatDeps: {},
    recentTracks: () => [],
    verifyPlayable: async () => true,
    refForLegacyTrack: () => null,
    onKuGouAccountChanged: () => undefined,
    nowProjection: () => services.now.get(),
    subscribeNow: (listener) => services.now.subscribe(listener)
  };
  const { app, close } = createApp({
    playbackProtocol: options.mode ?? "v1",
    playback: services,
    legacy: legacyStub(options.legacy ?? {}, legacyCalls),
    legacyHooks: hooks
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    assembly,
    db,
    legacyCalls,
    async request(method, pathname, body, headers = {}) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: response.status, json, headers: response.headers };
    },
    async close(closeOptions = {}) {
      if (closeOptions.interrupt !== false) await close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (closeOptions.closeDb) db.close();
    }
  };
}
