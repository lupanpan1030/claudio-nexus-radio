/**
 * Voice-panel spectrum shaping, unchanged from the previous Player: local
 * frequency detail plus song-level phrase/beat energy, octave projection,
 * per-zone contrast and short peak holds. It only draws what the driver's
 * analyser reports; silence or no data yields flat bars, never a fake wave.
 */
export const WAVE_BARS = 92;

export interface WaveMemory {
  previousSongEnergy: number;
  phraseEnergy: number;
  beatPulse: number;
  peakHolds: number[];
}

export function createWaveMemory(): WaveMemory {
  return { previousSongEnergy: 0, phraseEnergy: 0, beatPulse: 0, peakHolds: Array(WAVE_BARS).fill(0) };
}

export function shapeWave(samples: Uint8Array, binCount: number, memory: WaveMemory, previous: readonly number[]): number[] {
  if (binCount <= 2) return Array(WAVE_BARS).fill(0);
  let sum = 0;
  for (let index = 2; index < binCount; index += 1) sum += samples[index] ?? 0;
  const songEnergy = sum / ((binCount - 2) * 255);
  memory.phraseEnergy += (songEnergy - memory.phraseEnergy) * (songEnergy > memory.phraseEnergy ? 0.18 : 0.06);
  memory.beatPulse = Math.max(memory.beatPulse * 0.74, Math.max(0, songEnergy - memory.previousSongEnergy) * 5.5);
  memory.previousSongEnergy = songEnergy;
  const { phraseEnergy, beatPulse } = memory;
  const performanceEnergy = phraseEnergy * 0.12 + beatPulse * 0.12;
  // Keep every bar inside the musical spectrum; the top ultrasonic bins are usually silent.
  const spectralCeiling = Math.floor(binCount * 0.42);
  const rawLevels = Array.from({ length: WAVE_BARS }, (_, index) => {
    const bandStart = Math.floor(2 + (spectralCeiling - 2) * Math.pow(index / 91, 0.74));
    const bandEnd = Math.max(bandStart + 1, Math.floor(2 + (spectralCeiling - 2) * Math.pow((index + 1) / 92, 0.74)));
    let band = 0;
    for (let bin = bandStart; bin <= bandEnd; bin += 1) band += samples[bin] ?? 0;
    const localEnergy = band / ((bandEnd - bandStart + 1) * 255);
    const contrastEnergy = Math.max(0, localEnergy - songEnergy * 0.3);
    return Math.min(1, Math.pow(localEnergy * 0.76 + contrastEnergy * 0.38 + performanceEnergy, 0.78) * 1.16);
  });
  // Project octave-related detail into the display so sparse arrangements keep a full sound field.
  const projectedLevels = rawLevels.map((level, index) => {
    const harmonicWeight = index / 91;
    const lowerHarmonic = rawLevels[Math.floor(index * 0.58)] ?? level;
    const bassHarmonic = rawLevels[Math.floor(index * 0.24)] ?? level;
    return level * (1 - harmonicWeight * 0.3) + lowerHarmonic * harmonicWeight * 0.22 + bassHarmonic * harmonicWeight * 0.1;
  });
  const zoneSize = Math.ceil(projectedLevels.length / 3);
  const zoneLevels = projectedLevels.map((level, index) => {
    const zoneStart = Math.floor(index / zoneSize) * zoneSize;
    const zoneEnd = Math.min(projectedLevels.length, zoneStart + zoneSize);
    const zoneFloor = Math.min(...projectedLevels.slice(zoneStart, zoneEnd));
    const zonePeak = Math.max(...projectedLevels.slice(zoneStart, zoneEnd));
    // Preserve quiet high-frequency movement without amplifying a silent band into noise.
    const zoneRange = Math.max(0.025, zonePeak * 0.32, zonePeak - zoneFloor);
    return (level - zoneFloor) / zoneRange;
  });
  const localPeaks = zoneLevels.map((level, index) => {
    let surroundingEnergy = 0;
    let surroundingCount = 0;
    for (let offset = -3; offset <= 3; offset += 1) {
      const neighbour = zoneLevels[index + offset];
      if (offset === 0 || neighbour === undefined) continue;
      surroundingEnergy += neighbour;
      surroundingCount += 1;
    }
    return Math.max(0, level - surroundingEnergy / surroundingCount);
  });
  const peakIntensity = 0.58 + phraseEnergy * 0.92 + beatPulse * 0.5;
  const shapedLevels = zoneLevels.map((level, index) => {
    const localPeak = localPeaks[index] ?? 0;
    const nearbyPeak = Math.max(localPeaks[index - 1] ?? 0, localPeaks[index + 1] ?? 0);
    // A brief release makes actual peaks readable as musical phrases instead of one-frame noise.
    const hold = memory.peakHolds[index] ?? 0;
    const retainedPeak = Math.max(0, hold * 0.78 - localPeak);
    memory.peakHolds[index] = Math.max(localPeak, hold * 0.78);
    return Math.min(1, level + localPeak * peakIntensity + retainedPeak * peakIntensity + nearbyPeak * peakIntensity * 0.22);
  });
  const phraseLift = Math.min(0.34, phraseEnergy * 0.52 + beatPulse * 0.16);
  return shapedLevels.map((level, index) => {
    const target = Math.min(1, phraseLift + level * (0.38 + phraseEnergy * 0.38 + beatPulse * 0.16));
    const previousLevel = previous[index] ?? 0;
    return previousLevel + (target - previousLevel) * (target > previousLevel ? 0.48 : 0.18);
  });
}

export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
