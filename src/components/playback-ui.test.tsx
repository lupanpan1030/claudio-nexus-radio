// The real playback components rendered on the server renderer (no DOM in
// node): PlaylistQueue rows are clicked through their own onClick props on a
// real runtime, and Player/LiveCaption/LyricsPanel markup is read for the
// states the listener sees. CSS imports are stubbed; nothing else is faked.
import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, test } from "node:test";
import type { CueAsset, LyricsAvailability, PlaybackCommand, PlaybackSnapshot, QueueItemId, SubtitleTrack } from "@claudio/contracts";
import { createSequentialIds, estimateSubtitleTiming, withReservations } from "@claudio/playback-core";
import { createPlaybackRuntime, type ClockReader, type HostView, type PlaybackRuntime, type SpectrumReader } from "@claudio/playback-web";
import { FakeDriver } from "@claudio/playback-web/testing";
import type { ReactElement, ReactNode } from "react";
import { PlaybackController, type OwnerServices } from "../playback/controller";
import { HttpPreparePort, PreparationClient } from "../playback/preparation";
import { RadioRefill, type RefillStatus } from "../playback/radio-refill";
import { voiceControls } from "../playback/voice-model";
import { FakePlaybackServer, ManualTimers, TEST_PATHS, flush, ref } from "../playback/test-support";

register("data:text/javascript,export async function load(url, context, next) { if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }; return next(url, context); }");
const React = await import("react");
const { createElement } = React;
// The test runner works from a throwaway cwd, so tsx compiles JSX with the classic factory (React.createElement).
(globalThis as { React?: unknown }).React = React;
const { renderToStaticMarkup } = await import("react-dom/server");
const { PlaylistQueue } = await import("./PlaylistQueue");
const { Player } = await import("./Player");
const { LiveCaption } = await import("./LiveCaption");
const { LyricsPanel } = await import("../stage/LyricsPanel");
const { playbackNotice } = await import("../playback/notice");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Owner page wiring: real core + runtime + HTTP ports over the fake v1 server, fake media driver. */
function ownerRig(options: { autoReady?: boolean } = {}) {
  const server = new FakePlaybackServer();
  server.autoReady = options.autoReady ?? true;
  const client = new PreparationClient(server.fetch, TEST_PATHS, { waitMs: 50, requestTimeoutMs: 2000, resolveTimeoutMs: 2000, cancelTimeoutMs: 200 });
  const prepare = new HttpPreparePort(client);
  const driver = new FakeDriver(() => 1000);
  const ids = withReservations(createSequentialIds("exec-ui"));
  const runtime: PlaybackRuntime = createPlaybackRuntime({
    driver,
    instanceId: "exec-ui",
    ids,
    clock: () => 1000,
    ports: {
      prepare,
      cue: { request: () => new Promise<CueAsset>(() => {}) },
      lyrics: { lookup: async (): Promise<LyricsAvailability> => ({ status: "missing", reason: "not-found" }) },
      receipts: { report: async () => "recorded" as const }
    }
  });
  const dispatched: PlaybackCommand[] = [];
  let owner: OwnerServices | null = null;
  const view = (): HostView => ({ role: "executor", executorInstanceId: runtime.instanceId, snapshot: runtime.getSnapshot(), canControl: true, exclusive: true });
  const host = {
    getView: view,
    dispatch: (command: PlaybackCommand) => {
      dispatched.push(command);
      return runtime.dispatch(command);
    },
    unlockAudio: () => runtime.unlockAudio()
  };
  const controller = new PlaybackController(host, () => owner);
  const refill = new RadioRefill({ target: runtime, client, port: prepare, ids, userActionSeq: controller.getUserActionSeq, timers: new ManualTimers() });
  owner = { refill, ids };
  cleanups.push(async () => {
    refill.dispose();
    await runtime.dispose();
  });
  return { server, runtime, driver, controller, refill, dispatched, view, snapshot: (): PlaybackSnapshot => runtime.getSnapshot() };
}

type Rig = ReturnType<typeof ownerRig>;

const loads = (rig: Rig) => rig.driver.executed.filter((effect) => effect.type === "deck.load");

async function startLatestLoad(rig: Rig) {
  await flush();
  const load = loads(rig).at(-1);
  assert.ok(load && load.type === "deck.load");
  rig.driver.deckEvent(load.deck, { kind: "can-play", through: true }, load.loadId);
  rig.driver.deckEvent(load.deck, { kind: "playing", positionMs: 0 }, load.loadId);
  await flush();
}

/** Every <button> element of a rendered tree (host elements only; PlaylistQueue has no hooks or child components). */
function buttons(node: ReactNode): ReactElement<{ onClick?: () => void; title?: string; disabled?: boolean; "aria-current"?: string }>[] {
  const found: ReactElement<{ onClick?: () => void; title?: string; disabled?: boolean }>[] = [];
  const walk = (value: ReactNode) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object" || !("props" in value)) return;
    const element = value as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
    if (element.type === "button") found.push(element);
    walk(element.props.children);
  };
  walk(node);
  return found;
}

function queueRows(rig: Rig) {
  return buttons(PlaylistQueue({ snapshot: rig.snapshot(), controller: rig.controller, canControl: true, playlist: null }));
}

function rowFor(rig: Rig, title: string) {
  const row = queueRows(rig).find((button) => button.props.title?.endsWith(` - ${title}`));
  assert.ok(row, `row ${title}`);
  return row;
}

const prepareFor = (rig: Rig, itemId: QueueItemId) => rig.server.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/playback/prepare" && (request.body as { itemId: string }).itemId === itemId).length;

test("queue row click selects that occurrence: same itemId/origin, preheated B promoted without a new prepare or load, other rows kept", async () => {
  const rig = ownerRig();
  rig.controller.apply(
    [{ type: "replace-queue", autoplay: true, entries: ["A", "B", "C"].map((name) => ({ track: ref(name), display: { title: name, artist: "Fixture" }, origin: name === "B" ? ("radio" as const) : ("chat" as const) })) }],
    { gesture: true }
  );
  await startLatestLoad(rig);
  await flush();
  const before = rig.snapshot();
  assert.equal(before.program?.item.track.mediaId, "A");
  const b = before.queue.find((entry) => entry.item.track.mediaId === "B")!.item;
  const c = before.queue.find((entry) => entry.item.track.mediaId === "C")!.item;
  const bLoad = loads(rig).find((load) => load.type === "deck.load" && load.itemId === b.itemId);
  assert.ok(bLoad, "B is preheated on the standby deck");
  assert.equal(prepareFor(rig, b.itemId), 1);
  const loadsBefore = loads(rig).length;
  const postsBefore = rig.server.count("POST", "/api/v1/playback/prepare");

  rig.dispatched.length = 0;
  rowFor(rig, "B").props.onClick?.();
  await flush();
  assert.deepEqual(rig.dispatched, [{ type: "select", target: { kind: "item", itemId: b.itemId } }], "the row dispatches select item, not replace-queue");
  const after = rig.snapshot();
  assert.equal(after.program?.item, b, "the very same queue item object");
  assert.equal(after.program?.item.origin, "radio");
  assert.equal(after.program?.deck, bLoad.deck, "promoted on the deck it was preheated on");
  assert.equal(loads(rig).length, loadsBefore, "no new load");
  assert.equal(rig.server.count("POST", "/api/v1/playback/prepare"), postsBefore, "no second prepare");
  assert.ok(after.queue.some((entry) => entry.item.itemId === c.itemId), "C is still queued");
  assert.deepEqual(after.history.map((entry) => [entry.item.track.mediaId, entry.outcome]), [["A", "skipped"]]);
});

test("restored head (idle) and a later row keep their items; a played row replays as a new occurrence", async () => {
  const rig = ownerRig();
  rig.controller.apply([{ type: "enqueue", position: "end", entries: ["A", "B", "C"].map((name) => ({ track: ref(name), display: { title: name, artist: "Fixture" }, origin: "restore" as const })) }], { gesture: false });
  await flush();
  assert.equal(rig.snapshot().transport, "idle");
  const [a, b, c] = rig.snapshot().queue.map((entry) => entry.item);
  const head = queueRows(rig)[0]!;
  assert.equal(head.props["aria-current"], "true", "the restored head shows as current");
  rig.dispatched.length = 0;
  head.props.onClick?.();
  assert.deepEqual(rig.dispatched, [{ type: "select", target: { kind: "item", itemId: a!.itemId } }]);
  await startLatestLoad(rig);
  assert.equal(rig.snapshot().program?.item, a);
  assert.equal(rig.snapshot().program?.item.origin, "restore");

  rig.dispatched.length = 0;
  rowFor(rig, "C").props.onClick?.();
  await startLatestLoad(rig);
  assert.equal(rig.snapshot().program?.item, c);
  assert.ok(rig.snapshot().queue.some((entry) => entry.item.itemId === b!.itemId), "B is not dropped by selecting C");

  rig.dispatched.length = 0;
  rowFor(rig, "A").props.onClick?.(); // the played row
  const command = rig.dispatched[0];
  assert.ok(command?.type === "select" && command.target.kind === "track", "history replays as a new occurrence");
  await startLatestLoad(rig);
  assert.notEqual(rig.snapshot().program?.item.itemId, a!.itemId);
  assert.equal(rig.snapshot().program?.item.track.mediaId, "A");
});

const noSpectrum: SpectrumReader = { readMusic: () => 0, readVoice: () => 0, voiceLevel: () => 0 };
const taste = { available: false, pending: false, liked: false, toggleLike: () => {} } as never;

function renderPlayer(rig: Rig, refill: RefillStatus) {
  const view = rig.view();
  return renderToStaticMarkup(
    createElement(Player, {
      view,
      live: null,
      spectrum: noSpectrum,
      controller: rig.controller,
      track: null,
      caption: () => null,
      voice: voiceControls(view.snapshot),
      taste,
      canPrevious: false,
      busy: false,
      starting: refill.autoplay,
      lyrics: () => null,
      onHostProfileOpen: () => {}
    })
  );
}

const mainButton = (html: string) => /<button class="icon-button primary"[^>]*>/.exec(html)?.[0] ?? "";

test("main button: a pending empty-queue start reads 取消开播 (not 暂停), cancelling it returns to 播放, and the notice says the same", async () => {
  const rig = ownerRig({ autoReady: false });
  const notice = () => playbackNotice({ protocol: { status: "ready", serverInstanceId: "s", paths: TEST_PATHS }, view: rig.view(), startup: { status: "none" }, refill: rig.refill.getStatus() });
  assert.match(mainButton(renderPlayer(rig, rig.refill.getStatus())), /aria-label="播放"/);
  rig.controller.togglePlay();
  await flush();
  assert.equal(rig.refill.getStatus().phase, "selecting");
  const pending = mainButton(renderPlayer(rig, rig.refill.getStatus()));
  assert.match(pending, /aria-label="取消开播"/);
  assert.match(pending, /data-intent="cancel-start"/);
  assert.match(pending, /title="正在挑选第一首歌，点击取消开播"/);
  assert.match(notice() ?? "", /取消开播/);

  rig.controller.togglePlay();
  assert.equal(rig.refill.getStatus().autoplay, false);
  assert.match(mainButton(renderPlayer(rig, rig.refill.getStatus())), /aria-label="播放"/);
  assert.match(notice() ?? "", /^已取消开播/);
  assert.equal(rig.controller.getUserActionSeq(), 1, "cancelling is a pause intent: the chat seq stays where the start put it");

  rig.controller.play(); // media-session play: starts again
  await flush();
  assert.match(mainButton(renderPlayer(rig, rig.refill.getStatus())), /aria-label="取消开播"/);
  rig.controller.play(); // repeated play: idempotent, still the same pending start
  await flush();
  assert.equal(rig.server.count("POST", "/api/v1/playback/prepare"), 2);
  rig.controller.pause();
  rig.controller.pause();
  assert.equal(rig.refill.getStatus().autoplay, false);
});

test("main button during a retry wait of a pending start is still 取消开播", async () => {
  const rig = ownerRig();
  rig.server.failNextPrepare = { status: 503, code: "upstream_busy", class: "retryable" };
  rig.controller.togglePlay();
  await flush();
  assert.equal(rig.refill.getStatus().phase, "retry-wait");
  assert.match(mainButton(renderPlayer(rig, rig.refill.getStatus())), /aria-label="取消开播"/);
  rig.controller.togglePlay();
  assert.equal(rig.refill.getStatus().phase, "idle");
  assert.match(mainButton(renderPlayer(rig, rig.refill.getStatus())), /aria-label="播放"/);
});

// ---- DJ subtitles: native / estimated / unknown duration, on the voice clock only ----

const SCRIPT = "下一首是 B。它会慢慢进来。先把音量留给它。";
const plainTrack: SubtitleTrack = { timing: "plain-text", segments: [{ text: SCRIPT }] };
const estimatedTrack = estimateSubtitleTiming(plainTrack, 9000);
const nativeTrack: SubtitleTrack = { timing: "native-line", segments: [{ startMs: 0, endMs: 2500, text: "下一首是 B。" }, { startMs: 2500, endMs: 6000, text: "它会慢慢进来。" }, { startMs: 6000, endMs: 9000, text: "先把音量留给它。" }] };

/** A snapshot whose display is the DJ voice, the voice clock at `voiceMs` and the music deck far away at `musicMs`. */
function voiceView(subtitle: SubtitleTrack, voiceMs: number, musicMs: number): { view: HostView; live: ClockReader } {
  const snapshot = {
    transport: "playing",
    program: { item: { itemId: "a" }, deck: "A", loadId: "l1", started: true },
    decks: { A: { loadId: "l1", duration: { kind: "known", ms: 200_000 } }, B: {} },
    display: { kind: "voice", cueId: "c1", transitionId: "t1", subtitle, text: SCRIPT },
    voice: { cueId: "c1", transitionId: "t1", origin: "transition", status: "speaking", pausedBy: null, voiceLoadId: "v1", clock: { positionMs: voiceMs, observedAt: 0, rate: 0 }, scriptText: SCRIPT, subtitle },
    narration: { retained: null, replay: null },
    queue: [],
    history: [],
    settings: { djEnabled: true, musicVolume: 0.5, voiceVolume: 1, muted: false }
  } as unknown as PlaybackSnapshot;
  const live: ClockReader = {
    read: () => ({
      at: 0,
      source: "media-element",
      decks: { A: { deck: "A", loadId: "l1", positionMs: musicMs, observedAt: 0, rate: 0 } as never, B: null },
      voice: { cueId: "c1", voiceLoadId: "v1", positionMs: voiceMs, observedAt: 0, rate: 0 } as never
    })
  };
  return { view: { role: "executor", executorInstanceId: "exec-ui", snapshot, canControl: true, exclusive: true }, live };
}

const caption = (subtitle: SubtitleTrack, voiceMs: number, musicMs = 120_000) => {
  const { view, live } = voiceView(subtitle, voiceMs, musicMs);
  return renderToStaticMarkup(createElement(LiveCaption, { view, live }));
};
const captionText = (html: string) => /<span class="caption-text">([^<]*)<\/span>/.exec(html)?.[1] ?? null;

test("estimated DJ sentences come from the core projection and are labelled 估算 in the caption", () => {
  assert.equal(estimatedTrack.timing, "estimated", "known duration + several sentences: the core projects estimated timing");
  assert.ok(estimatedTrack.segments.length === 3);
  const second = estimatedTrack.segments[1]!;
  const html = caption(estimatedTrack, (second.startMs! + second.endMs!) / 2);
  assert.equal(captionText(html), second.text, "the badge and the sentence are separate");
  assert.match(html, /data-timing="estimated"/);
  assert.match(html, /<span class="caption-badge"[^>]*aria-label="时间为估算"[^>]*>估算<\/span>/);
  assert.doesNotMatch(html, /karaoke-char/, "no per-character sweep");
});

test("only the voice clock moves the DJ sentence: a music seek changes nothing", () => {
  const first = estimatedTrack.segments[0]!;
  const third = estimatedTrack.segments[2]!;
  assert.equal(captionText(caption(estimatedTrack, first.startMs! + 10, 5_000)), first.text);
  assert.equal(captionText(caption(estimatedTrack, first.startMs! + 10, 180_000)), first.text, "music position far away: same sentence");
  assert.equal(captionText(caption(estimatedTrack, third.startMs! + 10, 5_000)), third.text, "voice position moved: next sentence");
  assert.equal(captionText(caption(nativeTrack, 3000, 0)), "它会慢慢进来。");
});

test("native timing has no estimate badge; unknown duration stays plain text shown whole (never its first sentence as current)", () => {
  const native = caption(nativeTrack, 1000);
  assert.match(native, /data-timing="native-line"/);
  assert.doesNotMatch(native, /caption-badge/);

  const unknown = estimateSubtitleTiming(plainTrack, null);
  assert.equal(unknown.timing, "plain-text", "unknown voice duration: the core leaves it plain");
  const plain = caption(unknown, 4000);
  assert.match(plain, /class="program-subtitle is-whole"/);
  assert.equal(captionText(plain), SCRIPT, "the whole script, truncated by CSS to one line");
  assert.match(plain, new RegExp(`title="${SCRIPT}"`), "full text available");
  assert.doesNotMatch(plain, /caption-badge/);
});

test("LyricsPanel voice branch names the timing: 时间为估算 / 逐行对时 / 全文", () => {
  const panel = (subtitle: SubtitleTrack, voiceMs: number) => {
    const { view, live } = voiceView(subtitle, voiceMs, 0);
    return renderToStaticMarkup(createElement(LyricsPanel, { view, live, visible: true, stageEnabled: false, onStageToggle: () => {} }));
  };
  const estimated = panel(estimatedTrack, estimatedTrack.segments[1]!.startMs! + 5);
  assert.match(estimated, /Claudio 正在串场 · 时间为估算/);
  assert.match(estimated, new RegExp(`<li class="active">${estimatedTrack.segments[1]!.text}</li>`));
  assert.match(panel(nativeTrack, 100), /Claudio 正在串场 · 逐行对时/);
  const plain = panel(plainTrack, 100);
  assert.match(plain, /Claudio 正在串场 · 全文/);
  assert.doesNotMatch(plain, /class="active"/, "plain text has no current line");
});
