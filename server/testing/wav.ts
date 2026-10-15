/** Deterministic PCM WAV fixture (16-bit mono). `seed` changes the samples, so content hashes differ. */
export function makeWav(durationMs: number, options: { sampleRate?: number; seed?: number } = {}): Uint8Array {
  const sampleRate = options.sampleRate ?? 8000;
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const dataBytes = samples * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  const seed = options.seed ?? 1;
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(44 + index * 2, Math.round(Math.sin((index * seed) / 7) * 1000), true);
  }
  return new Uint8Array(buffer);
}
