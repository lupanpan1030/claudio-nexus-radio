// Browser suite entry. Imports the real @claudio/playback-core (through the
// runtime) and the real browser driver, injecting fixture ports only. The
// Node runner drives it through `window.e2e` and real page clicks; nothing
// here touches media elements or gains directly, except the explicitly named
// `other*` hooks, which act as another agent / the platform would (native
// pause()/play() on an element, AudioContext suspend/resume). A context
// suspend is not a physical OS audio interruption.
import { asId, type CueAsset, type ErrorInfo, type PlaybackCommand, type ResolvedMedia, type StreamHandle } from "@claudio/contracts";
import type { CoreConfig } from "@claudio/playback-core";
import {
  PortError,
  createBrowserDriver,
  createPlaybackHost,
  createPlaybackRuntime,
  createStorageQueueStore,
  type BrowserDriver,
  type HostView,
  type LogEntry,
  type MediaTimeouts,
  type PlaybackHost,
  type PlaybackRuntime,
  type RuntimePorts
} from "@claudio/playback-web";

interface Behavior {
  readonly delayMs?: number;
  /** Keep the call pending until `e2e.release(key)`. */
  readonly hold?: boolean;
  readonly fail?: ErrorInfo;
}

interface CatalogEntry {
  readonly file?: string;
  readonly controlled?: string;
  readonly missing?: boolean;
  readonly durationMs: number | null;
  readonly lyrics?: string;
}

interface BootOptions {
  readonly catalog: Record<string, CatalogEntry>;
  readonly coreConfig?: Partial<CoreConfig>;
  readonly djEnabled?: boolean;
  readonly prepare?: Record<string, Behavior>;
  readonly cue?: Behavior & { readonly voiceDurationMs?: number | null; readonly text?: string };
  readonly receipts?: { readonly failFirst?: number };
  readonly timeouts?: Partial<MediaTimeouts>;
  readonly timeFactIntervalMs?: number;
  /** Use the Web Locks host (two-tab scenarios); otherwise a plain runtime. */
  readonly coordinated?: { readonly lockName: string; readonly storageKey: string };
  readonly label?: string;
}

interface EventRecord {
  readonly t: number;
  readonly ctx: number | null;
  readonly kind: string;
  readonly data: unknown;
}

const events: EventRecord[] = [];
const held = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
const counters = { prepare: 0, cue: 0, lyrics: 0, receipts: 0, driversCreated: 0, runtimesCreated: 0 };
const receipts: unknown[] = [];
let options: BootOptions | null = null;
let host: PlaybackHost | null = null;
let driver: BrowserDriver | null = null;
const retiredDrivers: BrowserDriver[] = [];
let context: AudioContext | null = null;
let meter: AudioWorkletNode | null = null;
let armed: PlaybackCommand[] = [];
/** Every element the driver created, newest last (for the `other*` hooks only). */
const elements: HTMLAudioElement[] = [];
const captures = new Map<string, { resolve: (value: unknown) => void; chunks: Float32Array[]; gaps: { expected: number; actual: number }[]; expected: number | null; startFrame: number | null }>();

function record(kind: string, data: unknown): void {
  events.push({ t: performance.now(), ctx: context && context.state !== "closed" ? context.currentTime : null, kind, data: structuredCloneSafe(data) });
}

function structuredCloneSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function behave(kind: string, key: string, behavior: Behavior | undefined, signal: AbortSignal): Promise<void> {
  const abortable = (promise: Promise<void>) =>
    new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        record("port.aborted", { kind, key, reason: String((signal.reason as Error | undefined)?.name ?? "abort") });
        reject(signal.reason);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  if (behavior?.delayMs) await abortable(sleep(behavior.delayMs));
  if (behavior?.hold) {
    // Deliberately not abortable: models a port that ignores AbortSignal. The runtime must still settle.
    await new Promise<void>((resolve, reject) => held.set(`${kind}:${key}`, { resolve, reject }));
    record("port.released", { kind, key, aborted: signal.aborted });
  }
  if (behavior?.fail) throw new PortError(behavior.fail);
}

function fixturePorts(boot: BootOptions): RuntimePorts {
  return {
    prepare: {
      async resolve(request, signal) {
        counters.prepare++;
        const mediaId = request.track.mediaId;
        record("port.prepare", { mediaId, opId: request.opId, purpose: request.purpose });
        await behave("prepare", mediaId, boot.prepare?.[mediaId], signal);
        const entry = boot.catalog[mediaId];
        if (!entry) throw new PortError({ class: "unavailable", code: "not_in_fixture_catalog" });
        const media: ResolvedMedia = {
          track: request.track,
          recording: { recordingId: asId(`rec-${mediaId}`), confidence: "content-hash" },
          sourceRevision: asId(`rev-${mediaId}-1`),
          stream: { handle: asId<StreamHandle>(`media:${mediaId}`), expiresAt: null },
          duration: entry.durationMs === null ? { kind: "unknown" } : { kind: "known", ms: entry.durationMs, source: "provider-metadata" },
          capabilities: { seekable: true, rangeRequests: true }
        };
        return media;
      }
    },
    cue: {
      async request(request, signal) {
        counters.cue++;
        record("port.cue", { cueId: request.binding.cueId, transitionId: request.binding.transitionId });
        await behave("cue", "cue", boot.cue, signal);
        const text = boot.cue?.text ?? "Next up.";
        const voiceDurationMs = boot.cue?.voiceDurationMs === undefined ? null : boot.cue.voiceDurationMs;
        const asset: CueAsset = {
          script: { assetId: asId(`script-${request.binding.cueId}`), version: 1, text, subtitle: { timing: "plain-text", segments: [{ text }] } },
          voice: {
            assetId: asId(`voice-${request.binding.cueId}`),
            scriptAssetId: asId(`script-${request.binding.cueId}`),
            stream: { handle: asId<StreamHandle>("voice:voice"), expiresAt: null },
            // Unknown unless the scenario states the fixture's measured length.
            duration: voiceDurationMs === null ? { kind: "unknown" } : { kind: "known", ms: voiceDurationMs, source: "container-metadata" },
            playbackRate: 1
          }
        };
        return asset;
      }
    },
    lyrics: {
      async lookup(request) {
        counters.lyrics++;
        const text = boot.catalog[request.track.mediaId]?.lyrics;
        if (!text) return { status: "missing", reason: "not-found" };
        return {
          status: "available",
          asset: {
            assetId: asId(`lyrics-${request.track.mediaId}`),
            recordingId: request.recordingId,
            sourceRevision: request.sourceRevision,
            timing: "plain-text",
            offsetMs: 0,
            lines: [{ text }]
          }
        };
      }
    },
    receipts: {
      async report(receipt) {
        counters.receipts++;
        receipts.push(structuredCloneSafe(receipt));
        record("port.receipt", { key: receipt.idempotencyKey, attempt: counters.receipts });
        if (counters.receipts <= (boot.receipts?.failFirst ?? 0)) throw new PortError({ class: "retryable", code: "fixture_receipt_503" });
        return "recorded";
      }
    }
  };
}

function urlFor(handle: string): { url: string; crossOrigin: null } {
  const [kind, name] = handle.split(":") as [string, string];
  if (kind === "voice") return { url: "/media/voice.wav", crossOrigin: null };
  const entry = options?.catalog[name];
  if (!entry || entry.missing) return { url: `/missing/${encodeURIComponent(name)}.wav`, crossOrigin: null };
  if (entry.controlled) return { url: `/controlled/${entry.controlled}.wav`, crossOrigin: null };
  return { url: `/media/${entry.file}`, crossOrigin: null };
}

async function createRuntime(boot: BootOptions, instanceId: string): Promise<PlaybackRuntime> {
  const log = (entry: LogEntry) => {
    if (entry.event === "fact" && (entry.data as { event?: { kind?: string } }).event?.kind === "time") return record("fact.time", entry.data);
    record(entry.event, entry.data);
  };
  counters.driversCreated++;
  const created = await createBrowserDriver({
    urls: { music: (handle) => urlFor(handle), voice: (handle) => urlFor(handle) },
    timeouts: boot.timeouts,
    timeFactIntervalMs: boot.timeFactIntervalMs ?? 250,
    log,
    createElement: () => {
      const element = new Audio();
      elements.push(element);
      return element;
    },
    outputTap: async (ac) => {
      // Test seam: a pass-through PCM meter after master. The driver still owns the graph.
      await ac.audioWorklet.addModule("/meter.js");
      context = ac;
      meter = new AudioWorkletNode(ac, "pcm-meter");
      meter.port.onmessage = ({ data }) => onMeter(data);
      return meter;
    }
  });
  if (driver) retiredDrivers.push(driver);
  driver = created;
  counters.runtimesCreated++;
  return createPlaybackRuntime({
    driver: created,
    ports: fixturePorts(boot),
    instanceId,
    log,
    coreConfig: boot.coreConfig,
    initialSettings: { djEnabled: boot.djEnabled ?? true },
    queueStore: boot.coordinated ? createStorageQueueStore(window.localStorage, boot.coordinated.storageKey) : undefined,
    receiptPolicy: { backoffMs: [300, 600], maxAttempts: 4 }
  });
}

function onMeter(data: { kind: string; id: string; startFrame?: number; frames?: number; mono?: Float32Array; reason?: string; sampleRate?: number }): void {
  const capture = captures.get(data.id);
  if (!capture) return;
  if (data.kind === "capture-chunk" && data.mono) {
    capture.startFrame ??= data.startFrame ?? 0;
    if (capture.expected !== null && data.startFrame !== capture.expected) capture.gaps.push({ expected: capture.expected, actual: data.startFrame ?? -1 });
    capture.expected = (data.startFrame ?? 0) + (data.frames ?? 0);
    capture.chunks.push(data.mono);
  } else if (data.kind === "capture-end") {
    captures.delete(data.id);
    const total = capture.chunks.reduce((n, c) => n + c.length, 0);
    const mono = new Float32Array(total);
    let offset = 0;
    for (const chunk of capture.chunks) {
      mono.set(chunk, offset);
      offset += chunk.length;
    }
    const sampleRate = data.sampleRate ?? context?.sampleRate ?? 0;
    capture.resolve({
      id: data.id,
      reason: data.reason,
      sampleRate,
      startFrame: capture.startFrame,
      startContextTime: capture.startFrame === null ? null : capture.startFrame / sampleRate,
      frames: total,
      continuityGaps: capture.gaps,
      channels: [toBase64(mono)]
    });
  }
}

function toBase64(data: Float32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Facade so plain-runtime scenarios and Web Locks scenarios share one surface. */
function runtimeHost(runtime: PlaybackRuntime): PlaybackHost {
  return {
    getView: () => ({ role: "executor", executorInstanceId: runtime.instanceId, snapshot: runtime.getSnapshot(), canControl: true, exclusive: false }) satisfies HostView,
    subscribe: (listener) => runtime.subscribe(listener),
    dispatch: (command) => runtime.dispatch(command),
    clock: runtime.clock,
    spectrum: runtime.spectrum,
    unlockAudio: () => runtime.unlockAudio(),
    dispose: () => runtime.dispose()
  };
}

let unsubscribeView: (() => void) | null = null;
let instanceCounter = 0;

async function boot(next: BootOptions): Promise<HostView> {
  options = next;
  const label = next.label ?? "page";
  if (next.coordinated) {
    host = createPlaybackHost({
      name: next.coordinated.lockName,
      createRuntime: () => createRuntime(next, `${label}-${++instanceCounter}`),
      log: (entry) => record(entry.event, entry.data)
    });
  } else {
    host = runtimeHost(await createRuntime(next, `${label}-${++instanceCounter}`));
  }
  unsubscribeView = host.subscribe(render);
  render();
  return host.getView();
}

async function disposeHost(): Promise<unknown> {
  unsubscribeView?.();
  unsubscribeView = null;
  const current = host;
  host = null;
  await current?.dispose();
  render();
  return diagnostics();
}

function diagnostics() {
  return {
    driver: driver?.diagnostics() ?? null,
    retiredDrivers: retiredDrivers.map((d) => d.diagnostics()),
    counters: { ...counters },
    visibility: document.visibilityState,
    view: host ? structuredCloneSafe(host.getView()) : null,
    clock: host ? structuredCloneSafe(host.clock.read()) : null,
    contextTime: context && context.state !== "closed" ? context.currentTime : null,
    heldKeys: [...held.keys()]
  };
}

document.querySelector<HTMLButtonElement>("#go")!.addEventListener("click", () => {
  // A real user gesture: unlock output, then dispatch the armed intents in the same task.
  const commands = armed;
  armed = [];
  record("gesture", { commands });
  host?.unlockAudio();
  for (const command of commands) host?.dispatch(command);
});

const statusEl = document.querySelector<HTMLDivElement>("#status")!;
function render(): void {
  const view = host?.getView() ?? null;
  const snapshot = view?.snapshot ?? null;
  const clock = host?.clock.read() ?? null;
  const display = snapshot?.display;
  const displayText =
    display?.kind === "voice"
      ? `DJ: ${display.text ?? ""}`
      : display?.kind === "music"
        ? display.lyrics.status === "available"
          ? `♪ ${display.lyrics.asset.lines.map((l) => l.text).join(" / ")}`
          : `♪ (${display.lyrics.status})`
        : "—";
  const deckRow = (id: "A" | "B") => {
    const d = snapshot?.decks[id];
    const c = clock?.decks[id];
    return `<tr><td>${id}</td><td>${d?.role ?? ""}</td><td>${d?.status ?? ""}</td><td>${d?.itemId ?? ""}</td><td>${c ? (c.positionMs / 1000).toFixed(2) + "s ×" + c.rate : ""}</td><td>${d?.gain ?? ""}</td></tr>`;
  };
  statusEl.innerHTML = `
    <div class="role">role: ${view?.role ?? "none"} · instance: ${view?.executorInstanceId ?? "—"} · control: ${view?.canControl ?? false} · visibility: ${document.visibilityState}</div>
    <div>transport: <b>${snapshot?.transport ?? "—"}</b> · program: ${snapshot?.program?.item.display?.title ?? "—"} · transition: ${snapshot?.transition ? `${snapshot.transition.mode}/${snapshot.transition.phase}` : "—"}</div>
    <div class="display">${displayText}</div>
    <table><tr><th>deck</th><th>role</th><th>status</th><th>item</th><th>clock (media element)</th><th>gain target</th></tr>${deckRow("A")}${deckRow("B")}
    <tr><td>voice</td><td colspan="3">${snapshot?.voice ? `${snapshot.voice.status} ${snapshot.voice.cueId}` : "—"}</td><td>${clock?.voice ? (clock.voice.positionMs / 1000).toFixed(2) + "s ×" + clock.voice.rate : ""}</td><td></td></tr></table>
    <div>queue: ${(snapshot?.queue ?? []).map((e) => e.item.display?.title ?? e.item.itemId).join(", ") || "—"} · receipts: ${(snapshot?.receipts ?? []).map((r) => r.status).join(", ") || "—"}</div>`;
}
setInterval(render, 250);

const e2e = {
  boot,
  armGesture(commands: PlaybackCommand[]) {
    armed = commands;
  },
  dispatch(command: PlaybackCommand) {
    record("e2e.dispatch", command);
    return host?.dispatch(command) ?? { accepted: false, reason: "disposed" };
  },
  view: () => structuredCloneSafe(host?.getView() ?? null) as HostView | null,
  clock: () => structuredCloneSafe(host?.clock.read() ?? null),
  diagnostics,
  events: () => events,
  eventsSince: (index: number) => events.slice(index),
  eventCount: () => events.length,
  receipts: () => receipts,
  release(key: string, fail?: ErrorInfo) {
    const entry = held.get(key);
    if (!entry) return false;
    held.delete(key);
    if (fail) entry.reject(new PortError(fail));
    else entry.resolve();
    return true;
  },
  record(id: string, seconds: number) {
    if (!meter) throw new Error("no meter: driver not created on this page");
    if (captures.has(id)) throw new Error(`duplicate capture ${id}`);
    return new Promise((resolve) => {
      // A suspended/closed context renders no frames: bound the wait instead of hanging the runner.
      const deadline = setTimeout(() => {
        if (!captures.has(id)) return;
        captures.delete(id);
        meter?.port.postMessage({ type: "cancel" });
        resolve({ id, reason: "timeout", contextState: context?.state ?? null, sampleRate: context?.sampleRate ?? 0, startFrame: null, startContextTime: null, frames: 0, continuityGaps: [], channels: [] });
      }, seconds * 1000 + 3000);
      captures.set(id, {
        resolve: (value) => {
          clearTimeout(deadline);
          resolve(value);
        },
        chunks: [],
        gaps: [],
        expected: null,
        startFrame: null
      });
      meter!.port.postMessage({ type: "capture", id, seconds });
    });
  },
  dispose: disposeHost,
  /** Unmount + immediate remount with the same options (React StrictMode pattern). */
  async remount() {
    const previous = options!;
    const disposing = disposeHost();
    const view = await boot(previous);
    await disposing;
    return view;
  },
  /** Copy-out spectrum through the public read-only interface. */
  spectrum() {
    if (!host) return null;
    const music = new Uint8Array(128);
    const voice = new Uint8Array(128);
    const musicBins = host.spectrum.readMusic(music);
    const voiceBins = host.spectrum.readVoice(voice);
    return { musicBins, voiceBins, musicSum: music.reduce((a, b) => a + b, 0), voiceSum: voice.reduce((a, b) => a + b, 0), voiceLevel: host.spectrum.voiceLevel() };
  },
  /** Another agent pauses the live element playing `file` (native pause(); its `pause` event is queued). */
  otherPause(file: string, then?: PlaybackCommand) {
    const element = liveElement(file);
    element.pause();
    record("other.pause", { file, paused: element.paused, positionMs: element.currentTime * 1000 });
    // Same task: the listener's command reaches the executor before the queued `pause` is dispatched.
    if (then) e2e.dispatch(then);
  },
  /** At the element's natural end (inside its end timeupdate, paused/ended already set) dispatch `command`. */
  atEnd(file: string, command: PlaybackCommand) {
    const element = liveElement(file);
    const onTime = () => {
      if (!element.ended || !element.paused) return;
      element.removeEventListener("timeupdate", onTime);
      record("other.at-end", { file, paused: element.paused, ended: element.ended, positionMs: element.currentTime * 1000 });
      e2e.dispatch(command);
      record("other.at-end.after", { paused: element.paused, ended: element.ended, seeking: element.seeking, positionMs: element.currentTime * 1000 });
    };
    element.addEventListener("timeupdate", onTime);
  },
  /** The platform stops/starts rendering the shared output (AudioContext suspend/resume). */
  async otherOutput(running: boolean) {
    if (!context) throw new Error("no context");
    await (running ? context.resume() : context.suspend());
    record("other.output", { running, state: context.state });
    return context.state;
  },
  /** Seconds of the shared AudioContext for aligning events with captures. */
  contextTime: () => (context && context.state !== "closed" ? context.currentTime : null)
};

function liveElement(file: string): HTMLAudioElement {
  const element = [...elements].reverse().find((el) => el.src.endsWith(`/media/${file}`) || el.src.endsWith(`/${file}`));
  if (!element) throw new Error(`no element for ${file}`);
  return element;
}

declare global {
  interface Window {
    e2e: typeof e2e;
  }
}
window.e2e = e2e;
record("page.ready", { href: location.href });

// `#autostart=<json>` boots and dispatches without any user gesture (used to
// observe the autoplay-policy path before the runner touches the page).
const autostart = /^#autostart=(.*)$/.exec(location.hash);
if (autostart) {
  const { boot: bootOptions, commands } = JSON.parse(decodeURIComponent(autostart[1]!)) as { boot: BootOptions; commands: PlaybackCommand[] };
  void boot(bootOptions).then(() => {
    for (const command of commands) e2e.dispatch(command);
  });
}
