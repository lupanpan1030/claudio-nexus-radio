import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createWaveMemory, formatClock, shapeWave, WAVE_BARS } from "./wave";

test("spectrum shaping draws only what the analyser reports: silence or no bins give flat bars", () => {
  const memory = createWaveMemory();
  const silent = shapeWave(new Uint8Array(128), 128, memory, Array(WAVE_BARS).fill(0));
  assert.equal(silent.length, WAVE_BARS);
  assert.ok(silent.every((level) => level === 0));
  assert.ok(shapeWave(new Uint8Array(128), 0, createWaveMemory(), []).every((level) => level === 0));
});

test("music energy raises bounded bars with attack faster than release", () => {
  const memory = createWaveMemory();
  const loud = new Uint8Array(128).map((_, index) => (index < 54 ? 200 - index : 0));
  const first = shapeWave(loud, 128, memory, Array(WAVE_BARS).fill(0));
  assert.ok(first.some((level) => level > 0.05));
  assert.ok(first.every((level) => level >= 0 && level <= 1));
  const released = shapeWave(new Uint8Array(128), 128, memory, first);
  const peak = first.indexOf(Math.max(...first));
  assert.ok((released[peak] ?? 0) > 0 && (released[peak] ?? 0) < (first[peak] ?? 0), "release decays instead of snapping to zero");
});

test("the player never owns media: no element, AudioContext or analyser wiring in UI components", async () => {
  for (const file of ["Player.tsx", "PlaylistQueue.tsx", "LiveCaption.tsx", "../stage/LyricsPanel.tsx", "../App.tsx"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /new AudioContext|createMediaElementSource|createAnalyser|<audio|HTMLAudioElement|\.volume\s*=|requestAnimationFrame\(fade/, file);
    assert.doesNotMatch(source, /\/api\/radio\/next|\/api\/track\/|\/api\/tts\/|\/api\/dj\/line|updateNowPlaying/, file);
  }
});

test("clock formatting", () => {
  assert.equal(formatClock(null), "0:00");
  assert.equal(formatClock(61_900), "1:01");
});
