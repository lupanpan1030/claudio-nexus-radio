// Deterministic synthetic PCM fixtures (formula-generated tones; no private or
// third-party audio). Each source has its own marker frequency so recorded
// output can be attributed: A=440 Hz, B=660 Hz, C=550 Hz, voice=880 Hz.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const FIXTURE_RATE = 48_000;
export const AMPLITUDE = 0.2;

export const FIXTURES = [
  { file: "a12.wav", frequencyHz: 440, seconds: 12 },
  { file: "b12.wav", frequencyHz: 660, seconds: 12 },
  { file: "c12.wav", frequencyHz: 550, seconds: 12 },
  { file: "a3.wav", frequencyHz: 440, seconds: 3 },
  { file: "a6.wav", frequencyHz: 440, seconds: 6 },
  // Amplitude-pulsed so it is not mistaken for a steady music tone.
  { file: "voice.wav", frequencyHz: 880, seconds: 1.8, pulsed: true }
];

export function renderPcm16({ frequencyHz, seconds, pulsed = false }) {
  const count = Math.round(seconds * FIXTURE_RATE);
  const samples = new Int16Array(count);
  const fade = FIXTURE_RATE * 0.01;
  for (let i = 0; i < count; i++) {
    const t = i / FIXTURE_RATE;
    let envelope = Math.min(1, i / fade, (count - 1 - i) / fade);
    if (pulsed) envelope *= 0.35 + 0.65 * Math.sin(2 * Math.PI * 3 * t) ** 2;
    samples[i] = Math.round(32767 * AMPLITUDE * envelope * Math.sin(2 * Math.PI * frequencyHz * t));
  }
  return samples;
}

export function wavBytes(samples, sampleRate = FIXTURE_RATE) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i], 44 + i * 2);
  return buffer;
}

export async function generateFixtures(dir) {
  await mkdir(dir, { recursive: true });
  const manifest = [];
  for (const spec of FIXTURES) {
    const bytes = wavBytes(renderPcm16(spec));
    await writeFile(join(dir, spec.file), bytes);
    manifest.push({ ...spec, sampleRate: FIXTURE_RATE, channels: 1, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
