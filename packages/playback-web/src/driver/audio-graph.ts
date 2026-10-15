// Mixer topology and gain scheduling adapted from Aurio `web/src/lib/audioGraph.ts`
// (MIT, Copyright (c) 2026 Aurio contributors), commit
// 959fd7743d8d2cef142141f1b4be65c8b91bb1dc. See packages/playback-web/NOTICE.md
// for the license text and the list of modifications. In short: no module
// singleton or one-shot `initTried`, sources attach/detach per load instead of
// tapping three fixed elements, the music bus carries the user volume (ducking
// is per-deck and comes from core effects), the voice booth chain and UI sounds
// are dropped, and the optional limiter is a soft safety net, not a promise of
// clip-free output.
//
//   deck A source ─> channel[A] ─┐
//                                 ├─> musicBus (user music volume) ─> musicAnalyser ─┐
//   deck B source ─> channel[B] ─┘                                                    ├─> master (mute) ─> [limiter] ─> [tap] ─> destination
//   voice source ──> voiceBus (user voice volume) ──────────────────> voiceAnalyser ─┘
//
// channel[X] holds the core's transition multiplier for that deck, so a duck
// or crossfade multiplies with the user's latest volume instead of replacing it.

import type { DeckId } from "@claudio/contracts";

const CURVE_POINTS = 33;
const VOLUME_TAU_SECONDS = 0.015;

export interface MixerGraphOptions {
  /** Test seam inserted between master and destination (e.g. a PCM meter). */
  readonly tap?: AudioNode | null;
  /** Optional soft limiter on the master bus. Reduces, but does not guarantee against, clipping. */
  readonly safetyLimiter?: boolean;
}

export class MixerGraph {
  private readonly channels: Record<DeckId, GainNode>;
  private readonly musicBus: GainNode;
  private readonly voiceBus: GainNode;
  private readonly master: GainNode;
  private readonly musicAnalyser: AnalyserNode;
  private readonly voiceAnalyser: AnalyserNode;
  private readonly limiter: DynamicsCompressorNode | null;
  private readonly voiceTime = new Uint8Array(256);
  private closed = false;

  constructor(
    readonly context: AudioContext,
    private readonly options: MixerGraphOptions = {}
  ) {
    const ac = context;
    this.channels = { A: ac.createGain(), B: ac.createGain() };
    this.channels.A.gain.value = 0;
    this.channels.B.gain.value = 0;
    this.musicBus = ac.createGain();
    this.voiceBus = ac.createGain();
    this.master = ac.createGain();
    this.musicAnalyser = ac.createAnalyser();
    this.musicAnalyser.fftSize = 256;
    this.musicAnalyser.smoothingTimeConstant = 0.78;
    this.voiceAnalyser = ac.createAnalyser();
    this.voiceAnalyser.fftSize = 256;
    this.voiceAnalyser.smoothingTimeConstant = 0.6;

    this.channels.A.connect(this.musicBus);
    this.channels.B.connect(this.musicBus);
    this.musicBus.connect(this.musicAnalyser);
    this.musicAnalyser.connect(this.master);
    this.voiceBus.connect(this.voiceAnalyser);
    this.voiceAnalyser.connect(this.master);

    let tail: AudioNode = this.master;
    this.limiter = options.safetyLimiter ? ac.createDynamicsCompressor() : null;
    if (this.limiter) {
      this.limiter.threshold.value = -1;
      this.limiter.knee.value = 0;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.001;
      this.limiter.release.value = 0.25;
      tail.connect(this.limiter);
      tail = this.limiter;
    }
    if (options.tap) {
      tail.connect(options.tap);
      tail = options.tap;
    }
    tail.connect(ac.destination);
  }

  /** Input node a deck's media source connects to. */
  deckInput(deck: DeckId): AudioNode {
    return this.channels[deck];
  }

  voiceInput(): AudioNode {
    return this.voiceBus;
  }

  /**
   * Move a deck's transition multiplier to `target` over `rampMs`. Any
   * in-flight fade is cancelled and re-anchored at the current value so an
   * interrupted fade never snaps; fades use Aurio's equal-power shapes
   * (cos out / sin in), so two decks faded together keep summed power flat.
   */
  setDeckGain(deck: DeckId, target: number, rampMs: number): void {
    if (this.closed) return;
    const value = clamp01(target);
    const param = this.channels[deck].gain;
    const now = this.context.currentTime;
    const seconds = Math.max(0, rampMs) / 1000;
    const v0 = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(v0, now);
    if (seconds <= 0.02 || Math.abs(v0 - value) < 1e-4) {
      param.setValueAtTime(value, now);
      return;
    }
    const shape = value < v0 ? (t: number) => value + (v0 - value) * Math.cos((t * Math.PI) / 2) : (t: number) => v0 + (value - v0) * Math.sin((t * Math.PI) / 2);
    const curve = new Float32Array(CURVE_POINTS);
    for (let i = 0; i < CURVE_POINTS; i++) curve[i] = Math.max(0, shape(i / (CURVE_POINTS - 1)));
    curve[0] = v0;
    curve[CURVE_POINTS - 1] = value;
    try {
      // Start a few ms out so the curve never collides with the anchor event.
      param.setValueCurveAtTime(curve, now + 0.006, seconds - 0.006);
    } catch {
      param.linearRampToValueAtTime(value, now + seconds);
    }
  }

  /** Cancel pending automation on a deck and hold its current value (pause semantics). */
  holdDeckGain(deck: DeckId): void {
    if (this.closed) return;
    const param = this.channels[deck].gain;
    const now = this.context.currentTime;
    const v0 = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(v0, now);
  }

  /** Current (rendered) multiplier of a deck; diagnostic only. */
  deckGain(deck: DeckId): number {
    return this.channels[deck].gain.value;
  }

  setMusicVolume(volume: number): void {
    this.glide(this.musicBus.gain, clamp01(volume));
  }

  setVoiceVolume(volume: number): void {
    this.glide(this.voiceBus.gain, clamp01(volume));
  }

  setMuted(muted: boolean): void {
    this.glide(this.master.gain, muted ? 0 : 1);
  }

  readMusic(target: Uint8Array): number {
    if (this.closed) return 0;
    const bins = Math.min(target.length, this.musicAnalyser.frequencyBinCount);
    const view = target.length === bins ? target : target.subarray(0, bins);
    this.musicAnalyser.getByteFrequencyData(view as Uint8Array<ArrayBuffer>);
    return bins;
  }

  readVoice(target: Uint8Array): number {
    if (this.closed) return 0;
    const bins = Math.min(target.length, this.voiceAnalyser.frequencyBinCount);
    const view = target.length === bins ? target : target.subarray(0, bins);
    this.voiceAnalyser.getByteFrequencyData(view as Uint8Array<ArrayBuffer>);
    return bins;
  }

  voiceLevel(): number {
    if (this.closed) return 0;
    this.voiceAnalyser.getByteTimeDomainData(this.voiceTime as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (const byte of this.voiceTime) {
      const v = (byte - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.voiceTime.length) * 2);
  }

  /** Disconnect every node and close the context. A new graph needs a new context and new elements. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const node of [this.channels.A, this.channels.B, this.musicBus, this.voiceBus, this.musicAnalyser, this.voiceAnalyser, this.master, this.limiter, this.options.tap ?? null]) {
      try {
        node?.disconnect();
      } catch {
        // already disconnected
      }
    }
    if (this.context.state !== "closed") await this.context.close().catch(() => {});
  }

  // Cancel any in-flight change, re-anchor at the current value, then glide
  // (Aurio's `ramp`): volume changes compose with fades instead of fighting them.
  private glide(param: AudioParam, target: number): void {
    if (this.closed) return;
    const now = this.context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(target, now, VOLUME_TAU_SECONDS);
  }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
