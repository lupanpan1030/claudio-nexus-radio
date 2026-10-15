// Headless Chromium for the main-app acceptance, plus a page observer that
// only watches native objects: it wraps constructors/methods but keeps their
// results, never creates audio nodes, changes routing, fakes snapshots or
// media events. Readings of the app's own state go through the dev-only,
// read-only window.__claudioPlayback / __claudioStage bridges.
//
// Env (all optional): CLAUDIO_CHROME (executable; else the newest Playwright
// Chromium in ~/.cache/ms-playwright), CLAUDIO_CHROME_LIB_DIR (extra shared
// libraries), CLAUDIO_E2E_FONT_DIR (a directory with a CJK font, used via a
// private fontconfig file).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import puppeteer from "puppeteer-core";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const xml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export function resolveChrome() {
  const explicit = process.env.CLAUDIO_CHROME;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`CLAUDIO_CHROME not found: ${explicit}`);
    return explicit;
  }
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(cache)) {
    const builds = fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const build of builds) {
      const candidate = path.join(cache, build, "chrome-linux64", "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error("No Chromium: set CLAUDIO_CHROME (and CLAUDIO_CHROME_LIB_DIR if shared libraries are missing).");
}

export async function launchBrowser(artifactDir) {
  const executablePath = resolveChrome();
  const libDir = process.env.CLAUDIO_CHROME_LIB_DIR ?? null;
  const fontDir = process.env.CLAUDIO_E2E_FONT_DIR ?? null;
  const env = { PATH: process.env.PATH ?? "", TZ: "UTC", HOME: process.env.HOME ?? os.homedir() };
  if (libDir) env.LD_LIBRARY_PATH = libDir;
  let fontMatch = null;
  if (fontDir) {
    const dir = path.join(artifactDir, "fontconfig");
    fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
    const file = path.join(dir, "fonts.conf");
    fs.writeFileSync(file, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${xml(fontDir)}</dir><cachedir>${xml(path.join(dir, "cache"))}</cachedir></fontconfig>`);
    env.FONTCONFIG_FILE = file;
  }
  const match = spawnSync("fc-match", ["-f", "%{family}|%{file}", "sans-serif:lang=zh-cn"], { env, encoding: "utf8" });
  fontMatch = match.status === 0 ? match.stdout : null;
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    env,
    // No autoplay override: playback starts from real clicks/key presses only.
    args: ["--no-sandbox", "--disable-background-networking", "--enable-unsafe-swiftshader"],
    // Keep real background throttling; do not mute output.
    ignoreDefaultArgs: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--mute-audio"]
  });
  const environment = { executablePath, version: await browser.version(), libDir, fontDir, fontMatch, headless: true, autoplayOverride: false };
  fs.writeFileSync(path.join(artifactDir, "browser-environment.json"), JSON.stringify(environment, null, 2));
  return { browser, environment };
}

// Runs in the page before any app code.
function installObserver(options) {
  const events = [];
  const samples = [];
  const pcm = [];
  const contexts = [];
  const media = [];
  const analysers = [];
  const ids = new WeakMap();
  let nextId = 0;
  const idFor = (object) => {
    if (!ids.has(object)) ids.set(object, `o${++nextId}`);
    return ids.get(object);
  };
  const append = (list, value, max) => {
    list.push(value);
    if (list.length > max) list.shift();
  };
  const stamp = () => ({ at: Date.now(), visibility: document.visibilityState });
  const mediaState = (element) => ({ id: idFor(element), src: element.currentSrc || element.src || "", currentTime: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : null, paused: element.paused, ended: element.ended, readyState: element.readyState, error: element.error ? element.error.code : null });
  const trackMedia = (element) => {
    if (!(element instanceof HTMLMediaElement) || media.includes(element)) return element;
    media.push(element);
    append(events, { type: "media-created", ...stamp(), ...mediaState(element) }, 6000);
    for (const type of ["play", "playing", "pause", "waiting", "seeked", "ended", "error"]) element.addEventListener(type, () => append(events, { type: `media-${type}`, ...stamp(), ...mediaState(element) }, 6000));
    return element;
  };
  const patch = (target, key, wrap) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor) return;
    Object.defineProperty(target, key, { ...descriptor, value: wrap(descriptor.value) });
  };
  patch(window, "Audio", (Native) => new Proxy(Native, { construct: (target, args, newTarget) => trackMedia(Reflect.construct(target, args, newTarget)) }));
  patch(HTMLMediaElement.prototype, "play", (native) => function (...args) {
    trackMedia(this);
    return Reflect.apply(native, this, args);
  });
  patch(Document.prototype, "createElement", (native) => function (...args) {
    const result = Reflect.apply(native, this, args);
    if (result instanceof HTMLMediaElement) trackMedia(result);
    return result;
  });
  const seenContext = (context) => {
    if (contexts.includes(context)) return context;
    contexts.push(context);
    append(events, { type: "context-created", ...stamp(), id: idFor(context), state: context.state }, 6000);
    return context;
  };
  for (const key of ["AudioContext", "webkitAudioContext"]) if (window[key]) patch(window, key, (Native) => new Proxy(Native, { construct: (target, args, newTarget) => seenContext(Reflect.construct(target, args, newTarget)) }));
  if (window.BaseAudioContext) {
    patch(BaseAudioContext.prototype, "createAnalyser", (native) => function (...args) {
      const node = Reflect.apply(native, this, args);
      seenContext(this);
      analysers.push({ node, context: this });
      return node;
    });
  }
  // Media Session: keep exactly what the app registers (still registering it natively).
  const sessionHandlers = new Map();
  if (navigator.mediaSession) {
    const session = navigator.mediaSession;
    const native = session.setActionHandler.bind(session);
    session.setActionHandler = (action, handler) => {
      sessionHandlers.set(action, handler);
      return native(action, handler);
    };
  }
  // Optional synthetic speech input (Web Speech + microphone), only when the scenario asks for it.
  const speech = { starts: 0, stops: 0, aborts: 0, micRequests: 0, micTracksStopped: 0, instances: [] };
  if (options.fakeSpeech) {
    class FakeRecognition {
      constructor() {
        this.lang = "";
        this.continuous = false;
        this.interimResults = false;
        this.maxAlternatives = 1;
        this.onresult = null;
        this.onerror = null;
        this.onend = null;
        speech.instances.push(this);
      }
      start() {
        speech.starts += 1;
      }
      stop() {
        speech.stops += 1;
        setTimeout(() => this.onend?.(), 0);
      }
      abort() {
        speech.aborts += 1;
        setTimeout(() => this.onend?.(), 0);
      }
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
    const mediaDevices = navigator.mediaDevices ?? {};
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
    mediaDevices.getUserMedia = async () => {
      speech.micRequests += 1;
      return { getTracks: () => [{ stop: () => (speech.micTracksStopped += 1) }] };
    };
  }
  const say = (interim, final) => {
    const recognition = speech.instances.at(-1);
    if (!recognition?.onresult) return false;
    const result = (text, isFinal) => Object.assign([{ transcript: text }], { isFinal });
    recognition.onresult({ resultIndex: 0, results: [result(interim, false)] });
    recognition.onresult({ resultIndex: 0, results: [result(final, true)] });
    return true;
  };
  setInterval(() => {
    append(samples, { ...stamp(), media: media.map(mediaState), contexts: contexts.map((context) => ({ id: idFor(context), state: context.state })) }, 2400);
    for (const { node, context } of analysers) {
      // Existing analyser, read as is (sparse pre-master window, not speaker output).
      const values = new Float32Array(node.fftSize);
      node.getFloatTimeDomainData(values);
      let squared = 0;
      let peak = 0;
      for (const value of values) {
        squared += value * value;
        peak = Math.max(peak, Math.abs(value));
      }
      append(pcm, { ...stamp(), node: idFor(node), context: idFor(context), rms: Math.sqrt(squared / values.length), peak }, 1600);
    }
  }, 250);
  Object.defineProperty(window, "__uiE2eObserver", {
    value: Object.freeze({
      read: () => ({
        events,
        samples,
        pcm,
        media: media.map(mediaState),
        contexts: contexts.map((context) => ({ id: idFor(context), state: context.state })),
        mediaSessionActions: [...sessionHandlers.entries()].filter(([, handler]) => typeof handler === "function").map(([action]) => action),
        speech: { starts: speech.starts, stops: speech.stops, aborts: speech.aborts, micRequests: speech.micRequests, micTracksStopped: speech.micTracksStopped, instances: speech.instances.length }
      }),
      /** Runs the handler the app registered for `action` (not an OS media key). */
      mediaSession: (action) => {
        const handler = sessionHandlers.get(action);
        if (typeof handler !== "function") return false;
        handler({ action });
        return true;
      },
      say
    }),
    writable: false,
    configurable: false
  });
}

/** One page with the observer, network/console capture and an allowlist of the fixture origins. */
export async function openPage(context, { label, origins, artifactDir, fakeSpeech = false, beforeLoad = null }) {
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({ "x-fixture-client": label });
  const network = [];
  const consoleEntries = [];
  const blocked = [];
  const allowed = new Set(origins);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    let permit = false;
    try {
      const parsed = new URL(url);
      permit = allowed.has(parsed.origin) || parsed.protocol === "data:" || parsed.protocol === "blob:";
    } catch {
      permit = false;
    }
    const row = { at: Date.now(), type: "request", method: request.method(), url, resourceType: request.resourceType() };
    network.push(row);
    if (permit) void request.continue().catch(() => {});
    else {
      blocked.push(row);
      void request.abort("blockedbyclient").catch(() => {});
    }
  });
  page.on("response", (response) => network.push({ at: Date.now(), type: "response", url: response.url(), status: response.status() }));
  page.on("console", (message) => consoleEntries.push({ at: Date.now(), type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => consoleEntries.push({ at: Date.now(), type: "pageerror", text: String(error) }));
  await page.evaluateOnNewDocument(installObserver, { fakeSpeech });
  if (beforeLoad) await page.evaluateOnNewDocument(beforeLoad.fn, beforeLoad.arg);
  const capture = async (name) => {
    const state = { label, name, at: Date.now(), url: page.url() };
    state.view = await page.evaluate(() => window.__claudioPlayback?.view() ?? null).catch((error) => String(error));
    state.log = await page.evaluate(() => window.__claudioPlayback?.log() ?? null).catch((error) => String(error));
    state.observation = await page.evaluate(() => window.__uiE2eObserver?.read() ?? null).catch((error) => String(error));
    state.text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    fs.writeFileSync(path.join(artifactDir, `${label}-${name}.json`), JSON.stringify(state, null, 2));
    await page.screenshot({ path: path.join(artifactDir, `${label}-${name}.png`) }).catch(() => {});
    return state;
  };
  const dump = () => {
    fs.writeFileSync(path.join(artifactDir, `${label}-network.json`), JSON.stringify({ network, blocked }, null, 2));
    fs.writeFileSync(path.join(artifactDir, `${label}-console.json`), JSON.stringify(consoleEntries, null, 2));
  };
  return { page, label, network, consoleEntries, blocked, capture, dump };
}

export const readObservation = (page) => page.evaluate(() => window.__uiE2eObserver?.read() ?? null);

/** Media elements whose currentTime advanced while not paused, between two observation reads. */
export function progressing(before, after, minSeconds = 0.15) {
  if (!before || !after) return [];
  return after.media.filter((element) => {
    const earlier = before.media.find((item) => item.id === element.id);
    return earlier && !element.paused && element.src === earlier.src && element.currentTime - earlier.currentTime >= minSeconds;
  });
}
