#!/usr/bin/env node
// Browser suite for @claudio/playback-web: real Chromium, the real core and
// browser driver, fixture ports, post-master PCM evidence.
//
//   node packages/playback-web/e2e/run.mjs [--suite foreground|background|all]
//        [--only name,name] [--out dir] [--chrome path]
//
// Env: CLAUDIO_CHROME (executable), CLAUDIO_CHROME_LIB_DIR (extra shared libs),
// CLAUDIO_E2E_PACKAGES_FROM (optional dir containing contracts/ and
// playback-core/ sources to test against instead of the workspace copies).
//
// Evidence per scenario: events JSON (commands/facts/effects/notes with
// performance and AudioContext time), PCM WAV of the master bus, screenshots.
// PCM is the graph output inside the browser, not a loudspeaker recording.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build, defaultClientConditions } from "vite";
import { AUTOPLAY_FLAG, BACKGROUND_OVERRIDES, launchBrowser, resolveChrome } from "./tools/browser.mjs";
import { generateFixtures } from "./tools/fixtures.mjs";
import { startFixtureServer } from "./tools/fixture-server.mjs";
import { analyzePcm, decodeCapture, writeWav } from "./tools/pcm.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    suite: { type: "string", default: "all" },
    only: { type: "string" },
    out: { type: "string" },
    chrome: { type: "string" }
  }
});
const outDir = resolve(args.out ?? join(here, ".results", new Date().toISOString().replace(/[:.]/g, "-")));
const only = args.only ? new Set(args.only.split(",")) : null;

const CATALOG = {
  a12: { file: "a12.wav", durationMs: 12_000, lyrics: "A: plain-text lyrics (no timing)" },
  b12: { file: "b12.wav", durationMs: 12_000, lyrics: "B: plain-text lyrics (no timing)" },
  c12: { file: "c12.wav", durationMs: 12_000 },
  a3: { file: "a3.wav", durationMs: 3_000 },
  a6: { file: "a6.wav", durationMs: 6_000 },
  missing: { missing: true, durationMs: 12_000 }
};
const CROSSFADE = { preferredTalkMode: "talk-over-crossfade", crossfadeLeadMs: 4_000, fadeMs: 600, resumeRampMs: 150, duckGain: 0.3, underVoiceGain: 0.3 };
const entry = (mediaId) => ({ track: { providerId: "fixture", mediaId }, display: { title: mediaId, artist: "fixture" }, origin: "user" });
const enqueue = (...ids) => ({ type: "enqueue", position: "end", entries: ids.map(entry) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ page helper

class TestPage {
  constructor(page, name, scenarioDir) {
    this.page = page;
    this.name = name;
    this.dir = scenarioDir;
    this.errors = [];
    page.on("pageerror", (error) => this.errors.push(String(error)));
    // Resource failures are judged by URL below (the /missing/ route 404s on purpose); other console errors count.
    page.on("console", (msg) => msg.type() === "error" && !msg.text().startsWith("Failed to load resource") && this.errors.push(`console: ${msg.text()}`));
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (response.status() >= 400 && !url.pathname.startsWith("/missing/")) this.errors.push(`HTTP ${response.status()} ${url.pathname}`);
    });
  }
  boot(options) {
    return this.page.evaluate((o) => window.e2e.boot(o), options);
  }
  async click(commands = []) {
    await this.page.evaluate((c) => window.e2e.armGesture(c), commands);
    // A real click needs the tab in front (hidden tabs run no rAF, which the click helper waits on).
    await this.page.bringToFront();
    await this.page.click("#go");
  }
  dispatch(command) {
    return this.page.evaluate((c) => window.e2e.dispatch(c), command);
  }
  view() {
    return this.page.evaluate(() => window.e2e.view());
  }
  clock() {
    return this.page.evaluate(() => window.e2e.clock());
  }
  diagnostics() {
    return this.page.evaluate(() => window.e2e.diagnostics());
  }
  events() {
    return this.page.evaluate(() => window.e2e.events());
  }
  release(key, fail) {
    return this.page.evaluate((k, f) => window.e2e.release(k, f), key, fail);
  }
  async waitFor(label, fn, arg, timeout = 15_000) {
    try {
      await this.page.waitForFunction(fn, { timeout, polling: 50 }, arg);
    } catch (error) {
      throw new Error(`[${this.name}] timed out waiting for: ${label} (${String(error).split("\n")[0]})`);
    }
  }
  waitTransport(status, timeout) {
    return this.waitFor(`transport=${status}`, (s) => window.e2e.view()?.snapshot?.transport === s, status, timeout);
  }
  waitProgramPlaying(mediaId, timeout) {
    return this.waitFor(
      `${mediaId} playing as program`,
      (m) => {
        const s = window.e2e.view()?.snapshot;
        return s?.program?.item.track.mediaId === m && s.transport === "playing" && s.decks[s.program.deck]?.status === "playing";
      },
      mediaId,
      timeout
    );
  }
  waitEvent(label, predicateSource, timeout) {
    return this.waitFor(label, (src) => window.e2e.events().some(new Function("e", `return (${src})`)), predicateSource, timeout);
  }
  async capture(id, seconds) {
    const raw = await this.page.evaluate((i, s) => window.e2e.record(i, s), id, seconds);
    assert.equal(raw.reason, "completed", `capture ${id} ended ${raw.reason} (context ${raw.contextState ?? "?"})`);
    const record = decodeCapture(raw);
    record.wav = await writeWav(join(this.dir, `${id}.wav`), record);
    return record;
  }
  async screenshot(id) {
    const path = join(this.dir, `${id}.png`);
    await this.page.screenshot({ path });
    return path;
  }
}

// --------------------------------------------------------------- event helpers

const isFact = (e, type, kind, extra = () => true) => e.kind === "fact" && e.data?.type === type && (!kind || e.data.event?.kind === kind) && extra(e.data);
const isEffect = (e, type, extra = () => true) => e.kind === "effect" && e.data?.type === type && extra(e.data);
function find(events, predicate, label) {
  const found = events.find(predicate);
  if (!found) throw new Error(`event not found: ${label}`);
  return found;
}
function findLast(events, predicate, label) {
  const found = events.findLast(predicate);
  if (!found) throw new Error(`event not found: ${label}`);
  return found;
}
/** Analysis window in capture seconds from AudioContext times. */
function windowOf(record, fromCtx, toCtx) {
  return { fromSeconds: Math.max(0, fromCtx - record.startContextTime), toSeconds: toCtx - record.startContextTime };
}
function tones(record, fromCtx, toCtx) {
  return analyzePcm(record, windowOf(record, fromCtx, toCtx));
}
const ratio = (a, b) => (b > 0 ? a / b : Infinity);
/** Media facts that reached the runtime for a load after the core unloaded it (must be none). */
function factsAfterUnload(events) {
  const unloadedAt = new Map();
  const leaks = [];
  events.forEach((e, index) => {
    if (isEffect(e, "deck.unload")) unloadedAt.set(e.data.loadId, index);
    if (e.kind === "fact" && e.data?.type === "deck.media" && unloadedAt.has(e.data.loadId) && unloadedAt.get(e.data.loadId) < index) leaks.push(e.data);
  });
  return leaks;
}

function loadOf(events, mediaId) {
  return find(events, (e) => isEffect(e, "deck.load", (d) => d.media.track.mediaId === mediaId), `deck.load ${mediaId}`).data;
}

// ------------------------------------------------------------------- scenarios

const scenarios = {
  async "sequential-talk"(t) {
    await t.boot({ catalog: CATALOG, djEnabled: true, cue: { voiceDurationMs: null, text: "That was A; next up is B." } });
    await t.dispatch(enqueue("a3", "b12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a3");
    await t.waitFor("cue ready", () => window.e2e.view()?.snapshot?.voice?.status === "ready");
    const capturing = t.capture("sequential-a-voice-b", 6.5);
    await t.waitFor("voice speaking", () => window.e2e.view()?.snapshot?.display.kind === "voice", undefined, 8_000);
    const voiceShot = await t.screenshot("during-voice");
    await t.waitProgramPlaying("b12", 10_000);
    const record = await capturing;
    const events = await t.events();
    const A = loadOf(events, "a3");
    const B = loadOf(events, "b12");
    const aEndIndex = events.findIndex((e) => isFact(e, "deck.media", "ended", (d) => d.loadId === A.loadId));
    const aPausedIndex = events.findIndex((e) => isFact(e, "deck.media", "paused", (d) => d.loadId === A.loadId && d.event.atEnd === true));
    assert.ok(aPausedIndex >= 0 && aEndIndex > aPausedIndex, "browser reported pause(atEnd=true) before ended for A");
    const aEnded = events[aEndIndex];
    const voicePlaying = find(events, (e) => isFact(e, "voice.media", "playing"), "voice playing");
    const voiceEnded = find(events, (e) => isFact(e, "voice.media", "ended"), "voice ended");
    const bPlaying = find(events, (e) => isFact(e, "deck.media", "playing", (d) => d.loadId === B.loadId), "B playing");
    assert.ok(aEnded.t < voicePlaying.t && voiceEnded.t < bPlaying.t, "order A end → voice → B");
    const aWin = tones(record, record.startContextTime + 0.05, aEnded.ctx - 0.15);
    const vWin = tones(record, voicePlaying.ctx + 0.1, voiceEnded.ctx - 0.1);
    const bWin = tones(record, bPlaying.ctx + 0.15, record.startContextTime + record.frames / record.sampleRate - 0.05);
    assert.ok(aWin.amplitude[440] > 0.17 && aWin.amplitude[880] < 0.005, `A window ${JSON.stringify(aWin.amplitude)}`);
    assert.ok(vWin.amplitude[880] > 0.08 && vWin.amplitude[440] < 0.005 && vWin.amplitude[660] < 0.005, `voice window ${JSON.stringify(vWin.amplitude)}`);
    assert.ok(bWin.amplitude[660] > 0.17 && bWin.amplitude[880] < 0.005 && bWin.amplitude[440] < 0.005, `B window ${JSON.stringify(bWin.amplitude)}`);
    const view = await t.view();
    const keys = (await t.page.evaluate(() => window.e2e.receipts())).map((r) => r.idempotencyKey);
    assert.equal(new Set(keys).size, 2, "one started receipt per item");
    assert.equal(view.snapshot.display.kind, "music");
    return {
      gapsMs: { aEndToVoicePlaying: voicePlaying.t - aEnded.t, voiceEndToBPlaying: bPlaying.t - voiceEnded.t },
      windows: { a: aWin, voice: vWin, b: bWin },
      wav: record.wav,
      screenshots: [voiceShot, await t.screenshot("after-b")]
    };
  },

  async "crossfade-with-voice"(t) {
    await t.boot({ catalog: CATALOG, djEnabled: true, coreConfig: CROSSFADE, cue: { voiceDurationMs: 1_800, text: "A line spoken over the crossfade." } });
    await t.dispatch(enqueue("a6", "b12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a6");
    const capturing = t.capture("crossfade-a-b-voice", 6.5);
    await t.waitFor("voice speaking", () => window.e2e.view()?.snapshot?.display.kind === "voice", undefined, 8_000);
    await sleep(500);
    const overlapShot = await t.screenshot("overlap");
    const spectrum = await t.page.evaluate(() => window.e2e.spectrum());
    assert.ok(spectrum.musicBins > 0 && spectrum.musicSum > 0 && spectrum.voiceSum > 0 && spectrum.voiceLevel > 0, `spectrum readable during overlap: ${JSON.stringify(spectrum)}`);
    await t.waitFor("overlap completed", () => {
      const s = window.e2e.view()?.snapshot;
      return s?.program?.item.track.mediaId === "b12" && s.transition === null && s.voice === null;
    }, undefined, 12_000);
    const record = await capturing;
    const events = await t.events();
    const A = loadOf(events, "a6");
    const B = loadOf(events, "b12");
    const bPlay = find(events, (e) => isEffect(e, "deck.play", (d) => d.loadId === B.loadId), "B deck.play (preroll)");
    const voicePlaying = find(events, (e) => isFact(e, "voice.media", "playing"), "voice playing");
    const voiceEnded = find(events, (e) => isFact(e, "voice.media", "ended"), "voice ended");
    const aUnload = find(events, (e) => isEffect(e, "deck.unload", (d) => d.loadId === A.loadId), "A unloaded");
    const before = tones(record, record.startContextTime + 0.05, bPlay.ctx - 0.1);
    const duck = tones(record, voicePlaying.ctx + 0.7, voiceEnded.ctx - 0.05);
    const after = tones(record, voiceEnded.ctx + 0.75, Math.min(aUnload.ctx, record.startContextTime + record.frames / record.sampleRate) - 0.05);
    assert.ok(before.amplitude[440] > 0.17 && before.amplitude[660] < 0.005 && before.amplitude[880] < 0.005, `before ${JSON.stringify(before.amplitude)}`);
    assert.ok(Math.abs(ratio(duck.amplitude[440], 0.2) - 0.3) < 0.05, `A ducked to 0.3: ${duck.amplitude[440]}`);
    assert.ok(Math.abs(ratio(duck.amplitude[660], 0.2) - 0.3) < 0.05, `B under voice at 0.3: ${duck.amplitude[660]}`);
    assert.ok(duck.amplitude[880] > 0.08, `voice audible over both decks: ${duck.amplitude[880]}`);
    assert.ok(after.amplitude[660] > 0.17 && after.amplitude[440] < 0.01 && after.amplitude[880] < 0.005, `after ${JSON.stringify(after.amplitude)}`);
    return { windows: { before, duck, after }, spectrum, wav: record.wav, screenshots: [overlapShot, await t.screenshot("after-overlap")] };
  },

  async "volume-change-during-duck"(t) {
    await t.boot({ catalog: CATALOG, djEnabled: true, coreConfig: CROSSFADE, cue: { voiceDurationMs: 1_800 } });
    await t.dispatch(enqueue("a6", "b12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a6");
    const capturing = t.capture("volume-during-duck", 6.5);
    await t.waitEvent("voice playing", `e.kind === "fact" && e.data.type === "voice.media" && e.data.event.kind === "playing"`, 8_000);
    await sleep(1_000);
    await t.dispatch({ type: "set-volume", channel: "music", value: 0.5 });
    await t.waitFor("overlap completed", () => {
      const s = window.e2e.view()?.snapshot;
      return s?.program?.item.track.mediaId === "b12" && s.transition === null && s.voice === null;
    }, undefined, 12_000);
    const record = await capturing;
    const events = await t.events();
    const voicePlaying = find(events, (e) => isFact(e, "voice.media", "playing"), "voice playing");
    const volume = find(events, (e) => isEffect(e, "output.volume", (d) => d.music === 0.5), "volume effect");
    const voiceEnded = find(events, (e) => isFact(e, "voice.media", "ended"), "voice ended");
    const end = record.startContextTime + record.frames / record.sampleRate;
    // The voice fixture pulses at 6 Hz (sin² of 3 Hz): compare windows of whole pulse periods.
    const PULSES = 2 / 6;
    assert.ok(volume.ctx - 0.02 - (voicePlaying.ctx + 0.62) >= PULSES && voiceEnded.ctx - 0.05 - (volume.ctx + 0.08) >= PULSES, "room for two aligned windows");
    const duckFull = tones(record, volume.ctx - 0.02 - PULSES, volume.ctx - 0.02);
    const duckHalf = tones(record, volume.ctx + 0.08, volume.ctx + 0.08 + PULSES);
    const restored = tones(record, voiceEnded.ctx + 0.75, end - 0.05);
    assert.ok(Math.abs(duckHalf.amplitude[660] / duckFull.amplitude[660] - 0.5) < 0.08, `music halves inside the duck: ${duckFull.amplitude[660]} → ${duckHalf.amplitude[660]}`);
    assert.ok(Math.abs(duckHalf.amplitude[880] / duckFull.amplitude[880] - 1) < 0.15, `voice bus unaffected by the music volume: ${duckFull.amplitude[880]} → ${duckHalf.amplitude[880]}`);
    assert.ok(Math.abs(restored.amplitude[660] - 0.1) < 0.012, `duck release lands on the latest user volume (0.5×0.2): ${restored.amplitude[660]}`);
    return { windows: { duckFull, duckHalf, restored }, wav: record.wav };
  },

  async "rapid-skip-late-source"(t) {
    await t.boot({ catalog: CATALOG, djEnabled: false, prepare: { b12: { hold: true } } });
    await t.dispatch(enqueue("a12", "b12", "c12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a12");
    await t.waitEvent("B prepare requested", `e.kind === "port.prepare" && e.data.mediaId === "b12"`);
    await t.dispatch({ type: "next" });
    await t.dispatch({ type: "next" });
    await t.waitProgramPlaying("c12", 10_000);
    // Churn: queue more and skip through loads while their play() calls are still pending.
    await t.dispatch(enqueue("a12", "c12", "a12", "c12"));
    for (let i = 0; i < 4; i++) await t.dispatch({ type: "next" });
    await t.waitProgramPlaying("c12", 10_000);
    assert.equal(await t.release("prepare:b12"), true);
    await t.waitEvent("late B answer dropped", `e.kind === "operation.late"`, 5_000);
    await sleep(600);
    const record = await t.capture("rapid-skip-c-only", 1.0);
    const pcm = analyzePcm(record);
    const events = await t.events();
    assert.equal(events.filter((e) => isEffect(e, "deck.load", (d) => d.media.track.mediaId === "b12")).length, 0, "B never loaded");
    assert.deepEqual(factsAfterUnload(events), [], "no element event or play() outcome surfaced after its load was unloaded");
    const released = find(events, (e) => e.kind === "port.released" && e.data.key === "b12", "B port released");
    assert.equal(released.data.aborted, true, "B's signal was aborted when the skip cancelled it");
    assert.ok(pcm.amplitude[550] > 0.17 && pcm.amplitude[440] < 0.003 && pcm.amplitude[660] < 0.003, JSON.stringify(pcm.amplitude));
    const view = await t.view();
    assert.equal(view.snapshot.program.item.track.mediaId, "c12");
    const diag = await t.diagnostics();
    assert.ok(diag.driver.liveElements <= 3, "never more than three live media elements");
    return { pcm, wav: record.wav, diagnostics: diag.driver };
  },

  async "pause-resume-seek"(t) {
    await t.boot({ catalog: CATALOG, djEnabled: true, coreConfig: CROSSFADE, cue: { voiceDurationMs: 1_800 } });
    await t.dispatch(enqueue("a6", "b12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a6");
    await t.waitEvent("voice playing", `e.kind === "fact" && e.data.type === "voice.media" && e.data.event.kind === "playing"`, 8_000);
    await sleep(600);
    const mark = (await t.events()).length;
    await t.dispatch({ type: "pause" });
    const immediate = (await t.events()).slice(mark).filter((e) => e.kind === "effect").map((e) => e.data.type);
    assert.ok(immediate.includes("voice.pause") && immediate.filter((x) => x === "deck.pause").length === 2, `pause effects ${immediate}`);
    await sleep(150);
    const frozen1 = await t.clock();
    await sleep(400);
    const frozen2 = await t.clock();
    for (const key of ["A", "B"]) assert.equal(frozen2.decks[key].positionMs, frozen1.decks[key].positionMs, `deck ${key} clock frozen while paused`);
    assert.equal(frozen2.voice.positionMs, frozen1.voice.positionMs, "voice clock frozen while paused");
    assert.ok(frozen2.voice.positionMs > 300, "voice had been speaking");
    const silence = analyzePcm(await t.capture("paused-silence", 0.5));
    assert.ok(silence.rms < 0.002, `silent while paused: ${silence.rms}`);
    const pausedShot = await t.screenshot("paused");
    await t.dispatch({ type: "resume" });
    await t.waitFor("voice resumed", () => window.e2e.view()?.snapshot?.voice?.clock?.rate > 0, undefined, 5_000);
    const resumed = await t.clock();
    assert.ok(resumed.voice.positionMs >= frozen2.voice.positionMs - 1 && resumed.voice.positionMs < frozen2.voice.positionMs + 600, `voice continues, not restarted: ${frozen2.voice.positionMs} → ${resumed.voice.positionMs}`);
    const resumedPcm = analyzePcm(await t.capture("resumed-voice", 0.3));
    assert.ok(resumedPcm.amplitude[880] > 0.05, "voice audible again");
    const events = await t.events();
    assert.equal(events.filter((e) => isEffect(e, "voice.load")).length, 1, "same cue resumed, never reloaded");
    await t.waitFor("overlap completed", () => {
      const s = window.e2e.view()?.snapshot;
      return s?.program?.item.track.mediaId === "b12" && s.transition === null && s.voice === null;
    }, undefined, 10_000);
    await t.dispatch({ type: "seek", positionMs: 8_000 });
    await t.waitEvent("seeked", `e.kind === "fact" && e.data.type === "deck.media" && e.data.event.kind === "seeked"`, 5_000);
    const afterSeek = await t.clock();
    const deckB = afterSeek.decks.A?.loadId && (await t.view()).snapshot.program.deck === "A" ? afterSeek.decks.A : afterSeek.decks.B;
    assert.ok(Math.abs(deckB.positionMs - 8_000) < 400, `clock re-anchored by seek: ${deckB.positionMs}`);
    const seekPcm = analyzePcm(await t.capture("after-seek", 0.4));
    assert.ok(seekPcm.amplitude[660] > 0.17, "B plays after seek");
    return { frozen: { frozen1, frozen2 }, resumed, afterSeek, silence, resumedPcm, seekPcm, screenshots: [pausedShot] };
  },

  async "late-cue-direct-handover"(t) {
    await t.boot({ catalog: CATALOG, djEnabled: true, cue: { hold: true } });
    await t.dispatch(enqueue("a3", "b12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a3");
    const capturing = t.capture("late-cue-no-voice", 4.0);
    await t.waitProgramPlaying("b12", 8_000);
    const released = await t.release("cue:cue");
    await sleep(400);
    const record = await capturing;
    const events = await t.events();
    assert.equal(events.filter((e) => isEffect(e, "voice.load") || isEffect(e, "voice.play")).length, 0, "late narration never loads or plays");
    const pcm = analyzePcm(record);
    assert.ok(pcm.amplitude[880] < 0.003, `no voice in output: ${pcm.amplitude[880]}`);
    return { releasedLateCue: released, pcm, wav: record.wav };
  },

  async "play-rejected-then-gesture"(t) {
    // No page.evaluate before the rejection window: Puppeteer evaluations carry a user gesture.
    const boot = { catalog: CATALOG, djEnabled: false, timeouts: { unlockMs: 1_500 } };
    await t.page.goto(`${t.origin}/#autostart=${encodeURIComponent(JSON.stringify({ boot, commands: [enqueue("a12"), { type: "resume" }] }))}`);
    await sleep(3_500);
    const view = await t.view();
    const events = await t.events();
    assert.equal(view.snapshot.transport, "blocked", `transport ${view.snapshot.transport}`);
    assert.ok(events.some((e) => isFact(e, "deck.media", "play-rejected", (d) => d.event.reason === "not-allowed")), "rejection reported as not-allowed");
    assert.equal(events.filter((e) => isFact(e, "deck.media", "playing")).length, 0, "nothing claimed playing");
    assert.equal((await t.page.evaluate(() => window.e2e.receipts())).length, 0, "no started receipt");
    const blockedShot = await t.screenshot("blocked");
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a12", 8_000);
    const pcm = analyzePcm(await t.capture("after-gesture", 0.4));
    assert.ok(pcm.amplitude[440] > 0.17);
    return { pcm, screenshots: [blockedShot] };
  },

  async "stream-stall-and-missing-source"(t) {
    t.server.configure("stall-1", { fixture: "a12.wav", initialBytes: 600_044, chunkBytes: 32_768, intervalMs: 15 });
    await t.boot({ catalog: { ...CATALOG, stall: { controlled: "stall-1", durationMs: 12_000 } }, djEnabled: false, timeouts: { stallMs: 30_000 } });
    await t.dispatch(enqueue("stall", "missing", "b12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("stall");
    await t.waitTransport("waiting", 15_000);
    const w1 = await t.clock();
    await sleep(400);
    const w2 = await t.clock();
    const stalledDeck = (await t.view()).snapshot.program.deck;
    assert.equal(w2.decks[stalledDeck].positionMs, w1.decks[stalledDeck].positionMs, "clock frozen while waiting");
    assert.equal(w2.decks[stalledDeck].rate, 0);
    const silence = analyzePcm(await t.capture("waiting-silence", 0.3));
    assert.ok(silence.rms < 0.01, `silent while starved: ${silence.rms}`);
    const waitingShot = await t.screenshot("waiting");
    t.server.control("stall-1", "resume");
    await t.waitProgramPlaying("stall", 10_000);
    const resumed = analyzePcm(await t.capture("stall-resumed", 0.3));
    assert.ok(resumed.amplitude[440] > 0.17, "same stream resumes after data arrives");
    await t.dispatch({ type: "next" }); // → missing source
    await t.waitProgramPlaying("b12", 15_000);
    const events = await t.events();
    const error = find(events, (e) => isFact(e, "deck.media", "error"), "media error for missing source");
    assert.equal(error.data.event.error.class, "unavailable");
    const view = await t.view();
    assert.deepEqual(view.snapshot.history.map((h) => [h.item.track.mediaId, h.outcome]), [["stall", "skipped"], ["missing", "failed"]]);
    return { w1, w2, silence, resumed, missingError: error.data.event.error, screenshots: [waitingShot] };
  },

  async "natural-end-queue-exhausted"(t) {
    await t.boot({ catalog: CATALOG, djEnabled: false });
    await t.dispatch(enqueue("a3"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a3");
    // Workspace core reports "idle"; the pending R1 contract names this state "exhausted" (still wants to play when more is queued).
    await t.waitFor("no program after the end", () => {
      const s = window.e2e.view()?.snapshot;
      return s?.program === null && ["idle", "exhausted"].includes(s.transport) && s.history.length === 1;
    }, undefined, 8_000);
    const events = await t.events();
    const A = loadOf(events, "a3");
    const order = events.filter((e) => e.kind === "fact" && e.data.loadId === A.loadId && ["paused", "ended"].includes(e.data.event.kind)).map((e) => `${e.data.event.kind}${e.data.event.atEnd ? "(atEnd)" : ""}`);
    assert.deepEqual(order, ["paused(atEnd)", "ended"]);
    const view = await t.view();
    assert.deepEqual(view.snapshot.history.map((h) => [h.item.track.mediaId, h.outcome, h.started]), [["a3", "played", true]]);
    const diag = await t.diagnostics();
    assert.equal(diag.driver.liveElements, 0, "ended deck released");
    return { factOrder: order, diagnostics: diag.driver };
  },

  async "two-tabs-single-executor"(t) {
    const lock = { lockName: `claudio-e2e-${Date.now()}`, storageKey: `claudio-e2e-queue-${Date.now()}` };
    const boot = (label) => ({ catalog: CATALOG, djEnabled: true, coordinated: lock, label, cue: { voiceDurationMs: null } });
    await t.boot(boot("tab1"));
    await t.waitFor("tab1 executor", () => window.e2e.view()?.canControl === true);
    const second = await t.openPage("tab2");
    await second.boot(boot("tab2"));
    await second.waitFor("tab2 observer", () => window.e2e.view()?.role === "observer");
    await t.dispatch(enqueue("a12", "b12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a12");
    await second.waitFor("observer sees playing", () => window.e2e.view()?.snapshot?.transport === "playing", undefined, 5_000);
    const observerView = await second.view();
    const observerDiag = await second.diagnostics();
    assert.equal(observerDiag.counters.driversCreated, 0, "observer created no driver/AudioContext");
    assert.equal(observerDiag.counters.prepare + observerDiag.counters.cue + observerDiag.counters.receipts, 0, "observer made no prepare/TTS/started calls");
    assert.deepEqual(await second.dispatch({ type: "pause" }), { accepted: false, reason: "observer" });
    const ownerShot = await t.screenshot("tab1-owner");
    const observerShot = await second.screenshot("tab2-observer");
    await t.page.close();
    await second.waitFor("tab2 takes over", () => window.e2e.view()?.canControl === true, undefined, 10_000);
    await second.waitFor("restored queue", () => (window.e2e.view()?.snapshot?.queue.length ?? 0) > 0, undefined, 5_000);
    const takeover = await second.view();
    assert.equal(takeover.snapshot.transport, "idle", "takes over stopped");
    assert.equal(takeover.snapshot.voice, null, "no cue carried over");
    assert.deepEqual(takeover.snapshot.queue.map((e) => e.item.track.mediaId), ["a12", "b12"]);
    const takeoverDiag = await second.diagnostics();
    // The new owner's context was created without a gesture in this tab: it is not running, and nothing is loaded.
    assert.equal(takeoverDiag.driver.liveElements, 0, "no media element loaded on takeover");
    const quiet = takeoverDiag.driver.contextState === "running" ? analyzePcm(await second.capture("takeover-silence", 0.4)) : { contextState: takeoverDiag.driver.contextState, rms: 0, note: "context not running ⇒ no output frames" };
    assert.ok(quiet.rms < 0.001, "new owner is silent until the user resumes");
    assert.equal(takeoverDiag.counters.receipts + takeoverDiag.counters.cue, 0, "no receipt or narration replay on takeover");
    const takeoverShot = await second.screenshot("tab2-after-takeover");
    await second.click([{ type: "resume" }]);
    await second.waitProgramPlaying("a12", 8_000);
    const resumed = analyzePcm(await second.capture("takeover-resumed", 0.4));
    assert.ok(resumed.amplitude[440] > 0.17);
    return { observerExecutor: observerView.executorInstanceId, takeoverInstance: takeover.executorInstanceId, quiet, resumed, screenshots: [ownerShot, observerShot, takeoverShot] };
  },

  async "remount-rebuild"(t) {
    const lock = { lockName: `claudio-e2e-remount-${Date.now()}`, storageKey: `claudio-e2e-remount-queue-${Date.now()}` };
    await t.boot({ catalog: CATALOG, djEnabled: false, coordinated: lock, label: "mount" });
    await t.waitFor("executor", () => window.e2e.view()?.canControl === true);
    await t.dispatch(enqueue("a12", "b12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a12");
    await t.page.evaluate(() => window.e2e.remount());
    await t.waitFor("remounted executor", () => window.e2e.view()?.canControl === true, undefined, 10_000);
    const diag = await t.diagnostics();
    const old = diag.retiredDrivers.at(-1);
    assert.equal(old.disposed, true);
    assert.equal(old.contextState, "closed", "old AudioContext closed");
    assert.equal(old.liveElements, 0);
    assert.equal(old.releasedElements, old.createdElements, "every old element released");
    assert.equal(diag.driver.createdElements, 0, "new driver starts without elements");
    assert.equal(diag.view.snapshot.transport, "idle");
    const quiet = analyzePcm(await t.capture("remount-silence", 0.4));
    assert.ok(quiet.rms < 0.001, `old graph fully silent: ${quiet.rms}`);
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a12", 8_000);
    const pcm = analyzePcm(await t.capture("remount-resumed", 0.4));
    assert.ok(pcm.amplitude[440] > 0.17);
    return { old, quiet, pcm };
  },

  // The platform stops rendering the shared output (AudioContext suspend; not a physical OS interruption) and resumes it.
  async "output-suspend-resume"(t) {
    await t.boot({ catalog: CATALOG, djEnabled: false });
    await t.dispatch(enqueue("a12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a12");
    await sleep(400);
    const before = analyzePcm(await t.capture("before-suspend", 0.4));
    assert.ok(before.amplitude[440] > 0.17, `A audible before: ${JSON.stringify(before.amplitude)}`);
    const deck = (await t.view()).snapshot.program.deck;
    const mark = (await t.events()).length;
    assert.equal(await t.page.evaluate(() => window.e2e.otherOutput(false)), "suspended");
    await t.waitTransport("waiting", 3_000);
    const held1 = await t.clock();
    await sleep(500);
    const held2 = await t.clock();
    assert.equal(held2.decks[deck].rate, 0, "rate 0 while nothing renders");
    assert.equal(held2.decks[deck].positionMs, held1.decks[deck].positionMs, "clock frozen while suspended");
    assert.equal(await t.page.evaluate(() => window.e2e.otherOutput(true)), "running");
    await t.waitProgramPlaying("a12", 5_000);
    await sleep(300);
    const after = analyzePcm(await t.capture("after-resume", 0.4));
    assert.ok(after.amplitude[440] > 0.17, `A audible after resume: ${JSON.stringify(after.amplitude)}`);
    const moved = await t.clock();
    assert.ok(moved.decks[deck].positionMs > held2.decks[deck].positionMs + 200, "media clock runs again");
    const events = (await t.events()).slice(mark);
    const kinds = events.filter((e) => isFact(e, "deck.media")).map((e) => e.data.event.kind).filter((k) => k !== "time");
    assert.deepEqual(kinds.slice(0, 2), ["waiting", "playing"], `facts across the suspension: ${kinds}`);
    assert.equal(events.filter((e) => isFact(e, "deck.media", "error")).length, 0, "a frozen output is no stall/start timeout");
    assert.equal(events.filter((e) => e.kind === "effect" && e.data.type === "receipt.report").length, 0, "no second receipt");
    return { before, after, factKinds: kinds };
  },

  // Another agent pauses the element and, before its queued `pause` is dispatched, the listener seeks.
  async "external-pause-then-seek"(t) {
    await t.boot({ catalog: CATALOG, djEnabled: false });
    await t.dispatch(enqueue("a12", "b12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a12");
    await sleep(800);
    const mark = (await t.events()).length;
    await t.page.evaluate(() => window.e2e.otherPause("a12.wav", { type: "seek", positionMs: 6_000 }));
    await sleep(800);
    await t.waitProgramPlaying("a12", 5_000);
    const seekEvents = (await t.events()).slice(mark);
    const loadId = (await t.view()).snapshot.program.loadId;
    const pauses = seekEvents.filter((e) => isFact(e, "deck.media", "paused", (d) => d.loadId === loadId));
    assert.deepEqual(pauses.map((e) => e.data.event.requested), [], "the superseded pause is no fact");
    assert.ok(seekEvents.some((e) => e.kind === "driver.pause.superseded"), "the driver saw and superseded the queued pause");
    assert.equal(seekEvents.some((e) => e.kind === "note" && /external pause/.test(String(e.data?.reason))), false, "transport not paused");
    const clock = await t.clock();
    const position = clock.decks[(await t.view()).snapshot.program.deck].positionMs;
    assert.ok(position > 6_300 && position < 8_500, `played on from the seek target: ${position}`);
    const sought = analyzePcm(await t.capture("after-seek", 0.4));
    assert.ok(sought.amplitude[440] > 0.17);

    // Without a later request the same external pause is respected: the transport pauses.
    const mark2 = (await t.events()).length;
    await t.page.evaluate(() => window.e2e.otherPause("a12.wav"));
    await t.waitTransport("paused", 3_000);
    const real = (await t.events()).slice(mark2).filter((e) => isFact(e, "deck.media", "paused"));
    // The interruption, then the acknowledgement of the transport pause it caused (nothing owed: answered at once).
    assert.deepEqual(real.map((e) => e.data.event.requested), [false, true], "one unrequested pause, then the core's own pause acknowledged");
    await sleep(300); // the element's already-decoded tail drains through the graph
    const silent = analyzePcm(await t.capture("external-paused", 0.4));
    assert.ok(silent.rms < 0.002, `silent: ${silent.rms}`);
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a12", 5_000);
    const view = await t.view();
    assert.deepEqual(view.snapshot.receipts.map((r) => r.itemId), [view.snapshot.program.item.itemId], "one receipt (A); B never started");
    return { position, sought, silent };
  },

  // The listener seeks back inside the natural end's timeupdate (paused/ended already set, pause/ended queued); then the output suspends and resumes.
  async "end-seek-race-then-output-resume"(t) {
    await t.boot({ catalog: CATALOG, djEnabled: false });
    await t.dispatch(enqueue("a3", "b12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a3");
    await t.dispatch({ type: "seek", positionMs: 2_500 });
    await t.page.evaluate(() => window.e2e.atEnd("a3.wav", { type: "seek", positionMs: 150 }));
    await t.waitEvent("seek inside the end window", `e.kind === "other.at-end.after"`, 5_000);
    const events = await t.events();
    const at = find(events, (e) => e.kind === "other.at-end", "at-end");
    const after = find(events, (e) => e.kind === "other.at-end.after", "at-end.after");
    assert.deepEqual([at.data.paused, at.data.ended], [true, true], "the window was hit: element paused and ended, events queued");
    assert.deepEqual([after.data.ended, after.data.seeking], [false, true]);
    await t.waitProgramPlaying("a3", 5_000);
    const window1 = (await t.events()).slice(events.indexOf(at));
    assert.ok(window1.some((e) => e.kind === "driver.ended.obsolete"), "the queued ended was recognised as obsolete");
    assert.equal(window1.some((e) => isFact(e, "deck.media", "ended")), false);
    assert.equal(window1.some((e) => isFact(e, "deck.media", "paused")), false, "the end's pause was superseded by the seek's play");
    await sleep(300);
    assert.equal(await t.page.evaluate(() => window.e2e.otherOutput(false)), "suspended");
    await t.waitTransport("waiting", 3_000);
    assert.equal(await t.page.evaluate(() => window.e2e.otherOutput(true)), "running");
    await t.waitProgramPlaying("a3", 3_000);
    await sleep(250);
    const pcm = analyzePcm(await t.capture("after-resume", 0.4));
    assert.ok(pcm.amplitude[440] > 0.17, `A still sounds: ${JSON.stringify(pcm.amplitude)}`);
    const view = await t.view();
    assert.equal(view.snapshot.program.item.track.mediaId, "a3", "the obsolete end did not advance to B");
    assert.equal(view.snapshot.receipts.length, 1);
    return { at: at.data, after: after.data, pcm };
  }
};

const backgroundScenarios = {
  async "hidden-tab-crossfade-with-voice"(t) {
    await t.boot({ catalog: CATALOG, djEnabled: true, coreConfig: CROSSFADE, cue: { voiceDurationMs: 1_800 } });
    await t.dispatch(enqueue("a6", "b12"));
    await t.click([{ type: "resume" }]);
    await t.waitProgramPlaying("a6");
    await t.page.evaluate(() => {
      window.__bg = { raf: 0, visibility: [] };
      const tick = () => {
        window.__bg.raf++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      document.addEventListener("visibilitychange", () => window.__bg.visibility.push({ state: document.visibilityState, t: performance.now() }));
    });
    const capturing = t.page.evaluate(() => {
      window.__capture = window.e2e.record("hidden", 7);
      return true;
    });
    await capturing;
    const cover = await t.openPage("cover");
    await cover.page.bringToFront();
    await t.waitFor("hidden", () => document.visibilityState === "hidden", undefined, 3_000);
    const hiddenStart = await t.page.evaluate(() => ({ raf: window.__bg.raf, t: performance.now() }));
    const raw = await t.page.evaluate(() => window.__capture);
    const hiddenEnd = await t.page.evaluate(() => ({ raf: window.__bg.raf, t: performance.now(), visibility: document.visibilityState, view: window.e2e.view() }));
    assert.equal(hiddenEnd.visibility, "hidden");
    const record = decodeCapture(raw);
    record.wav = await writeWav(join(t.dir, "hidden-crossfade.wav"), record);
    const events = await t.events();
    const voicePlaying = find(events, (e) => isFact(e, "voice.media", "playing"), "voice playing");
    const voiceEnded = find(events, (e) => isFact(e, "voice.media", "ended"), "voice ended");
    const duck = tones(record, voicePlaying.ctx + 0.7, voiceEnded.ctx - 0.05);
    const after = tones(record, voiceEnded.ctx + 0.75, record.startContextTime + record.frames / record.sampleRate - 0.1);
    assert.ok(duck.amplitude[880] > 0.08 && Math.abs(duck.amplitude[440] / 0.2 - 0.3) < 0.06, `hidden duck ${JSON.stringify(duck.amplitude)}`);
    assert.ok(after.amplitude[660] > 0.17 && after.amplitude[440] < 0.01, `hidden after ${JSON.stringify(after.amplitude)}`);
    assert.equal(hiddenEnd.view.snapshot.program.item.track.mediaId, "b12", "transition completed while hidden");
    const hiddenRafDelta = hiddenEnd.raf - hiddenStart.raf;
    const mark = events.length;
    await t.page.bringToFront();
    await t.waitFor("visible", () => document.visibilityState === "visible", undefined, 3_000);
    await sleep(200);
    const back = (await t.events()).slice(mark);
    const resampleAt = back.findIndex((e) => e.kind === "driver.resample");
    assert.ok(resampleAt >= 0 && back[resampleAt + 1]?.kind === "fact.time", "clocks re-read from the elements on return to visible");
    const clock = await t.clock();
    const deck = clock.decks[(await t.view()).snapshot.program.deck];
    assert.ok(deck.rate > 0 && deck.positionMs > 1_000, "program clock is live after return");
    return { hiddenRafDelta, duck, after, wav: record.wav, flags: t.flags };
  }
};

// ---------------------------------------------------------------------- runner

async function buildPage(dir) {
  const from = process.env.CLAUDIO_E2E_PACKAGES_FROM;
  await build({
    root: join(here, "page"),
    logLevel: "warn",
    configFile: false,
    resolve: {
      conditions: ["source", ...defaultClientConditions],
      alias: from
        ? [
            { find: /^@claudio\/contracts$/, replacement: resolve(from, "contracts/src/index.ts") },
            { find: /^@claudio\/playback-core$/, replacement: resolve(from, "playback-core/src/index.ts") }
          ]
        : []
    },
    build: { outDir: dir, emptyOutDir: true, sourcemap: true, target: "es2022", minify: false }
  });
  return from ?? null;
}

/** Names known contract gaps visible in the event log, so a failure says why. */
async function diagnose(t) {
  if (t.page.isClosed()) return null;
  const events = await t.events();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (isFact(e, "deck.media", "paused", (d) => d.event.atEnd === true)) {
      const next = events.slice(i + 1, i + 4).find((n) => n.kind === "note");
      if (next && String(next.data?.reason).includes("external pause")) {
        return "core treated the browser's end-of-media pause (atEnd=true) as an external pause; needs the R1 MediaEvent.paused.atEnd handling";
      }
    }
  }
  return null;
}

async function runSuite(kind, table, context) {
  const results = [];
  const { browser, spawnargs, libDir } = await launchBrowser({ executablePath: context.chrome, background: kind === "background" });
  const flags = spawnargs.filter((a) => a.startsWith("--"));
  if (kind === "background") {
    for (const flag of [...BACKGROUND_OVERRIDES, "--mute-audio"]) assert.ok(!spawnargs.includes(flag), `${flag} must be absent in the background suite`);
  }
  const version = await browser.version();
  try {
    for (const [name, scenario] of Object.entries(table)) {
      if (only && !only.has(name)) continue;
      const dir = join(outDir, kind, name);
      await mkdir(dir, { recursive: true });
      const browserContext = await browser.createBrowserContext();
      const pages = [];
      const openPage = async (label) => {
        const page = await browserContext.newPage();
        await page.setRequestInterception(true);
        page.on("request", (r) => (r.url().startsWith(context.server.origin) || r.url().startsWith("blob:") || r.url().startsWith("data:") ? r.continue() : r.abort()));
        const tp = new TestPage(page, `${name}/${label}`, dir);
        tp.origin = context.server.origin;
        tp.server = context.server;
        tp.flags = flags;
        tp.openPage = openPage;
        pages.push(tp);
        if (label !== "autostart") await page.goto(context.server.origin);
        return tp;
      };
      const t = await openPage(name === "play-rejected-then-gesture" ? "autostart" : "main");
      const started = performance.now();
      let outcome;
      try {
        const details = await scenario(t);
        outcome = { name, suite: kind, status: "passed", durationMs: Math.round(performance.now() - started), details };
      } catch (error) {
        const screenshot = await t.screenshot("failure").catch(() => null);
        const diagnosis = await diagnose(t).catch(() => null);
        outcome = { name, suite: kind, status: "failed", durationMs: Math.round(performance.now() - started), error: String(error?.stack ?? error), diagnosis, screenshot };
      }
      for (const p of pages) {
        if (p.page.isClosed()) continue;
        const events = await p.events().catch(() => null);
        const diag = await p.diagnostics().catch(() => null);
        await writeFile(join(dir, `${p.name.split("/")[1]}-events.json`), JSON.stringify({ events, diagnostics: diag, pageErrors: p.errors }, null, 2));
        if (p.errors.length && outcome.status === "passed") outcome = { ...outcome, status: "failed", error: `page errors: ${p.errors.join("; ")}` };
        await p.page.evaluate(() => window.e2e.dispose()).catch(() => null);
      }
      await browserContext.close();
      results.push(outcome);
      console.log(`${outcome.status === "passed" ? "✔" : "✖"} [${kind}] ${name} (${outcome.durationMs} ms)${outcome.status === "failed" ? "\n    " + outcome.error.split("\n").slice(0, 2).join("\n    ") + (outcome.diagnosis ? `\n    diagnosis: ${outcome.diagnosis}` : "") : ""}`);
    }
  } finally {
    await browser.close();
  }
  return { kind, browser: version, flags, libDir, results };
}

const chrome = resolveChrome(args.chrome);
await mkdir(outDir, { recursive: true });
const manifest = await generateFixtures(join(outDir, "fixtures"));
const pageDir = join(outDir, "page");
const packagesFrom = await buildPage(pageDir);
const server = await startFixtureServer({ pageDir, mediaDir: join(outDir, "fixtures") });
const suites = [];
try {
  if (args.suite === "foreground" || args.suite === "all") suites.push(await runSuite("foreground", scenarios, { chrome, server }));
  if (args.suite === "background" || args.suite === "all") suites.push(await runSuite("background", backgroundScenarios, { chrome, server }));
} finally {
  await server.close();
}
const all = suites.flatMap((s) => s.results);
const summary = {
  kind: "playback-web browser suite: real Chromium + real core/driver + fixture ports; PCM is in-graph output, not loudspeaker capture",
  generatedAt: new Date().toISOString(),
  chrome,
  autoplayFlag: AUTOPLAY_FLAG,
  packagesFrom,
  fixtures: manifest,
  suites,
  passed: all.filter((r) => r.status === "passed").length,
  failed: all.filter((r) => r.status === "failed").length,
  serverTrace: server.trace.filter((e) => e.type !== "media-request").slice(-200)
};
await writeFile(join(outDir, "browser-result.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed} passed, ${summary.failed} failed → ${join(outDir, "browser-result.json")}`);
process.exit(summary.failed > 0 ? 1 : 0);
