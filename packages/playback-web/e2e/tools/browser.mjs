// Chromium launcher for the browser suite. The executable and an optional
// extra shared-library directory are parameters (env or CLI), never a
// hard-coded machine path; a Playwright cache is only a discovery fallback.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

/** Puppeteer defaults that would hide real background behaviour or silence output. */
export const BACKGROUND_OVERRIDES = ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"];

/** Explicit, so the suite does not depend on the headless default autoplay policy. */
export const AUTOPLAY_FLAG = "--autoplay-policy=document-user-activation-required";

export function resolveChrome(cliPath) {
  const explicit = cliPath ?? process.env.CLAUDIO_CHROME;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Chromium not found at ${explicit}`);
    return explicit;
  }
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const build of builds) {
      const candidate = join(cache, build, "chrome-linux64", "chrome");
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error("No Chromium executable: pass --chrome <path> or set CLAUDIO_CHROME (optionally CLAUDIO_CHROME_LIB_DIR for missing shared libraries).");
}

export async function launchBrowser({ executablePath, libDir = process.env.CLAUDIO_CHROME_LIB_DIR, background = false }) {
  const env = { ...process.env };
  if (libDir) env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    env,
    args: ["--no-sandbox", "--disable-background-networking", AUTOPLAY_FLAG],
    // The background profile removes the throttling overrides and mute flag so hidden-tab behaviour is real.
    ignoreDefaultArgs: background ? [...BACKGROUND_OVERRIDES, "--mute-audio"] : []
  });
  return { browser, spawnargs: browser.process()?.spawnargs ?? [], libDir: libDir ?? null };
}
