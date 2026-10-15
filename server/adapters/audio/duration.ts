import type { DurationInfo } from "@claudio/contracts";

/**
 * Duration from container/frame metadata of complete audio bytes. Anything
 * not provable from the bytes is "unknown" — no bitrate guesses.
 */
export function probeAudioDuration(bytes: Uint8Array, format: string): DurationInfo {
  const ms =
    format === "wav" ? wavDurationMs(bytes)
    : format === "mp3" ? mp3DurationMs(bytes)
    : format === "ogg" || format === "opus" ? oggDurationMs(bytes)
    : format === "flac" ? flacDurationMs(bytes)
    : null;
  return ms === null || !Number.isFinite(ms) || ms <= 0 || ms > 24 * 3600_000
    ? { kind: "unknown" }
    : { kind: "known", ms: Math.round(ms), source: "container-metadata" };
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function wavDurationMs(bytes: Uint8Array): number | null {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return null;
  const data = view(bytes);
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = data.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 12 <= bytes.length) byteRate = data.getUint32(body + 8, true);
    if (id === "data") {
      if (!byteRate) return null;
      const available = Math.min(size === 0xffffffff ? Number.MAX_SAFE_INTEGER : size, bytes.length - body);
      return (available / byteRate) * 1000;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

const MP3_BITRATES: Record<string, readonly number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const MP3_SAMPLE_RATES: Record<number, readonly number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

interface Mp3Frame {
  readonly length: number;
  readonly samples: number;
  readonly sampleRate: number;
  readonly version: number;
  readonly mono: boolean;
}

function mp3Frame(bytes: Uint8Array, offset: number): Mp3Frame | null {
  if (offset + 4 > bytes.length) return null;
  const b1 = bytes[offset + 1]!;
  const b2 = bytes[offset + 2]!;
  const b3 = bytes[offset + 3]!;
  if (bytes[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 3;
  const layerBits = (b1 >> 1) & 3;
  if (versionBits === 1 || layerBits === 0) return null;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const layer = 4 - layerBits;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const bitrate = MP3_BITRATES[`${version === 1 ? 1 : 2}-${layer}`]![bitrateIndex]! * 1000;
  const sampleRate = MP3_SAMPLE_RATES[version]![rateIndex]!;
  const padding = (b2 >> 1) & 1;
  const samples = layer === 1 ? 384 : layer === 2 || version === 1 ? 1152 : 576;
  const length =
    layer === 1 ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4 : Math.floor((samples / 8) * bitrate / sampleRate) + padding;
  if (length < 4) return null;
  return { length, samples, sampleRate, version, mono: (b3 >> 6) === 3 };
}

export function mp3DurationMs(bytes: Uint8Array): number | null {
  let offset = 0;
  if (ascii(bytes, 0, 3) === "ID3" && bytes.length >= 10) {
    const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    offset = 10 + size + ((bytes[5]! & 0x10) !== 0 ? 10 : 0);
  }
  // Find the first frame whose successor also parses (avoids false syncs in junk).
  let first: Mp3Frame | null = null;
  for (let limit = Math.min(bytes.length, offset + 64 * 1024); offset < limit; offset += 1) {
    const frame = mp3Frame(bytes, offset);
    if (frame && (offset + frame.length >= bytes.length || mp3Frame(bytes, offset + frame.length))) {
      first = frame;
      break;
    }
  }
  if (!first) return null;

  const sideInfo = first.version === 1 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17;
  const tagOffset = offset + 4 + sideInfo;
  const tag = ascii(bytes, tagOffset, 4);
  if ((tag === "Xing" || tag === "Info") && tagOffset + 12 <= bytes.length) {
    const flags = view(bytes).getUint32(tagOffset + 4, false);
    if (flags & 1) {
      const frames = view(bytes).getUint32(tagOffset + 8, false);
      if (frames > 0) return ((frames * first.samples) / first.sampleRate) * 1000;
    }
  }
  if (ascii(bytes, offset + 36, 4) === "VBRI" && offset + 36 + 18 <= bytes.length) {
    const frames = view(bytes).getUint32(offset + 36 + 14, false);
    if (frames > 0) return ((frames * first.samples) / first.sampleRate) * 1000;
  }

  let samples = 0;
  let frames = 0;
  while (offset < bytes.length) {
    const frame = mp3Frame(bytes, offset);
    if (!frame) break;
    if (offset + frame.length > bytes.length) break;
    samples += frame.samples;
    frames += 1;
    offset += frame.length;
  }
  // Trailing ID3v1/APE tags may remain; an early break mid-stream means we cannot vouch for the total.
  const trailing = bytes.length - offset;
  if (frames < 2 || trailing > 32 * 1024) return null;
  return (samples / first.sampleRate) * 1000;
}

export function oggDurationMs(bytes: Uint8Array): number | null {
  if (ascii(bytes, 0, 4) !== "OggS" || bytes.length < 28) return null;
  const segments = bytes[26]!;
  const packet = 27 + segments;
  let rate = 0;
  let preSkip = 0;
  if (ascii(bytes, packet, 8) === "OpusHead") {
    rate = 48000;
    preSkip = view(bytes).getUint16(packet + 10, true);
  } else if (bytes[packet] === 1 && ascii(bytes, packet + 1, 6) === "vorbis") {
    rate = view(bytes).getUint32(packet + 12, true);
  }
  if (!rate) return null;
  for (let offset = bytes.length - 14; offset >= 0; offset -= 1) {
    if (bytes[offset] !== 0x4f || ascii(bytes, offset, 4) !== "OggS") continue;
    const granule = view(bytes).getBigInt64(offset + 6, true);
    if (granule <= 0n) return null;
    return ((Number(granule) - preSkip) / rate) * 1000;
  }
  return null;
}

export function flacDurationMs(bytes: Uint8Array): number | null {
  if (ascii(bytes, 0, 4) !== "fLaC" || bytes.length < 4 + 4 + 18) return null;
  if ((bytes[4]! & 0x7f) !== 0) return null;
  const info = 8;
  const sampleRate = (bytes[info + 10]! << 12) | (bytes[info + 11]! << 4) | (bytes[info + 12]! >> 4);
  const high = bytes[info + 13]! & 0x0f;
  const low = view(bytes).getUint32(info + 14, false);
  const total = high * 2 ** 32 + low;
  if (!sampleRate || !total) return null;
  return (total / sampleRate) * 1000;
}
