#!/usr/bin/env node
// Main-app browser acceptance: the real UI (Vite dev, workspace sources), the
// real browser driver/runtime/core, and the real v1 HTTP/application layer of
// fixture-server.mjs (synthetic provider, chooser, script writer and a TONE
// as "voice"). Every scenario gets its own fixture (temporary SQLite/cwd,
// random ports) and a fresh browser context; everything is closed at the end.
//
//   node scripts/app-e2e/run.mjs [--scenario a,b,...] [--out dir]
//
// Scenarios: program, ownership, controls, features, stage, rapid-next,
// source-failure, voice-failure, late-cue, new-source, queue-select,
// dj-plain, migration, refresh-during-talk (default: all).
// A check passes only on observed facts: snapshot identity from the dev-only
// read bridge, native media element state, analyser PCM windows, and the
// fixture server's request log / started store. Exit 1 when any check fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { startFixture } from "./fixture.mjs";
import { delay, launchBrowser, openPage, progressing, readObservation } from "./browser.mjs";

const ALL = ["program", "ownership", "controls", "features", "stage", "rapid-next", "source-failure", "voice-failure", "late-cue", "new-source", "queue-select", "dj-plain", "migration", "refresh-during-talk"];
const { values: args } = parseArgs({ options: { scenario: { type: "string" }, out: { type: "string" } } });
const selected = args.scenario ? args.scenario.split(",") : ALL;
for (const name of selected) if (!ALL.includes(name)) throw new Error(`unknown scenario ${name}`);
const outRoot = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "claudio-app-e2e-results-")));
fs.mkdirSync(outRoot, { recursive: true });

const PLAYBACK_EFFECT = (row) =>
  (row.method === "POST" && /^\/api\/v1\/playback\/(prepare|resolve|lyrics|narration|started)$/.test(row.path)) ||
  (row.method === "PUT" && row.path === "/api/v1/now") ||
  (row.method === "DELETE" && /^\/api\/v1\/playback\//.test(row.path));
const STREAM = "/api/v1/playback/streams/";

/** Compact, comparable view of the page's playback state (read-only dev bridge). */
async function view(tab) {
  return tab.page.evaluate(() => {
    const bridge = window.__claudioPlayback;
    if (!bridge) return null;
    const v = bridge.view();
    const s = v.snapshot;
    const program = s?.program ?? null;
    const deck = program?.deck ? s.decks[program.deck] : null;
    return {
      role: v.role,
      canControl: v.canControl,
      executor: v.executorInstanceId,
      version: s?.version ?? null,
      transport: s?.transport ?? null,
      program: program ? { itemId: program.item.itemId, mediaId: program.item.track.mediaId, started: program.started, loadId: program.loadId, revision: program.sourceRevision, deck: program.deck } : null,
      deck: deck ? { loadId: deck.loadId, position: deck.clock?.positionMs ?? null, seekEpoch: deck.seekEpoch, duration: deck.duration } : null,
      display: s?.display ? { kind: s.display.kind, cueId: s.display.cueId ?? null, lyrics: s.display.lyrics?.status ?? null, lyricsRevision: s.display.lyrics?.asset?.sourceRevision ?? null, text: s.display.text ?? null } : null,
      voice: s?.voice ? { cueId: s.voice.cueId, status: s.voice.status, origin: s.voice.origin, pausedBy: s.voice.pausedBy, voiceLoadId: s.voice.voiceLoadId, script: s.voice.scriptText } : null,
      transition: s?.transition ? { from: s.transition.fromItemId, to: s.transition.toItemId, cueId: s.transition.cueId, phase: s.transition.phase } : null,
      replay: s?.narration?.replay ?? null,
      queue: (s?.queue ?? []).filter((entry) => entry.item.itemId !== program?.item.itemId).map((entry) => ({ itemId: entry.item.itemId, mediaId: entry.item.track.mediaId, origin: entry.item.origin })),
      history: (s?.history ?? []).map((entry) => ({ itemId: entry.item.itemId, mediaId: entry.item.track.mediaId, outcome: entry.outcome, started: entry.started }))
    };
  });
}

async function waitFor(read, predicate, timeoutMs = 15000, intervalMs = 120) {
  const end = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await read().catch((error) => ({ error: String(error) }));
    if (last && !last.error && predicate(last)) return { ok: true, last };
    await delay(intervalMs);
  } while (Date.now() < end);
  return { ok: false, last };
}

// Listeners click the tab in front; background tabs run no animation frames, which clicks wait for.
const clickLabel = async (tab, label) => {
  await tab.page.bringToFront();
  const selector = `button[aria-label="${label}"]`;
  await tab.page.waitForSelector(selector, { visible: true, timeout: 5000 });
  await tab.page.click(selector);
};
/** Caption text without the estimate badge (lyrics captions have no inner text span). */
const caption = (tab) => tab.page.evaluate(() => {
  const element = document.querySelector(".program-subtitle");
  return element ? (element.querySelector(".caption-text") ?? element).textContent : null;
});
/**
 * One synchronous read of the DJ caption and both clocks: its sentence, badge
 * and timing class, the snapshot's subtitle track, and the voice and program
 * music positions from the same clock reading.
 */
const djCaption = (tab) => tab.page.evaluate(() => {
  const element = document.querySelector(".program-subtitle");
  const bridge = window.__claudioPlayback;
  const snapshot = bridge.view().snapshot;
  const reading = bridge.clock();
  const deck = snapshot?.program?.deck ? reading.decks[snapshot.program.deck] : null;
  return {
    text: element ? (element.querySelector(".caption-text") ?? element).textContent : null,
    badge: element?.querySelector(".caption-badge")?.textContent ?? null,
    timing: element?.getAttribute("data-timing") ?? null,
    whole: element?.classList.contains("is-whole") ?? false,
    title: element?.getAttribute("title") ?? null,
    voiceStatus: snapshot?.voice?.status ?? null,
    script: snapshot?.voice?.scriptText ?? null,
    subtitle: snapshot?.voice?.subtitle ?? null,
    voiceMs: reading.voice?.positionMs ?? null,
    musicMs: deck?.positionMs ?? null
  };
});
/** Index of the estimated/native segment at `ms`, as the UI computes it. */
const segmentAt = (subtitle, ms) => {
  let active = -1;
  (subtitle?.segments ?? []).forEach((segment, index) => {
    if (segment.startMs !== undefined && segment.startMs <= ms) active = index;
  });
  return active;
};
/** Voice-branch labels of the open panel: LyricsPanel header and the transcript line labels. */
const panelLabels = (tab) => tab.page.evaluate(() => ({
  lyricsHead: document.querySelector(".lyrics-panel-head small")?.textContent ?? null,
  transcript: [...document.querySelectorAll(".voice-transcript p small")].map((small) => small.textContent),
  transcriptTiming: document.querySelector(".voice-transcript")?.getAttribute("data-timing") ?? null
}));
const nativeMedia = async (tab) => (await readObservation(tab.page))?.media ?? [];
async function chat(tab, text) {
  await tab.page.bringToFront();
  await tab.page.click('[aria-label="聊天输入"]', { count: 3 });
  await tab.page.keyboard.type(text);
  await tab.page.keyboard.press("Enter");
}
/** Moves the main progress slider the way a listener does (input event on the range). */
async function seekSlider(tab, seconds) {
  await tab.page.evaluate((value) => {
    const input = document.querySelector('input[aria-label="播放进度"]');
    if (!input || input.disabled) throw new Error("progress slider disabled");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, seconds);
}
/** The program's native element: the one playing a stream that progressed most recently. */
async function musicElement(tab) {
  const media = await nativeMedia(tab);
  return media.filter((element) => element.src.includes(STREAM) && !element.paused).sort((a, b) => b.currentTime - a.currentTime)[0] ?? null;
}

/** One synchronous page read: the full snapshot, the runtime's info log and every native media element at that instant. */
const moment = (tab) => tab.page.evaluate(() => {
  const bridge = window.__claudioPlayback;
  return { at: Date.now(), snapshot: bridge?.view().snapshot ?? null, log: bridge?.log() ?? [], media: window.__uiE2eObserver.read().media };
});
/** True when a media element's src is the stream handle (handles are same-origin paths). */
const sameStream = (src, handle) => {
  try {
    const a = new URL(src);
    const b = new URL(handle, a.origin);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
};
/**
 * Which stream handle the server issued for what, from the recorded HTTP answers:
 * music handles per item (prepare stages / preparation polls / resolve) and voice
 * handles per cue with the A→B pair and source revisions the cue was requested for
 * (POST narration, or narration carried by B's prepare).
 */
function streamBindings(requests) {
  const preparations = new Map();
  for (const row of requests) if (row.method === "POST" && row.path === "/api/v1/playback/prepare" && row.response?.preparationId) preparations.set(row.response.preparationId, row.body);
  const music = [];
  const voice = [];
  const voiceFrom = (row, via, cueId, from, to, stage, script) => {
    if (stage?.status !== "ready") return;
    voice.push({ seq: row.seq, via, cueId, fromItemId: from.itemId, fromRevision: from.revision, toItemId: to.itemId, toRevision: to.revision, handle: stage.value.stream.handle, voiceAssetId: stage.value.assetId, scriptAssetId: stage.value.scriptAssetId, script: script?.status === "ready" ? { assetId: script.value.assetId, text: script.value.text } : null });
  };
  for (const row of requests) {
    const answer = row.response;
    if (!answer || (row.status ?? 200) >= 400) continue;
    if (answer.stages && answer.itemId) {
      const source = answer.stages.source?.status === "ready" ? answer.stages.source.value : null;
      if (source) music.push({ seq: row.seq, itemId: answer.itemId, handle: source.stream.handle, mediaId: source.track.mediaId, sourceRevision: source.sourceRevision, recordingId: source.recording?.recordingId ?? null });
      const request = preparations.get(answer.preparationId);
      if (request?.narration) voiceFrom(row, "prepare", request.narration.cueId, { itemId: request.narration.fromItemId, revision: request.narration.fromRevision }, { itemId: answer.itemId, revision: source?.sourceRevision ?? null }, answer.stages.voice, answer.stages.script);
    } else if (row.path === "/api/v1/playback/resolve" && answer.media) {
      music.push({ seq: row.seq, itemId: answer.itemId, handle: answer.media.stream.handle, mediaId: answer.media.track.mediaId, sourceRevision: answer.media.sourceRevision, recordingId: answer.media.recording?.recordingId ?? null });
    } else if (row.path === "/api/v1/playback/narration" && row.body?.from) {
      voiceFrom(row, "narration", answer.cueId, { itemId: row.body.from.itemId, revision: row.body.from.sourceRevision }, { itemId: row.body.to.itemId, revision: row.body.to.sourceRevision }, answer.voice, answer.script);
    }
  }
  return { music, voice };
}

/**
 * Strict sequential A→DJ→B at one instant, from two `moment` reads ~0.6 s apart.
 * The cue in the snapshot is tied to a real element: the voice handle the server
 * issued for exactly this (A item, rev) → (B item, rev) pair is the src of the one
 * element that plays and advances; that asset's script is the cue's script. The
 * cue is either the one that was requested, or (logged by the core) a new cue
 * that reused an unspoken asset of the same pair, which needs no new request.
 * At the same reads A's own element has ended and B's elements are silent, and B
 * has neither a receipt nor a started fact. The script must name B's catalog
 * title and be the writer's text for a request from A to B.
 */
async function sequentialTalk(s, tab, aItemId, bItemId) {
  const m1 = await moment(tab);
  const server1 = await s.state();
  await delay(600);
  const m2 = await moment(tab);
  const log = await s.fixture.api("GET", "/__fixture/log?afterSeq=0");
  const bindings = streamBindings(log.requests);
  const snap = m1.snapshot;
  const voice = snap?.voice ?? null;
  const transition = snap?.transition ?? null;
  const program = snap?.program ?? null;
  const programDeck = program?.deck ? snap.decks[program.deck] : null;
  const handlesOf = (itemId) => bindings.music.filter((entry) => entry.itemId === itemId);
  const elementsOf = (media, entries) => media.filter((element) => entries.some((entry) => sameStream(element.src, entry.handle)));
  // A request revision is null when that item was not resolved yet at request time (B usually is not); a known one must match.
  const sameRevision = (requested, planned) => requested === null || requested === planned;
  const pairAssets = bindings.voice.filter((entry) => entry.fromItemId === aItemId && entry.toItemId === bItemId && transition && sameRevision(entry.fromRevision, transition.fromRevision) && sameRevision(entry.toRevision, transition.toRevision));
  const allMusic = bindings.music;
  const unpaused1 = m1.media.filter((element) => !element.paused);
  const unpaused2 = m2.media.filter((element) => !element.paused);
  const voiceElement1 = unpaused1.length === 1 && elementsOf(unpaused1, pairAssets).length === 1 ? unpaused1[0] : null;
  const voiceElement2 = voiceElement1 ? m2.media.find((element) => element.id === voiceElement1.id) : null;
  const asset = voiceElement1 ? pairAssets.find((entry) => sameStream(voiceElement1.src, entry.handle)) : null;
  const reuseNote = m1.log.some((entry) => entry.event === "note" && /reused unspoken narration asset/.test(entry.data?.reason ?? ""));
  const cueBinding = asset && voice ? (asset.cueId === voice.cueId ? "requested" : reuseNote ? "reused" : null) : null;
  const aMusic = handlesOf(aItemId);
  const bMusic = handlesOf(bItemId);
  const aElements = [m1, m2].map((m) => elementsOf(m.media, aMusic));
  const bElements = [m1, m2].map((m) => elementsOf(m.media, bMusic));
  const bTitle = server1.tracks.find((track) => track.mediaId === "B")?.title ?? null;
  const writer = log.events.filter((event) => event.type === "script-start" && event.from?.mediaId === "A" && event.to?.mediaId === "B").map((event) => event.call);
  const written = log.events.filter((event) => event.type === "script-ready" && writer.includes(event.call)).map((event) => event.text);
  const bStartedPosts = log.requests.filter((row) => row.method === "POST" && row.path === "/api/v1/playback/started" && row.body?.itemId === bItemId && row.seq <= server1.requestCount);
  const facts = {
    voiceCue:
      voice?.origin === "transition" && voice.status === "speaking" && transition?.fromItemId === aItemId && transition.toItemId === bItemId && transition.cueId === voice.cueId && transition.phase === "talking" && snap.display?.kind === "voice" && snap.display.cueId === voice.cueId,
    voiceElement:
      voiceElement1 !== null && voiceElement2 !== undefined && voiceElement2 !== null && !voiceElement2.paused && voiceElement2.src === voiceElement1.src && voiceElement2.currentTime - voiceElement1.currentTime >= 0.3 && unpaused2.length === 1 && unpaused2[0].id === voiceElement1.id && !allMusic.some((entry) => sameStream(voiceElement1.src, entry.handle)),
    assetIsCue: asset !== null && asset !== undefined && cueBinding !== null && asset.script?.assetId === asset.scriptAssetId && asset.script?.text === voice.scriptText,
    // The binding's revisions are the ones A's deck plays (with its recording) and the one B was resolved to.
    identity:
      transition !== null && programDeck !== null && transition.fromRevision !== null && transition.toRevision !== null && transition.fromRevision === programDeck.sourceRevision &&
      aMusic.some((entry) => entry.mediaId === "A" && entry.sourceRevision === transition.fromRevision && entry.recordingId === programDeck.recordingId) &&
      bMusic.some((entry) => entry.mediaId === "B" && entry.sourceRevision === transition.toRevision && entry.recordingId !== null),
    aEnded:
      program?.item.itemId === aItemId && program.started && programDeck?.status === "ended" && programDeck.itemId === aItemId && aElements.every((list) => list.length >= 1 && list.every((element) => element.paused)) && aElements[0].some((element) => element.ended),
    bSilent:
      program?.item.itemId !== bItemId && snap.queue.some((entry) => entry.item.itemId === bItemId) && !snap.receipts.some((receipt) => receipt.itemId === bItemId) && startedFor(server1, bItemId).length === 0 && bStartedPosts.length === 0 && bElements.every((list) => list.every((element) => element.paused)) && bElements[1].every((element) => Math.abs(element.currentTime - (bElements[0].find((x) => x.id === element.id)?.currentTime ?? element.currentTime)) < 0.01),
    namesB: bTitle !== null && (voice?.scriptText ?? "").includes(bTitle) && written.includes(voice?.scriptText ?? "\u0000")
  };
  const evidence = {
    facts,
    cue: voice && { cueId: voice.cueId, status: voice.status, voiceLoadId: voice.voiceLoadId, script: voice.scriptText },
    transition,
    program: program && { itemId: program.item.itemId, mediaId: program.item.track.mediaId, started: program.started, deck: programDeck && { status: programDeck.status, itemId: programDeck.itemId, sourceRevision: programDeck.sourceRevision, recordingId: programDeck.recordingId } },
    cueBinding,
    reuseNote,
    asset,
    pairAssets,
    voiceElement: [voiceElement1, voiceElement2],
    aElements,
    bElements,
    aMusic,
    bMusic,
    unpaused: [unpaused1, unpaused2],
    bTitle,
    writerCalls: writer,
    receipts: snap?.receipts ?? null,
    serverStarted: server1.started.map((fact) => `${fact.track.mediaId}:${fact.itemId}`)
  };
  return { ok: Object.values(facts).every(Boolean), facts, evidence, snapshot: snap };
}

class Scenario {
  constructor(name) {
    this.name = name;
    this.dir = path.join(outRoot, name);
    fs.mkdirSync(this.dir, { recursive: true });
    this.checks = [];
    this.tabs = [];
    this.notes = [];
  }
  check(name, passed, evidence) {
    this.checks.push({ name, passed: Boolean(passed), evidence });
    console.log(`  ${passed ? "PASS" : "FAIL"} ${name}`);
    return Boolean(passed);
  }
  async start({ config } = {}) {
    this.fixture = await startFixture({ web: true });
    if (config) await this.fixture.api("POST", "/__fixture/config", config);
    const { browser, environment } = await launchBrowser(this.dir);
    this.browser = browser;
    this.environment = environment;
    this.context = await browser.createBrowserContext();
  }
  async tab(label, options = {}) {
    const { ready } = this.fixture;
    const tab = await openPage(this.context, { label, origins: [ready.webOrigin, ready.apiOrigin], artifactDir: this.dir, ...options });
    this.tabs.push(tab);
    await tab.page.goto(ready.webOrigin, { waitUntil: "domcontentloaded", timeout: 30000 });
    return tab;
  }
  phase(name) {
    return this.fixture.api("POST", "/__fixture/phase", { name });
  }
  state() {
    return this.fixture.api("GET", "/__fixture/state");
  }
  async requests() {
    return (await this.fixture.api("GET", "/__fixture/log?afterSeq=0")).requests;
  }
  async executor(tab, timeoutMs = 20000) {
    const ready = await waitFor(() => view(tab), (v) => v?.role === "executor" && v.canControl && v.transport !== null, timeoutMs);
    if (!ready.ok) throw new Error(`${tab.label} never became the executor: ${JSON.stringify(ready.last)}`);
    return ready.last;
  }
  async finish(error) {
    const result = { scenario: this.name, checks: this.checks, notes: this.notes, environment: this.environment ?? null };
    if (error) result.error = String(error?.stack ?? error);
    for (const tab of this.tabs) {
      try {
        tab.dump();
      } catch {
        // Page already gone.
      }
    }
    try {
      if (this.fixture) {
        const state = await this.state();
        result.fixture = { runDir: this.fixture.runDir, started: state.started, violations: state.violations, counters: state.counters, tastes: state.tastes, login: state.login };
        this.check("no old side-effect playback route was called (radio/next, legacy stream/source/TTS, PUT /api/now)", state.violations.length === 0, state.violations);
      }
    } catch (stateError) {
      result.stateError = String(stateError);
    }
    await this.browser?.close().catch(() => {});
    if (this.fixture) result.shutdown = await this.fixture.stop().catch((stopError) => String(stopError));
    result.passed = !error && this.checks.length > 0 && this.checks.every((check) => check.passed);
    fs.writeFileSync(path.join(this.dir, "result.json"), JSON.stringify(result, null, 2));
    return result;
  }
}

/**
 * After a withdrawn radio start: waits until the late candidate is in the queue
 * (the chooser is slow on purpose) and samples throughout that nothing sounds.
 */
async function silentArrival(s, tab, timeoutMs = 20000) {
  const sounding = [];
  const arrived = await waitFor(async () => {
    const v = await view(tab);
    const playing = (await nativeMedia(tab)).filter((element) => !element.paused);
    if (playing.length > 0 || v.transport === "playing") sounding.push({ transport: v.transport, playing });
    return v;
  }, (v) => v.queue.length === 1, timeoutMs, 100);
  await delay(1500);
  const after = await view(tab);
  const playing = (await nativeMedia(tab)).filter((element) => !element.paused);
  if (playing.length > 0 || after.transport === "playing") sounding.push({ transport: after.transport, playing });
  const pcm = ((await readObservation(tab.page)).pcm ?? []).filter((window) => window.rms > 1e-6);
  return { arrived: arrived.ok, after, sounding, pcm: pcm.length, started: (await s.state()).started.length };
}

/** Plays A from an idle page through the chat ("播放 A"), as a listener would. */
async function playViaChat(s, tab, mediaId) {
  await chat(tab, `播放 ${mediaId}`);
  const playing = await waitFor(() => view(tab), (v) => v.transport === "playing" && v.program?.mediaId === mediaId && v.program.started, 20000);
  if (!playing.ok) throw new Error(`chat pick ${mediaId} did not play: ${JSON.stringify(playing.last)}`);
  return playing.last;
}
/** Queues `mediaId` next through the chat; returns the new occurrence (radio refills may hold the same track). */
async function queueViaChat(tab, mediaId) {
  const known = new Set([...(await view(tab)).queue.map((entry) => entry.itemId)]);
  await chat(tab, `下一首 ${mediaId}`);
  const fresh = (v) => v.queue.find((entry) => entry.mediaId === mediaId && entry.origin === "chat" && !known.has(entry.itemId));
  const queued = await waitFor(() => view(tab), (v) => Boolean(fresh(v)), 15000);
  if (!queued.ok) throw new Error(`chat queuePick ${mediaId} was not queued: ${JSON.stringify(queued.last)}`);
  return fresh(queued.last);
}
const startedFor = (state, itemId) => state.started.filter((fact) => fact.itemId === itemId);
/** The snapshot shows `started` once the receipt is emitted; the server store has it a moment later. */
async function serverState(s, ...itemIds) {
  const recorded = await waitFor(() => s.state(), (state) => itemIds.every((itemId) => startedFor(state, itemId).length > 0), 5000);
  return recorded.last;
}

// ---------------------------------------------------------------- scenarios

const scenarios = {
  /** One page: chat pick, lyrics, pause/seek, strict A→DJ→B, manual replay, media keys/Space, refresh restore. */
  async program(s) {
    await s.start({ config: { scriptDelayMs: 200, ttsDelayMs: 400, voiceDurationMs: 4000 } });
    const tab = await s.tab("tab-A");
    await s.executor(tab);
    const a = await playViaChat(s, tab, "A");
    const before = await readObservation(tab.page);
    await delay(800);
    const moving = progressing(before, await readObservation(tab.page)).filter((element) => element.src.includes(STREAM));
    s.check("chat 播放 A: A is the program, confirmed playing, its native element advances", moving.length === 1, { program: a.program, moving });
    const b = await queueViaChat(tab, "B");
    s.check("chat 下一首 B queues B after the program (one occurrence)", (await view(tab)).queue[0]?.itemId === b.itemId, b);

    // Lyrics: the caption follows the music clock (first timed line at 4.0 s).
    const lyric = await waitFor(async () => ({ v: await view(tab), caption: await caption(tab), media: await musicElement(tab) }), (r) => r.v.display?.lyrics === "available" && r.media && r.media.currentTime > 4.2 && r.media.currentTime < 7.5 && r.caption !== null, 12000);
    s.check("caption shows the current word-timed lyric line of A while it plays", lyric.ok && lyric.last.caption === "灯亮之前", { caption: lyric.last?.caption, time: lyric.last?.media?.currentTime });
    await tab.capture("01-a-lyrics");

    // Pause, seek while paused, resume.
    await s.phase("pause-seek");
    await clickLabel(tab, "暂停");
    const paused = await waitFor(() => view(tab), (v) => v.transport === "paused", 5000);
    const m1 = (await nativeMedia(tab)).filter((element) => element.src.includes(STREAM));
    await delay(1000);
    const m2 = (await nativeMedia(tab)).filter((element) => element.src.includes(STREAM));
    s.check("pause: transport paused, every music element paused and its currentTime frozen", paused.ok && m2.every((element) => element.paused) && m2.every((element) => Math.abs(element.currentTime - (m1.find((x) => x.id === element.id)?.currentTime ?? -1)) < 0.01), { m1, m2 });
    await seekSlider(tab, 2);
    await delay(1200);
    const afterSeek = await view(tab);
    const programElement = (await nativeMedia(tab)).filter((element) => element.src.includes(STREAM)).find((element) => Math.abs(element.currentTime - 2) < 0.35);
    s.check("seek while paused stays paused and lands the native element at 2 s", afterSeek.transport === "paused" && programElement?.paused === true, { transport: afterSeek.transport, programElement });
    const startedBeforeResume = startedFor(await s.state(), a.program.itemId).length;
    await clickLabel(tab, "播放");
    const resumed = await waitFor(() => view(tab), (v) => v.transport === "playing", 5000);
    await delay(700);
    const resumedElement = await musicElement(tab);
    s.check("resume continues the same item from ~2 s without a second started", resumed.ok && resumed.last.program.itemId === a.program.itemId && resumedElement && resumedElement.currentTime > 2 && resumedElement.currentTime < 4.5 && startedFor(await s.state(), a.program.itemId).length === startedBeforeResume && startedBeforeResume === 1, { resumed: resumed.last?.program, time: resumedElement?.currentTime, startedBeforeResume });

    // Strict A → DJ → B.
    await s.phase("a-dj-b");
    await seekSlider(tab, 7);
    const dj = await waitFor(() => view(tab), (v) => v.voice?.origin === "transition" && v.voice.status === "speaking" && v.transition?.from === a.program.itemId && v.transition.to === b.itemId && v.transition.cueId === v.voice.cueId && v.display?.kind === "voice" && v.display.cueId === v.voice.cueId, 25000, 80);
    let talk = null;
    const captions = [];
    let panel = null;
    if (dj.ok) {
      talk = await sequentialTalk(s, tab, a.program.itemId, b.itemId);
      // Sentences across the voice, each read with the clock reading it was drawn from.
      for (let index = 0; index < 8; index += 1) {
        const read = await djCaption(tab);
        if (read.voiceStatus !== "speaking") break;
        captions.push(read);
        await delay(350);
      }
      await tab.capture("02-dj-speaking");
      await clickLabel(tab, "打开 Claudio 口播与歌词面板");
      await tab.page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      panel = { ...(await panelLabels(tab)), voiceStatus: (await view(tab)).voice?.status ?? null };
      await tab.capture("02b-dj-panel");
      await clickLabel(tab, "关闭面板");
    }
    // The spoken cue may reuse an asset requested under an earlier cue id of the same A→B pair
    // (a seek re-plans the transition and keeps an unspoken asset), so the asset is matched by the pair.
    const f = talk?.facts ?? {};
    s.check("A→DJ: the snapshot's transition cue for exactly A's item → the chat-queued B item is speaking, bound to A's deck revision/recording and B's resolved revision", dj.ok && b.origin === "chat" && f.voiceCue && f.identity, talk?.evidence ?? dj.last);
    s.check("native voice: the one playing, advancing element has the voice handle the server issued for that A→B pair, and that asset's script is the cue's (requested cue, or a core-logged reuse of the pair's unspoken asset)", dj.ok && f.voiceElement && f.assetIsCue, talk?.evidence ?? null);
    s.check("same reads: A's own element has ended and its deck is ended; B's elements are silent and B has no receipt, no started request and no started fact", dj.ok && f.aEnded && f.bSilent, talk?.evidence ?? null);
    s.check("the spoken script names B by its fixture catalog title and is the writer's text for an A→B request", dj.ok && f.namesB, talk && { bTitle: talk.evidence.bTitle, script: talk.evidence.cue?.script, writerCalls: talk.evidence.writerCalls });
    const sentences = captions.map((read) => {
      const index = segmentAt(read.subtitle, read.voiceMs);
      // The caption re-renders every 150 ms: next to a boundary the neighbouring sentence is also right.
      // That is the sentence starting there and the one ending there.
      const segments = read.subtitle?.segments ?? [];
      const near = segments.filter((segment, i) => Math.abs(segment.startMs - read.voiceMs) < 250 || (segments[i + 1] !== undefined && Math.abs(segments[i + 1].startMs - read.voiceMs) < 250)).map((segment) => segment.text);
      return { text: read.text, expected: read.subtitle?.segments[index]?.text ?? null, near, voiceMs: read.voiceMs, musicMs: read.musicMs, badge: read.badge, timing: read.timing, whole: read.whole };
    });
    s.check(
      "DJ caption: the core's estimated sentence at the voice clock, with a visible 估算 badge separate from the sentence text",
      captions.length >= 3 &&
        captions.every((read) => read.subtitle?.timing === "estimated" && read.timing === "estimated" && read.badge === "估算" && !read.whole) &&
        sentences.every((entry) => entry.text === entry.expected || entry.near.includes(entry.text)) &&
        new Set(sentences.map((entry) => entry.text)).size >= 2 &&
        sentences.every((entry) => (dj.last?.display?.text ?? "").includes(entry.text)),
      { sentences, segments: captions[0]?.subtitle?.segments }
    );
    s.check(
      "open panel during the DJ: LyricsPanel says 时间为估算 and the transcript lines are labelled as estimates",
      panel !== null && panel.voiceStatus === "speaking" && panel.lyricsHead === "Claudio 正在串场 · 时间为估算" && panel.transcriptTiming === "estimated" && panel.transcript.length >= 2 && panel.transcript.every((label) => label === "Claudio · 时间为估算"),
      panel
    );
    const bPlaying = await waitFor(() => view(tab), (v) => v.program?.itemId === b.itemId && v.program.mediaId === "B" && v.program.started && v.transport === "playing", 30000);
    const state1 = await serverState(s, b.itemId);
    const order = state1.started.map((fact) => `${fact.track.mediaId}:${fact.itemId}`);
    // started.recent() lists newest first.
    s.check("DJ→B: the chat-queued B occurrence becomes the program and is confirmed started; the started store holds exactly B after A", bPlaying.ok && state1.started.length === 2 && state1.started[0]?.itemId === b.itemId && state1.started[1]?.itemId === a.program.itemId, { order, program: bPlaying.last?.program });
    const startedAfterB = state1.started.length;
    await tab.capture("03-b-playing");

    // Manual replay on B: lyrics stay on music, panel pauses only the voice, no new started.
    await s.phase("manual-replay");
    const replayable = await waitFor(() => view(tab), (v) => v.replay?.available === true, 10000);
    await clickLabel(tab, "重播这首的串词");
    const manual = await waitFor(() => view(tab), (v) => v.voice?.origin === "manual" && v.voice.status === "speaking", 10000, 80);
    s.check("manual replay speaks with origin=manual while the display stays on B's music (lyrics stay)", replayable.ok && manual.ok && manual.last.display?.kind === "music" && manual.last.program.itemId === b.itemId, { voice: manual.last?.voice, display: manual.last?.display });
    await clickLabel(tab, "打开 Claudio 口播与歌词面板");
    await tab.page.waitForSelector('[role="dialog"]', { timeout: 5000 });
    await clickLabel(tab, "暂停口播");
    const voicePaused = await waitFor(() => view(tab), (v) => v.voice?.status === "paused" && v.voice.pausedBy === "user", 5000);
    const o3 = await readObservation(tab.page);
    await delay(900);
    const o4 = await readObservation(tab.page);
    const musicStillMoving = progressing(o3, o4).filter((element) => element.src.includes(STREAM));
    const transcript = await tab.page.evaluate(() => [...document.querySelectorAll(".voice-transcript p")].map((p) => p.textContent));
    const lyricCaption = await caption(tab);
    s.check("panel pause stops only the voice: voice paused by user, music transport playing and exactly one element (music) advancing", voicePaused.ok && voicePaused.last.transport === "playing" && musicStillMoving.length === 1, { voice: voicePaused.last?.voice, transport: voicePaused.last?.transport, musicStillMoving });
    s.check("two subtitle channels: panel transcript shows the DJ script, the caption is never the DJ text during a manual replay", transcript.some((line) => line.includes("接下来")) && !(manual.last?.voice?.script ?? "").includes(lyricCaption || "\u0000"), { transcript, lyricCaption });
    await tab.capture("04-voice-paused-music-on");
    await clickLabel(tab, "继续口播");
    const voiceResumed = await waitFor(() => view(tab), (v) => v.voice?.status === "speaking", 5000);
    s.check("panel resume continues the voice", voiceResumed.ok, voiceResumed.last?.voice);
    await clickLabel(tab, "关闭面板");
    await waitFor(() => view(tab), (v) => v.voice === null || v.voice.status !== "speaking", 10000);
    s.check("manual replay wrote no new started fact", (await s.state()).started.length === startedAfterB, (await s.state()).started.map((fact) => fact.itemId));

    // Media keys (the handlers the app registered) and Space.
    await s.phase("media-keys");
    const actions = (await readObservation(tab.page)).mediaSessionActions;
    s.check("owner registered Media Session play/pause/nexttrack/previoustrack", ["play", "pause", "nexttrack", "previoustrack"].every((action) => actions.includes(action)), actions);
    const run = (action) => tab.page.evaluate((name) => window.__uiE2eObserver.mediaSession(name), action);
    await waitFor(() => view(tab), (v) => v.transport === "playing", 5000);
    await run("play");
    await delay(800);
    const playOnPlaying = await view(tab);
    const elementAfterPlay = await musicElement(tab);
    s.check("Media Session play while playing keeps playing", playOnPlaying.transport === "playing" && elementAfterPlay !== null, { transport: playOnPlaying.transport });
    await run("pause");
    const mkPaused = await waitFor(() => view(tab), (v) => v.transport === "paused", 5000);
    await run("pause");
    const p1 = (await nativeMedia(tab)).filter((element) => element.src.includes(STREAM));
    await delay(1200);
    const p2 = await view(tab);
    const p3 = (await nativeMedia(tab)).filter((element) => element.src.includes(STREAM));
    s.check("Media Session pause pauses; a second pause keeps it paused and the native time frozen", mkPaused.ok && p2.transport === "paused" && p3.every((element) => element.paused && Math.abs(element.currentTime - (p1.find((x) => x.id === element.id)?.currentTime ?? -1)) < 0.01), { transport: p2.transport, p1, p3 });
    await run("play");
    const mkResumed = await waitFor(() => view(tab), (v) => v.transport === "playing", 5000);
    s.check("Media Session play while paused resumes", mkResumed.ok, mkResumed.last?.transport);
    await tab.page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await tab.page.keyboard.press("Space");
    const spacePaused = await waitFor(() => view(tab), (v) => v.transport === "paused", 5000);
    await tab.page.keyboard.press("Space");
    const spacePlaying = await waitFor(() => view(tab), (v) => v.transport === "playing", 5000);
    s.check("Space toggles pause and play", spacePaused.ok && spacePlaying.ok, { paused: spacePaused.last?.transport, playing: spacePlaying.last?.transport });
    const contexts = (await readObservation(tab.page)).contexts;
    s.check("the owner page created exactly one AudioContext", contexts.length === 1, contexts);

    // Refresh: the queue comes back stopped.
    await s.phase("refresh");
    const startedBeforeReload = (await s.state()).started.length;
    await tab.page.reload({ waitUntil: "domcontentloaded" });
    const reloaded = await s.executor(tab);
    await delay(2500);
    const quiet = (await nativeMedia(tab)).filter((element) => !element.paused);
    const notice = await tab.page.evaluate(() => document.body.innerText.includes("已恢复上次的队列，按播放继续"));
    s.check("after a refresh the restored queue is stopped: no element plays, no new started, the listener is told", reloaded.transport === "idle" && reloaded.queue.length > 0 && quiet.length === 0 && (await s.state()).started.length === startedBeforeReload && notice, { transport: reloaded.transport, queue: reloaded.queue, quiet, notice });
    await tab.capture("05-restored");
    await clickLabel(tab, "播放");
    const restoredPlay = await waitFor(() => view(tab), (v) => v.transport === "playing" && v.program?.started, 15000);
    s.check("play after the refresh starts the first restored entry", restoredPlay.ok && restoredPlay.last.program.mediaId === reloaded.queue[0].mediaId, { program: restoredPlay.last?.program, first: reloaded.queue[0] });
  },

  /** Two pages: observer has no audio and sends no playback HTTP; frozen broadcasts; owner close → stopped takeover. */
  async ownership(s) {
    await s.start();
    const a = await s.tab("tab-A");
    await s.executor(a);
    const b = await s.tab("tab-B");
    const observing = await waitFor(() => view(b), (v) => v?.role === "observer" && !v.canControl, 15000);
    s.check("second page is a read-only observer", observing.ok, observing.last);
    await clickLabel(a, "播放");
    const playing = await waitFor(() => view(a), (v) => v.transport === "playing" && v.program?.started, 20000);
    const mirrored = await waitFor(() => view(b), (v) => v.program?.itemId === playing.last?.program?.itemId && v.transport === "playing", 8000);
    s.check("observer mirrors the owner's program", playing.ok && mirrored.ok, { owner: playing.last?.program, observer: mirrored.last?.program });
    const disabled = await b.page.$eval('button[aria-label="下一首"]', (button) => button.disabled);
    await delay(1500);
    const obsB = await readObservation(b.page);
    s.check("observer created no AudioContext and no media element", obsB.contexts.length === 0 && obsB.media.length === 0 && disabled, { contexts: obsB.contexts, media: obsB.media, disabled });

    // Owner stops broadcasting for 5 s: its page is frozen (task queues stopped). A debugger
    // pause would also stop the observer, which shares the renderer process.
    await s.phase("broadcast-stall");
    const cdp = await a.page.createCDPSession();
    const slider = () => b.page.$eval('input[aria-label="播放进度"]', (input) => Number(input.value));
    const flowing = await waitFor(() => view(b), (v) => v.version > mirrored.last.version, 4000);
    s.check("while the owner runs, the observer receives new snapshots", flowing.ok, { before: mirrored.last?.version, after: flowing.last?.version });
    const v0 = await view(b);
    await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
    const t0 = await slider();
    await delay(2200);
    const t1 = await slider();
    const v1 = await view(b);
    await delay(2800);
    const t2 = await slider();
    const v2 = await view(b);
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    await cdp.detach().catch(() => {});
    s.check("broadcasts stopped 5 s: observer snapshot unchanged and its position stops (≤1.5 s honest extrapolation, no invented clock)", v1.version === v2.version && t2 === t1 && t2 - t0 <= 2, { versions: [v0.version, v1.version, v2.version], positions: [t0, t1, t2] });
    const recovered = await waitFor(() => view(b), (v) => v.version > v2.version, 6000);
    s.check("observer follows again once the owner runs", recovered.ok, recovered.last?.version);

    const observerEffects = (await s.requests()).filter((row) => row.client === "tab-B" && PLAYBACK_EFFECT(row));
    const observerNetwork = b.network.filter((row) => row.type === "request" && /\/api\/v1\/(playback|now)/.test(row.url) && !row.url.includes("/now/stream"));
    s.check("observer sent no playback/now effects (server log and its own network)", observerEffects.length === 0 && observerNetwork.length === 0, { observerEffects, observerNetwork });
    await b.capture("01-observer");

    // Owner leaves: the observer takes over with a stopped queue.
    await s.phase("takeover");
    const startedBefore = (await s.state()).started.length;
    a.dump();
    await a.page.close();
    const takeover = await waitFor(() => view(b), (v) => v.role === "executor" && v.canControl, 15000);
    await delay(2500);
    const quiet = (await nativeMedia(b)).filter((element) => !element.paused);
    s.check("after the owner closes, the observer takes over and nothing plays by itself", takeover.ok && takeover.last.transport !== "playing" && quiet.length === 0 && (await s.state()).started.length === startedBefore, { takeover: takeover.last?.transport, quiet });
    await b.capture("02-takeover");
    await clickLabel(b, "播放");
    const resumed = await waitFor(() => view(b), (v) => v.transport === "playing" && v.program?.started, 15000);
    s.check("the new owner plays on the listener's click", resumed.ok, resumed.last?.program);
  },

  /** Radio start from an empty queue with a slow chooser: pause (media key / button) must keep the late candidate silent. */
  async controls(s) {
    await s.start({ config: { radioDelayMs: 2500 } });
    const tab = await s.tab("tab-A");
    await s.executor(tab);
    await clickLabel(tab, "播放");
    const waiting = await waitFor(() => s.state(), (state) => state.counters.radio >= 1, 5000);
    await tab.page.evaluate(() => window.__uiE2eObserver.mediaSession("pause"));
    const quiet = await silentArrival(s, tab);
    const after = quiet.after;
    s.check("media-key pause during the empty-queue start: the late candidate is queued silently (no playing, no PCM, no started)", waiting.ok && quiet.arrived && after.transport === "idle" && after.queue.length === 1 && quiet.sounding.length === 0 && quiet.pcm === 0 && quiet.started === 0, quiet);
    await tab.capture("01-silent-candidate");
    await tab.page.evaluate(() => window.__uiE2eObserver.mediaSession("play"));
    const played = await waitFor(() => view(tab), (v) => v.transport === "playing" && v.program?.started, 15000);
    s.check("Media Session play then plays that queued candidate", played.ok && played.last.program.itemId === after.queue[0]?.itemId, played.last?.program);
    const a = tab;


    // Main button on a fresh profile (empty queue): while the slow chooser runs the button reads
    // "取消开播" (nothing plays yet, so not "暂停"); pressing it withdraws the start the same way.
    await s.phase("main-button-cancel");
    a.dump();
    await tab.page.close();
    s.context = await s.browser.createBrowserContext();
    const fresh = await s.tab("tab-C");
    await s.executor(fresh);
    const radioBefore = (await s.state()).counters.radio;
    const startedBefore = (await s.state()).started.length;
    await clickLabel(fresh, "播放");
    const choosing = await waitFor(() => s.state(), (state) => state.counters.radio > radioBefore, 5000);
    const mainButton = () => fresh.page.$eval(".icon-button.primary", (button) => ({ label: button.getAttribute("aria-label"), title: button.getAttribute("title"), intent: button.getAttribute("data-intent"), spinner: button.querySelector(".spin") !== null }));
    const statusText = () => fresh.page.evaluate(() => document.body.innerText);
    const pending = await mainButton();
    const pendingNotice = (await statusText()).includes("再按播放键可取消开播");
    await fresh.capture("00-main-button-pending");
    await clickLabel(fresh, "取消开播");
    const afterCancel = await mainButton();
    const cancelledNotice = await waitFor(statusText, (text) => text.includes("已取消开播"), 3000);
    const quietMain = await silentArrival(s, fresh);
    const silent = quietMain.after;
    await fresh.capture("01-main-button-cancelled");
    s.check("main button: reads 取消开播 (spinner, not 暂停) while the start will play, and the notice says the same", choosing.ok && pending.label === "取消开播" && pending.intent === "cancel-start" && pending.spinner && pendingNotice, { pending, pendingNotice });
    s.check("pressing it: back to 播放, notice 已取消开播, the late candidate stays silent", afterCancel.label === "播放" && cancelledNotice.ok && quietMain.arrived && silent.transport === "idle" && silent.queue.length === 1 && quietMain.sounding.length === 0 && quietMain.pcm === 0 && quietMain.started === startedBefore, { afterCancel, ...quietMain });
    await clickLabel(fresh, "播放");
    const replayed = await waitFor(() => view(fresh), (v) => v.transport === "playing" && v.program?.started, 15000);
    s.check("pressing 播放 afterwards plays the silently queued candidate", replayed.ok && replayed.last.program.itemId === silent.queue[0]?.itemId, replayed.last?.program);
  },

  /** Legacy queue import with the real library DTO, like, chat, voice input, account (fake services, real components). */
  async features(s) {
    await s.start();
    const tab = await s.tab("tab-A", {
      fakeSpeech: true,
      beforeLoad: {
        fn: () => {
          if (localStorage.getItem("claudio.e2e.seeded")) return;
          localStorage.setItem("claudio.e2e.seeded", "1");
          localStorage.setItem("claudio.radioQueue", JSON.stringify([{ songId: "B", djLine: "旧版串词" }, { songId: "C" }, { songId: "gone-song" }]));
          localStorage.setItem("claudio.activePlaylist", JSON.stringify({ playlistId: "old", picks: [] }));
        },
        arg: null
      }
    });
    const restored = await s.executor(tab);
    const storage = await tab.page.evaluate(() => ({ mark: localStorage.getItem("claudio.legacy.import.v1"), backup: localStorage.getItem("claudio.legacy.backup.v1"), old: localStorage.getItem("claudio.radioQueue") }));
    const mark = JSON.parse(storage.mark ?? "null");
    s.check("old queue imported through the server-stated refs of the real /api/library DTO, stopped, unknown song skipped", restored.transport === "idle" && restored.queue.map((entry) => `${entry.mediaId}:${entry.origin}`).join(",") === "B:restore,C:restore" && mark?.status === "complete" && mark.imported === 2 && mark.skipped?.includes("gone-song"), { queue: restored.queue, mark });
    s.check("old keys untouched and a backup kept", storage.old?.includes("gone-song") && storage.backup?.includes("claudio.radioQueue"), { backup: storage.backup?.slice(0, 120) });
    await clickLabel(tab, "播放");
    const playingB = await waitFor(() => view(tab), (v) => v.transport === "playing" && v.program?.mediaId === "B" && v.program.started, 15000);
    const likeEnabled = await tab.page.$eval('button[aria-label="喜欢这首"]', (button) => !button.disabled);
    s.check("restored B plays and its like button is available (legacy id known via the DTO ref)", playingB.ok && likeEnabled, { program: playingB.last?.program, likeEnabled });
    await clickLabel(tab, "喜欢这首");
    const liked = await waitFor(async () => ({ pressed: await tab.page.$eval('button[aria-label="喜欢这首"]', (button) => button.getAttribute("aria-pressed")), tastes: (await s.state()).tastes }), (r) => r.pressed === "true" && r.tastes.includes("B:like"), 5000);
    s.check("like posts the legacy id of the playing track and lights only after the server accepted", liked.ok, liked.last);

    await s.phase("chat");
    await chat(tab, "你好");
    const reply = await waitFor(() => tab.page.evaluate(() => document.body.innerText.includes("没有调用任何模型")), (found) => found === true, 8000);
    s.check("plain chat reply is shown (fixture reply, no model)", reply.ok, null);
    await chat(tab, "下一首 A");
    const queuedA = await waitFor(() => view(tab), (v) => v.queue[0]?.mediaId === "A" && v.transport === "playing" && v.program.mediaId === "B", 8000);
    s.check("chat queuePick while listening: A queued next as one command, B keeps playing", queuedA.ok, queuedA.last?.queue);

    await s.phase("voice-input");
    const chatsBefore = (await s.requests()).filter((row) => row.path === "/api/chat").length;
    await clickLabel(tab, "语音输入");
    const listening = await waitFor(() => readObservation(tab.page), (o) => o.speech.starts === 1 && o.speech.micRequests === 1, 5000);
    const said = await tab.page.evaluate(() => window.__uiE2eObserver.say("加入", "加入队列 C"));
    const sent = await waitFor(async () => (await s.requests()).filter((row) => row.path === "/api/chat"), (rows) => rows.length === chatsBefore + 1 && rows.at(-1).body?.message === "加入队列 C", 8000);
    const released = await waitFor(() => readObservation(tab.page), (o) => o.speech.micTracksStopped >= 1, 5000);
    const queuedC = await waitFor(() => view(tab), (v) => v.queue.some((entry) => entry.mediaId === "C" && entry.origin !== "restore"), 8000);
    s.check("voice input: one final transcript sent once to chat, microphone released, its pick queued", listening.ok && said && sent.ok && released.ok && queuedC.ok, { speech: released.last?.speech, chat: sent.last?.at(-1)?.body });

    await s.phase("account");
    await tab.page.hover(".login-menu");
    await tab.page.type('input[placeholder="KuGou phone"]', "10000000000");
    await tab.page.type('input[placeholder="Code"]', "0000");
    await tab.page.evaluate(() => [...document.querySelectorAll(".kugou-login button")].find((button) => button.textContent?.includes("KuGou login"))?.click());
    const loggedIn = await waitFor(() => s.state(), (state) => state.login.loggedIn === true, 8000);
    const shown = await waitFor(() => tab.page.evaluate(() => document.querySelector(".login-button")?.textContent), (text) => text === "KUGOU", 8000);
    s.check("fake account login goes through the real account component (fixture only, not KuGou)", loggedIn.ok && shown.ok, { login: loggedIn.last?.login });
    await tab.page.hover(".login-menu");
    await tab.page.click(".kugou-logout");
    const loggedOut = await waitFor(() => s.state(), (state) => state.login.loggedIn === false, 8000);
    s.check("fake account logout", loggedOut.ok, null);
    s.check("account/chat traffic never touched playback: B still the program and playing", (await view(tab)).program?.mediaId === "B" && (await view(tab)).transport === "playing", null);
  },

  /** Folia stage from the pinned export: real readiness before hiding basic lyrics, Chinese highlight, seekEpoch on owner and observer. */
  async stage(s) {
    await s.start();
    const owner = await s.tab("tab-A");
    await s.executor(owner);
    await owner.page.evaluate(() => localStorage.setItem("claudio.settings.v1", JSON.stringify({ version: 1, theme: "dark", stageEnabled: true, musicVolume: 0.5, djEnabled: true })));
    await owner.page.reload({ waitUntil: "domcontentloaded" });
    await s.executor(owner);
    const webgl = await owner.page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl");
      if (!gl) return null;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return { renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) };
    });
    s.notes.push({ webgl });
    await chat(owner, "播放 A");
    await clickLabel(owner, "打开 Claudio 口播与歌词面板");
    // Until the stage really draws, the basic lyrics must stay; sample both while it starts.
    const gaps = [];
    const startEnd = Date.now() + 15000;
    let drawing = null;
    while (Date.now() < startEnd) {
      const sample = await owner.page.evaluate(() => {
        const stage = window.__claudioStage;
        const state = stage?.state() ?? null;
        const diagnostics = stage?.diagnostics() ?? null;
        const lyrics = window.__claudioPlayback.view().snapshot?.display?.lyrics?.status ?? null;
        return { state, renderer: diagnostics?.renderer ?? null, status: diagnostics?.status ?? null, basic: document.querySelector(".lyrics-panel .lyrics-lines") !== null, lyrics };
      });
      if (sample.lyrics === "available" && !sample.state?.drawing && !sample.basic) gaps.push(sample);
      if (sample.state?.drawing) {
        drawing = sample;
        break;
      }
      await delay(50);
    }
    s.check("basic lyrics stay visible until the stage reports drawing (renderer ready, no status)", gaps.length === 0, { gaps: gaps.slice(0, 5), drawing });
    s.check("the pinned Folia stage draws with WebGL in this browser", drawing?.renderer === "ready" && drawing.status === null && !drawing.basic, { drawing, webgl });

    // Chinese current-line highlight at 4.4–5.2 s (first timed line starts at 4.0 s; before that all lines are dim by design).
    const window1 = await waitFor(() => musicElement(owner), (element) => element && element.currentTime >= 4.45 && element.currentTime <= 5.0, 12000, 40);
    const shotStart = window1.last?.currentTime ?? null;
    await owner.page.screenshot({ path: path.join(s.dir, "stage-highlight-4.4-5.2s.png") });
    const shotEnd = (await musicElement(owner))?.currentTime ?? null;
    const diagnostics = await owner.page.evaluate(() => window.__claudioStage?.diagnostics() ?? null);
    s.check("stage screenshot taken while A's media time was inside 4.4–5.2 s (first line active)", window1.ok && shotEnd !== null && shotEnd <= 5.2 && diagnostics?.status === null, { shotStart, shotEnd, shownLyricSec: diagnostics?.shownLyricSec, mode: diagnostics?.mode });
    s.notes.push({ highlightScreenshot: "stage-highlight-4.4-5.2s.png", mediaTime: [shotStart, shotEnd], note: "Visual check of the highlight is by viewing the PNG; the check above only proves timing and stage state." });

    // Observer with the stage, then a 100 ms backward seek while paused.
    const observer = await s.tab("tab-B");
    await waitFor(() => view(observer), (v) => v?.role === "observer" && v.program !== null, 15000);
    await clickLabel(observer, "打开 Claudio 口播与歌词面板");
    await clickLabel(owner, "暂停歌曲");
    await waitFor(() => view(owner), (v) => v.transport === "paused", 5000);
    const shown = (tab) => tab.page.evaluate(() => window.__claudioStage?.diagnostics()?.shownLyricSec ?? null);
    await owner.page.evaluate(() => window.__claudioPlayback.seek(8050));
    const atLine2 = await waitFor(async () => ({ owner: await shown(owner), observer: await shown(observer) }), (r) => r.owner > 8.0 && r.observer > 8.0, 8000);
    const epochBefore = (await view(observer)).deck?.seekEpoch;
    await owner.page.evaluate(() => window.__claudioPlayback.seek(7950));
    const back = await waitFor(async () => ({ owner: await shown(owner), observer: await shown(observer), epoch: (await view(observer)).deck?.seekEpoch }), (r) => r.owner !== null && r.owner < 8.0 && r.observer !== null && r.observer < 8.0, 8000);
    // A hidden document paints nothing (the stage hides its canvas then): look at it in front.
    await observer.page.bringToFront();
    await delay(800);
    await observer.page.screenshot({ path: path.join(s.dir, "observer-after-100ms-back-seek.png") });
    const observerStage = await observer.page.evaluate(() => ({ state: window.__claudioStage?.state() ?? null, diagnostics: window.__claudioStage?.diagnostics() ?? null, visible: document.visibilityState }));
    s.check("observer in front: its stage draws the earlier line (renderer ready, no status)", observerStage.state?.drawing === true && observerStage.diagnostics?.status === null && observerStage.diagnostics?.shownLyricSec < 8.0, { state: observerStage.state, status: observerStage.diagnostics?.status, shownLyricSec: observerStage.diagnostics?.shownLyricSec, visible: observerStage.visible });
    s.check("paused 100 ms backward seek (8.05→7.95 s): owner and observer stages both re-anchor to the earlier line via the core seekEpoch", atLine2.ok && back.ok && back.last.epoch > epochBefore, { atLine2: atLine2.last, back: back.last, epochBefore });
  },

  /** Two quick skips: the middle item never starts. */
  async "rapid-next"(s) {
    await s.start();
    const tab = await s.tab("tab-A");
    await s.executor(tab);
    await playViaChat(s, tab, "A");
    await queueViaChat(tab, "C");
    await queueViaChat(tab, "B");
    const lined = await view(tab);
    const [first, second] = lined.queue;
    // Two presses within one task (a double click): the first target never gets to play.
    await tab.page.bringToFront();
    await tab.page.evaluate(() => {
      const next = document.querySelector('button[aria-label="下一首"]');
      next.click();
      next.click();
    });
    const landed = await waitFor(() => view(tab), (v) => v.program?.itemId === second.itemId && v.program.started && v.transport === "playing", 20000);
    await delay(1500);
    const state = await serverState(s, second.itemId);
    const playingNow = (await nativeMedia(tab)).filter((element) => !element.paused);
    s.check("two quick Next: the second queued item plays, the skipped one never started, only one element plays", landed.ok && startedFor(state, first.itemId).length === 0 && startedFor(state, second.itemId).length === 1 && playingNow.length === 1, { queue: lined.queue, program: landed.last?.program, started: state.started.map((fact) => fact.itemId), playingNow });

    // Previous replays the last started track (A) as a new occurrence; a second press does not bounce back.
    await s.phase("previous");
    const aItem = state.started.find((fact) => fact.track.mediaId === "A")?.itemId;
    await clickLabel(tab, "上一首");
    const back = await waitFor(() => view(tab), (v) => v.program?.mediaId === "A" && v.program.itemId !== aItem && v.program.started && v.transport === "playing", 15000);
    const previousDisabled = await tab.page.$eval('button[aria-label="上一首"]', (button) => button.disabled);
    const afterBack = await serverState(s, back.last?.program?.itemId);
    s.check("上一首 replays A as a new started occurrence; nothing earlier remains, so the button is disabled (no A/C bounce)", back.ok && startedFor(afterBack, back.last.program.itemId).length === 1 && startedFor(afterBack, first.itemId).length === 0 && previousDisabled, { program: back.last?.program, previousDisabled, started: afterBack.started.map((fact) => `${fact.track.mediaId}:${fact.itemId}`) });
  },

  /** A queued track whose source cannot be resolved is skipped without a fake start; the next one plays. */
  async "source-failure"(s) {
    await s.start({ config: { tracks: { B: { resolveError: "unavailable" } } } });
    const tab = await s.tab("tab-A");
    await s.executor(tab);
    const a = await playViaChat(s, tab, "A");
    await queueViaChat(tab, "C");
    const b = await queueViaChat(tab, "B");
    await clickLabel(tab, "下一首");
    const landed = await waitFor(() => view(tab), (v) => v.program?.mediaId === "C" && v.program.started && v.transport === "playing", 25000);
    const state = await serverState(s, landed.last?.program?.itemId);
    const resolveTried = state.counters.sourceResolve;
    s.check("B (source unavailable) never started; C plays next; A had started once", landed.ok && startedFor(state, b.itemId).length === 0 && startedFor(state, a.program.itemId).length === 1, { program: landed.last?.program, history: landed.last?.history, started: state.started.map((fact) => fact.track.mediaId), resolveTried });
    s.check("B is recorded in history as failed/skipped, not played", (landed.last?.history ?? []).some((entry) => entry.itemId === b.itemId && entry.outcome !== "played" && !entry.started), landed.last?.history);
  },

  /** TTS fails: A plays to its end, B follows without any voice. */
  async "voice-failure"(s) {
    await s.start({ config: { ttsFail: true } });
    const tab = await s.tab("tab-A");
    await s.executor(tab);
    const a = await playViaChat(s, tab, "A");
    const b = await queueViaChat(tab, "B");
    await seekSlider(tab, 9);
    const seen = [];
    const landed = await waitFor(async () => {
      const v = await view(tab);
      if (v.voice) seen.push(v.voice.status);
      return v;
    }, (v) => v.program?.itemId === b.itemId && v.program.started && v.transport === "playing", 30000, 100);
    const state = await serverState(s, b.itemId);
    const aHistory = landed.last?.history.find((entry) => entry.itemId === a.program.itemId);
    s.check("voice failure: no voice ever spoke, A ended as played, B started", landed.ok && !seen.includes("speaking") && aHistory?.outcome === "played" && startedFor(state, b.itemId).length === 1, { seen: [...new Set(seen)], aHistory, ttsCalls: state.counters.tts });
  },

  /** TTS held past A's end: B starts without voice; the cue released later never speaks. */
  async "late-cue"(s) {
    await s.start({ config: { ttsHold: true } });
    const tab = await s.tab("tab-A");
    await s.executor(tab);
    await playViaChat(s, tab, "A");
    const b = await queueViaChat(tab, "B");
    await seekSlider(tab, 10);
    const landed = await waitFor(() => view(tab), (v) => v.program?.itemId === b.itemId && v.program.started && v.transport === "playing", 30000);
    await s.fixture.api("POST", "/__fixture/release", { stage: "all" });
    const seen = [];
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const v = await view(tab);
      if (v.voice) seen.push(v.voice.status);
      await delay(100);
    }
    const final = await view(tab);
    const media = (await nativeMedia(tab)).filter((element) => !element.paused);
    s.check("late cue released after B started never speaks; B keeps playing alone", landed.ok && !seen.includes("speaking") && final.program.itemId === b.itemId && final.display?.kind === "music" && media.length === 1, { seen: [...new Set(seen)], media });
  },

  /** Changed provider bytes: a new occurrence resolves a new revision; lyrics and started bind to it. */
  async "new-source"(s) {
    await s.start();
    const tab = await s.tab("tab-A");
    await s.executor(tab);
    const first = await playViaChat(s, tab, "A");
    await s.fixture.api("POST", "/__fixture/replace-track", { mediaId: "A", seed: 77 });
    const again = await queueViaChat(tab, "A");
    await clickLabel(tab, "下一首");
    const second = await waitFor(() => view(tab), (v) => v.program?.itemId === again.itemId && v.program.started && v.display?.lyrics === "available", 20000);
    const state = await serverState(s, again.itemId);
    const facts = state.started.filter((fact) => fact.track.mediaId === "A");
    s.check("new bytes → new source revision for the new occurrence; lyrics and started bind to it, the first keeps its own", second.ok && second.last.program.revision !== first.program.revision && second.last.display.lyricsRevision === second.last.program.revision && facts.length === 2 && facts.some((fact) => fact.sourceRevision === first.program.revision) && facts.some((fact) => fact.sourceRevision === second.last.program.revision), { first: first.program.revision, second: second.last?.program?.revision, lyrics: second.last?.display?.lyricsRevision, facts: facts.map((fact) => fact.sourceRevision) });
  },

  /** Clicking existing queue rows selects that very occurrence: preheated media reused, nothing else dropped. */
  async "queue-select"(s) {
    await s.start();
    const tab = await s.tab("tab-A");
    await s.executor(tab);
    await chat(tab, "歌单");
    const loaded = await waitFor(() => view(tab), (v) => v.transport === "idle" && v.queue.map((entry) => entry.mediaId).join(",") === "A,B,C", 15000);
    if (!loaded.ok) throw new Error(`playlist not loaded: ${JSON.stringify(loaded.last)}`);
    const [a, b, c] = loaded.last.queue;
    const row = async (title) => {
      await tab.page.bringToFront();
      const handle = await tab.page.evaluateHandle((wanted) => [...document.querySelectorAll(".playlist-track")].find((button) => button.querySelector("strong")?.textContent === wanted) ?? null, title);
      const element = handle.asElement();
      if (!element) throw new Error(`no queue row ${title}`);
      return element;
    };
    const prepares = async (itemId) => (await s.requests()).filter((entry) => entry.method === "POST" && /^\/api\/v1\/playback\/(prepare|resolve)$/.test(entry.path) && entry.body?.itemId === itemId).map((entry) => entry.path);
    const decks = () => tab.page.evaluate(() => Object.values(window.__claudioPlayback.view().snapshot.decks).map((deck) => ({ deck: deck.deck, role: deck.role, status: deck.status, itemId: deck.itemId, loadId: deck.loadId })));

    // Idle restored head: clicking it plays that item (no replace).
    await (await row("灯亮之前")).click();
    const aPlaying = await waitFor(() => view(tab), (v) => v.transport === "playing" && v.program?.started, 15000);
    s.check("idle head row: plays that same occurrence (itemId and origin kept), B and C stay queued", aPlaying.ok && aPlaying.last.program.itemId === a.itemId && aPlaying.last.queue.slice(0, 2).map((entry) => entry.itemId).join(",") === `${b.itemId},${c.itemId}`, { program: aPlaying.last?.program, queue: aPlaying.last?.queue });

    // Wait until B is preheated on the standby deck, then click B's row.
    const preheated = await waitFor(decks, (list) => list.some((deck) => deck.itemId === b.itemId && deck.loadId && deck.status !== "idle" && deck.status !== "loading"), 15000);
    const bDeck = preheated.last?.find((deck) => deck.itemId === b.itemId) ?? null;
    const preparesBefore = await prepares(b.itemId);
    const mediaBefore = (await nativeMedia(tab)).filter((element) => element.src.includes(STREAM)).map((element) => `${element.id}|${element.src}`);
    await s.phase("select-b");
    await (await row("下一段风景")).click();
    const bPlaying = await waitFor(() => view(tab), (v) => v.program?.itemId === b.itemId && v.program.started && v.transport === "playing", 15000);
    await delay(800);
    const after = await view(tab);
    const preparesAfter = await prepares(b.itemId);
    const playingNow = (await nativeMedia(tab)).filter((element) => element.src.includes(STREAM) && !element.paused).map((element) => `${element.id}|${element.src}`);
    s.check(
      "B row: the preheated B is promoted as is — same itemId/origin, same loadId (no new load), still exactly one prepare and no resolve",
      preheated.ok && bPlaying.ok && after.program.loadId === bDeck.loadId && after.program.deck === bDeck.deck && preparesBefore.length === 1 && preparesAfter.length === 1 && preparesAfter[0] === "/api/v1/playback/prepare",
      { bDeck, program: after.program, preparesBefore, preparesAfter }
    );
    s.check("the playing element is the one B was preheated in (same element and src, no new media load)", playingNow.length === 1 && mediaBefore.includes(playingNow[0]), { mediaBefore, playingNow });
    const programOrigin = await tab.page.evaluate(() => window.__claudioPlayback.view().snapshot.program.item.origin);
    s.check(
      "nothing else dropped: C still queued under its itemId, A recorded as skipped, B keeps its origin",
      after.queue.some((entry) => entry.itemId === c.itemId) && after.history.some((entry) => entry.itemId === a.itemId && entry.outcome === "skipped") && after.queue.every((entry) => entry.itemId !== b.itemId) && b.origin === programOrigin,
      { queue: after.queue, history: after.history, origin: [b.origin, programOrigin] }
    );
    const state = await serverState(s, b.itemId);
    s.check("started is recorded under B's kept itemId exactly once", startedFor(state, b.itemId).length === 1, state.started.map((fact) => fact.itemId));
    await tab.capture("01-b-selected");

    // A played row replays as a new occurrence (history is never re-entered).
    await s.phase("replay-history");
    await (await row("灯亮之前")).click();
    const replayed = await waitFor(() => view(tab), (v) => v.program?.mediaId === "A" && v.program.itemId !== a.itemId && v.program.started, 15000);
    s.check("a played row replays as a new occurrence; C is still queued", replayed.ok && replayed.last.queue.some((entry) => entry.itemId === c.itemId), { program: replayed.last?.program, queue: replayed.last?.queue });
  },

  /** Voice duration the server cannot measure: no estimated timing; the caption shows the whole script, unlabelled as timed. */
  async "dj-plain"(s) {
    await s.start({ config: { voiceFormat: "ogg-labelled-wav", voiceDurationMs: 4000 } });
    const tab = await s.tab("tab-A");
    await s.executor(tab);
    const a = await playViaChat(s, tab, "A");
    const b = await queueViaChat(tab, "B");
    await seekSlider(tab, 7);
    const dj = await waitFor(() => view(tab), (v) => v.voice?.origin === "transition" && v.voice.status === "speaking" && v.transition?.from === a.program.itemId && v.transition.to === b.itemId && v.display?.kind === "voice", 25000, 80);
    const reads = [];
    let talk = null;
    let panel = null;
    if (dj.ok) {
      talk = await sequentialTalk(s, tab, a.program.itemId, b.itemId);
      for (let index = 0; index < 4; index += 1) {
        const read = await djCaption(tab);
        if (read.voiceStatus !== "speaking") break;
        reads.push(read);
        await delay(300);
      }
      await tab.capture("01-dj-plain-caption");
      await clickLabel(tab, "打开 Claudio 口播与歌词面板");
      await tab.page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      panel = { ...(await panelLabels(tab)), voiceStatus: (await view(tab)).voice?.status ?? null };
      await tab.capture("02-dj-plain-panel");
      await clickLabel(tab, "关闭面板");
    }
    if (!dj.ok) s.notes.push({ last: dj.last, log: await tab.page.evaluate(() => window.__claudioPlayback.log().slice(-40)) });
    const f = talk?.facts ?? {};
    const asset = talk?.evidence.asset ?? null;
    const voiceRequests = asset ? (await s.requests()).filter((row) => row.method === "GET" && row.path === new URL(asset.handle, "http://x").pathname) : [];
    s.check(
      "unknown voice duration: the strict A→B cue still plays from the native element holding its voice handle (fetched from the server under that handle), and the core keeps plain text",
      dj.ok && f.voiceCue && f.identity && f.voiceElement && f.assetIsCue && voiceRequests.length >= 1 && reads.length >= 2 && reads.every((read) => read.subtitle?.timing === "plain-text"),
      { ...(talk?.evidence ?? {}), voiceStreamRequests: voiceRequests.map((row) => ({ seq: row.seq, status: row.status, range: row.range })), timing: reads.map((read) => read.subtitle?.timing) }
    );
    s.check("same reads: A's element has ended, B silent with no receipt/started; the script names B by its catalog title and is the writer's A→B text", dj.ok && f.aEnded && f.bSilent && f.namesB, talk && { facts: f, aElements: talk.evidence.aElements, bElements: talk.evidence.bElements, bTitle: talk.evidence.bTitle, script: talk.evidence.cue?.script });
    s.check(
      "the caption shows the whole script on one truncated line (full text in its title), with no estimate badge, never just the first sentence",
      reads.length >= 2 && reads.every((read) => read.whole && read.text === read.script.trim() && read.title === read.script.trim() && read.badge === null && read.timing === "plain-text"),
      reads.map(({ text, title, whole, badge, timing }) => ({ text, title, whole, badge, timing }))
    );
    s.check("panel during the plain DJ: LyricsPanel says 全文, transcript lines say Claudio · 全文", panel !== null && panel.lyricsHead === "Claudio 正在串场 · 全文" && panel.transcriptTiming === "plain-text" && panel.transcript.length >= 1 && panel.transcript.every((label) => label === "Claudio · 全文"), panel);
    const bPlaying = await waitFor(() => view(tab), (v) => v.program?.itemId === b.itemId && v.program.started, 30000);
    s.check("B follows the plain-text DJ", bPlaying.ok, bPlaying.last?.program);
  },

  /**
   * Refresh while the DJ talks between an A that ended by itself and B
   * (sequential A→DJ→B). A is finished; the listener's unfinished queue is B, C.
   * After the reload nothing sounds and no voice comes back; only 播放 starts B,
   * as a new occurrence, and A is not played again.
   */
  async "refresh-during-talk"(s) {
    // A 20 s voice: the talk is surely still on when the page reloads.
    await s.start({ config: { voiceDurationMs: 20000 } });
    const tab = await s.tab("tab-A");
    await s.executor(tab);
    await chat(tab, "歌单");
    const loaded = await waitFor(() => view(tab), (v) => v.transport === "idle" && v.queue.map((entry) => entry.mediaId).join(",") === "A,B,C", 15000);
    if (!loaded.ok) throw new Error(`playlist not loaded: ${JSON.stringify(loaded.last)}`);
    const [a, b, c] = loaded.last.queue;
    await clickLabel(tab, "播放");
    const aPlaying = await waitFor(() => view(tab), (v) => v.transport === "playing" && v.program?.itemId === a.itemId && v.program.started, 20000);
    if (!aPlaying.ok) throw new Error(`A did not play: ${JSON.stringify(aPlaying.last)}`);

    // A runs out by itself (no skip), then the transition voice talks before B.
    await s.phase("a-ends-dj-talks");
    await seekSlider(tab, 12);
    const dj = await waitFor(() => view(tab), (v) => v.voice?.origin === "transition" && v.voice.status === "speaking" && v.transition?.from === a.itemId && v.transition.to === b.itemId && v.transition.phase === "talking", 25000, 80);
    const talk = dj.ok ? await sequentialTalk(s, tab, a.itemId, b.itemId) : null;
    const f = talk?.facts ?? {};
    await delay(400);
    await tab.capture("01-talking-before-refresh");
    const stored = await tab.page.evaluate(() => JSON.parse(localStorage.getItem("claudio.playback.queue.v1") ?? "null"));
    const atReload = await view(tab);
    s.check(
      "before the refresh, strict sequential talk: A's element ended, the A→B voice handle's element plays and advances, B silent with no receipt/started — and the reload happens while that voice is still on",
      dj.ok && f.voiceCue && f.identity && f.voiceElement && f.assetIsCue && f.aEnded && f.bSilent && ["starting", "speaking"].includes(atReload.voice?.status) && atReload.transition?.phase === "talking" && atReload.program?.itemId === a.itemId,
      { ...(talk?.evidence ?? { last: dj.last }), atReload: { voice: atReload.voice, transition: atReload.transition, program: atReload.program }, storedQueue: stored?.entries?.map((entry) => `${entry.track.mediaId}:${entry.origin}`) ?? null }
    );

    await s.phase("refresh");
    const before = await s.state();
    await tab.page.reload({ waitUntil: "domcontentloaded" });
    await s.executor(tab);
    // Sampled for 3 s: no element plays and no voice comes back by itself.
    const samples = [];
    const quietEnd = Date.now() + 3000;
    while (Date.now() < quietEnd) {
      const m = await moment(tab);
      samples.push({ transport: m.snapshot?.transport ?? null, program: m.snapshot?.program?.item.track.mediaId ?? null, voice: m.snapshot?.voice?.status ?? null, queue: (m.snapshot?.queue ?? []).map((entry) => entry.item.track.mediaId), playing: m.media.filter((element) => !element.paused).map((element) => element.src) });
      await delay(250);
    }
    const restored = await moment(tab);
    const restoredQueue = restored.snapshot.queue.map((entry) => ({ itemId: entry.item.itemId, mediaId: entry.item.track.mediaId, origin: entry.item.origin }));
    const notice = await tab.page.evaluate(() => document.body.innerText.includes("已恢复上次的队列，按播放继续"));
    const afterReload = await s.state();
    await tab.capture("02-restored-after-refresh");
    const heads = restoredQueue.map((entry) => entry.mediaId);
    s.check(
      "after the refresh the unfinished queue is restored from B: the whole queue is exactly [B, C], the ended A nowhere in it, nothing is the program",
      restored.snapshot.transport === "idle" && restored.snapshot.program === null && heads.length === 2 && heads[0] === "B" && heads[1] === "C" && !heads.includes("A"),
      { restoredQueue, before: { a: a.itemId, b: b.itemId, c: c.itemId }, storedBeforeRefresh: stored?.entries?.map((entry) => `${entry.track.mediaId}:${entry.origin}`) ?? null }
    );
    s.check(
      "nothing plays by itself after the refresh: idle, no voice, no playing element for 3 s, no new started; the listener is told",
      samples.every((sample) => sample.transport === "idle" && sample.voice === null && sample.playing.length === 0) && afterReload.started.length === before.started.length && notice,
      { samples: samples.filter((_, index) => index % 4 === 0), started: afterReload.started.length, notice }
    );

    await s.phase("play-after-refresh");
    await clickLabel(tab, "播放");
    const played = await waitFor(() => view(tab), (v) => v.transport === "playing" && v.program?.started, 20000);
    const p1 = await moment(tab);
    await delay(800);
    const p2 = await moment(tab);
    const program = played.last?.program ?? null;
    const final = await serverState(s, program?.itemId);
    const requests = await s.requests();
    const bindings = streamBindings(requests);
    const own = bindings.music.filter((entry) => entry.itemId === program?.itemId);
    const moving = progressing(p1, p2).filter((element) => own.some((entry) => sameStream(element.src, entry.handle)));
    const aSourcesAfter = bindings.music.filter((entry) => entry.mediaId === "A" && entry.seq > before.requestCount);
    const startedA = final.started.filter((fact) => fact.track.mediaId === "A");
    s.check(
      "播放 after the refresh starts B as a new occurrence: confirmed started once under its new itemId, its own element advancing",
      played.ok && program?.mediaId === "B" && program.itemId !== b.itemId && startedFor(final, program.itemId).length === 1 && moving.length === 1,
      { program, moving, started: final.started.map((fact) => `${fact.track.mediaId}:${fact.itemId}`) }
    );
    s.check(
      "A is not played again: no A source handed out after the refresh, A's only started fact is the first one, the old B occurrence never started",
      aSourcesAfter.length === 0 && startedA.length === 1 && startedA[0].itemId === a.itemId && startedFor(final, b.itemId).length === 0,
      { aSourcesAfter, startedA: startedA.map((fact) => fact.itemId), originalA: a.itemId }
    );
    await tab.capture("03-after-play");
  },

  /**
   * Old-queue import across write boundaries, in the real page and its real
   * localStorage. Storage states left by an interrupted import are seeded:
   * after the backup write (before the commit), and after the commit (before
   * the mark copy). Each new page load must import exactly once.
   */
  async migration(s) {
    await s.start();
    const legacy = JSON.stringify([{ songId: "B", djLine: "旧版串词" }, { songId: "C" }, { songId: "B" }]);
    const playlist = JSON.stringify({ playlistId: "old", picks: [] });
    const entry = (mediaId, origin) => ({ track: { providerId: "fixture", mediaId }, display: { title: mediaId, artist: "旧队列" }, origin });
    const seededTab = async (label, seed) => {
      s.context = await s.browser.createBrowserContext();
      return s.tab(label, {
        beforeLoad: {
          fn: (items) => {
            if (localStorage.getItem("claudio.e2e.seeded")) return;
            localStorage.setItem("claudio.e2e.seeded", "1");
            for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
          },
          arg: seed
        }
      });
    };
    const storage = (tab) => tab.page.evaluate(() => {
      const raw = localStorage.getItem("claudio.playback.queue.v1");
      const parsed = raw ? JSON.parse(raw) : null;
      return { queue: parsed?.entries?.map((entry) => `${entry.track.mediaId}:${entry.origin}`) ?? null, stamp: parsed?.legacyImport ?? null, mark: localStorage.getItem("claudio.legacy.import.v1"), old: localStorage.getItem("claudio.radioQueue"), backup: localStorage.getItem("claudio.legacy.backup.v1") };
    });
    const importLog = (tab) => tab.page.evaluate(() => window.__claudioPlayback.log().filter((entry) => entry.event === "legacy.import").map((entry) => entry.data));
    const queueOf = (v) => v.queue.map((item) => `${item.mediaId}:${item.origin}`).join(",");
    const backup = JSON.stringify({ version: 1, savedAt: "2026-10-16T00:00:00.000Z", keys: { "claudio.activePlaylist": playlist, "claudio.radioQueue": legacy } });

    // 1. Interrupted after the backup write, before the commit; a newer queue (radio A) already exists.
    const one = await seededTab("crash-before-commit", {
      "claudio.radioQueue": legacy,
      "claudio.activePlaylist": playlist,
      "claudio.legacy.backup.v1": backup,
      "claudio.playback.queue.v1": JSON.stringify({ version: 1, entries: [entry("A", "radio")] })
    });
    const first = await s.executor(one);
    const firstStorage = await storage(one);
    s.check(
      "interrupted before the commit: the next start imports every old entry once, after the newer queue, repeats kept",
      // Restored entries all come back as origin "restore"; the order shows the newer queue first.
      queueOf(first) === "A:restore,B:restore,C:restore,B:restore" && (await importLog(one)).at(-1)?.status === "imported" && firstStorage.stamp?.status === "complete" && JSON.parse(firstStorage.mark ?? "{}").status === "complete",
      { queue: first.queue, log: await importLog(one), stamp: firstStorage.stamp }
    );
    s.check("old keys untouched; the backup holds the original raw values", firstStorage.old === legacy && JSON.parse(firstStorage.backup).keys["claudio.radioQueue"] === legacy, { backup: firstStorage.backup?.slice(0, 160) });

    // Runtime saves keep the stamp; with the mark copy gone a reload still does not import again.
    await clickLabel(one, "播放");
    await waitFor(() => view(one), (v) => v.transport === "playing" && v.program?.started, 15000);
    await clickLabel(one, "下一首");
    await waitFor(() => view(one), (v) => v.program?.mediaId === "B" && v.program.started, 15000);
    await clickLabel(one, "暂停");
    await waitFor(() => view(one), (v) => v.transport === "paused", 5000);
    const saved = await storage(one);
    await one.page.evaluate(() => localStorage.removeItem("claudio.legacy.import.v1"));
    await one.page.reload({ waitUntil: "domcontentloaded" });
    const reloaded = await s.executor(one);
    const reloadedStorage = await storage(one);
    s.check(
      "after runtime queue saves and a lost mark copy, a reload does not import again (the stamp travels with the queue)",
      saved.stamp?.status === "complete" && reloadedStorage.stamp?.status === "complete" && (await importLog(one)).at(-1)?.reason === "already-imported" && reloaded.queue.filter((item) => item.origin === "restore").length === saved.queue.filter((item) => item.endsWith(":restore")).length,
      { saved, reloaded: reloaded.queue, log: await importLog(one) }
    );
    await one.page.close();

    // 2. Interrupted after the commit, before the mark copy: nothing is imported twice.
    const committed = [entry("B", "restore"), entry("C", "restore"), entry("B", "restore")];
    const two = await seededTab("crash-after-commit", {
      "claudio.radioQueue": legacy,
      "claudio.activePlaylist": playlist,
      "claudio.legacy.backup.v1": backup,
      "claudio.playback.queue.v1": JSON.stringify({ version: 1, entries: committed, legacyImport: { version: 3, status: "complete", importedAt: "2026-10-16T00:00:00.000Z", imported: 3, skipped: [] } })
    });
    const second = await s.executor(two);
    s.check("interrupted after the commit: the next start sees the stamp and imports nothing more", queueOf(second) === "B:restore,C:restore,B:restore" && (await importLog(two)).at(-1)?.reason === "already-imported", { queue: second.queue, log: await importLog(two) });
  }
};

const summary = { startedAt: new Date().toISOString(), outRoot, scenarios: [] };
for (const name of selected) {
  console.log(`scenario ${name}`);
  const s = new Scenario(name);
  let error = null;
  try {
    await scenarios[name](s);
  } catch (caught) {
    error = caught;
    console.log(`  ERROR ${caught?.message ?? caught}`);
    for (const tab of s.tabs) await tab.capture("error").catch(() => {});
  }
  const result = await s.finish(error);
  summary.scenarios.push({ name, passed: result.passed, checks: result.checks.length, failed: result.checks.filter((check) => !check.passed).map((check) => check.name), error: result.error ?? null, runDir: result.fixture?.runDir ?? null });
}
summary.finishedAt = new Date().toISOString();
summary.passed = summary.scenarios.every((scenario) => scenario.passed);
fs.writeFileSync(path.join(outRoot, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed ? "ALL PASSED" : "FAILED"}: ${summary.scenarios.map((scenario) => `${scenario.name}=${scenario.passed ? "pass" : "FAIL"}`).join(" ")}`);
console.log(`evidence: ${outRoot}`);
process.exitCode = summary.passed ? 0 : 1;
