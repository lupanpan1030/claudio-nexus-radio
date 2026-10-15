import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("player metadata keeps the title and artist without a playback-state label", async () => {
  const [player, stylesheet] = await Promise.all([
    readFile(new URL("./Player.tsx", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8")
  ]);

  assert.match(player, /<span>\{track\?\.artist \?\? "Claudio Radio"\}<\/span>/);
  assert.doesNotMatch(player, /PLAYING|READY|play-state|mini-detail/);
  assert.doesNotMatch(stylesheet, /\.mini-detail|\.play-state/);
});

test("voice panel keeps long titles and its close control within the viewport", async () => {
  const stylesheet = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  assert.match(stylesheet, /\.voice-card h2\s*\{[^}]*-webkit-line-clamp:\s*2;/);
  assert.match(stylesheet, /\.voice-card h2\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(stylesheet, /\.voice-panel-close\s*\{[^}]*z-index:\s*3;/);
});
