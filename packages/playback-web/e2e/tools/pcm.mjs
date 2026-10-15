// Post-master PCM evidence: tone attribution and WAV export. Analysis uses
// the capture's actual sampleRate (the AudioContext rate, not the fixture rate).
import { writeFile } from "node:fs/promises";

export const MARKERS = { A: 440, C: 550, B: 660, voice: 880 };

/** Decode the page's base64 Float32 channel payload. */
export function decodeCapture(raw) {
  const channels = raw.channels.map((b64) => {
    const bytes = Buffer.from(b64, "base64");
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  });
  return { ...raw, channels, frames: channels[0]?.length ?? 0 };
}

/**
 * RMS/peak and Hann-windowed single-bin amplitude at each marker frequency in
 * [fromSeconds, toSeconds) of the capture (relative to its first frame).
 */
export function analyzePcm(record, { fromSeconds = 0, toSeconds = Infinity, tones = Object.values(MARKERS) } = {}) {
  if (!record.sampleRate || !record.channels?.length) throw new Error("PCM capture is empty");
  if (record.continuityGaps?.length) throw new Error(`PCM capture has ${record.continuityGaps.length} gaps`);
  const data = record.channels[0];
  const start = Math.max(0, Math.floor(fromSeconds * record.sampleRate));
  const end = Math.min(data.length, Math.floor(toSeconds * record.sampleRate));
  if (end - start < 64) throw new Error(`analysis window [${fromSeconds}, ${toSeconds}) is empty`);
  let sumSquares = 0;
  let peak = 0;
  for (let i = start; i < end; i++) {
    sumSquares += data[i] * data[i];
    peak = Math.max(peak, Math.abs(data[i]));
  }
  const n = end - start;
  const amplitude = {};
  for (const frequency of tones) {
    let re = 0;
    let im = 0;
    let weight = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      const angle = (2 * Math.PI * frequency * (start + i)) / record.sampleRate;
      re += data[start + i] * w * Math.cos(angle);
      im += data[start + i] * w * Math.sin(angle);
      weight += w;
    }
    amplitude[frequency] = (2 * Math.hypot(re, im)) / weight;
  }
  return { fromSeconds, toSeconds: end / record.sampleRate, frames: n, rms: Math.sqrt(sumSquares / n), peak, amplitude };
}

export async function writeWav(path, record) {
  const channels = record.channels.length;
  const frames = record.channels[0]?.length ?? 0;
  if (!channels || !frames) throw new Error("empty PCM");
  const dataBytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(record.sampleRate, 24);
  buffer.writeUInt32LE(record.sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  let clippedSamples = 0;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const raw = record.channels[ch][i];
      if (Math.abs(raw) > 1) clippedSamples++;
      const sample = Math.min(1, Math.max(-1, raw));
      buffer.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + (i * channels + ch) * 2);
    }
  }
  await writeFile(path, buffer);
  return { path, frames, channels, sampleRate: record.sampleRate, seconds: frames / record.sampleRate, clippedSamples };
}
