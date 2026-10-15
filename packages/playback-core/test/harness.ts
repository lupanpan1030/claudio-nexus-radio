import {
  asId,
  type CueAsset,
  type DeckId,
  type LoadId,
  type MediaEvent,
  type PlaybackCommand,
  type PlaybackEffect,
  type PlaybackFact,
  type QueueItemId,
  type ResolvedMedia,
  type TrackRef
} from "@claudio/contracts";
import { createInitialState, createSequentialIds, step, toSnapshot, type CoreConfig, type PlaybackState, type StepResult } from "../src/index.js";

export function track(name: string, providerId = "fixture"): TrackRef {
  return { providerId: asId(providerId), mediaId: asId(name) };
}

export function media(
  ref: TrackRef,
  options: { recording?: string; revision?: string; durationMs?: number | null; expiresAt?: number | null; seekable?: boolean } = {}
): ResolvedMedia {
  const durationMs = options.durationMs === undefined ? 200_000 : options.durationMs;
  return {
    track: ref,
    recording: { recordingId: asId(options.recording ?? `rec-${ref.mediaId}`), confidence: "provider-asserted" },
    sourceRevision: asId(options.revision ?? `rev-${ref.mediaId}-1`),
    stream: { handle: asId(`handle-${ref.mediaId}-${options.revision ?? 1}`), expiresAt: options.expiresAt ?? null },
    duration: durationMs === null ? { kind: "unknown" } : { kind: "known", ms: durationMs, source: "provider-metadata" },
    capabilities: { seekable: options.seekable ?? true, rangeRequests: true }
  };
}

export function cueAsset(text = "接下来这首歌", durationMs: number | null = 4000): CueAsset {
  return {
    script: {
      assetId: asId("script-1"),
      version: 1,
      text,
      subtitle: { timing: "plain-text", segments: [{ text }] }
    },
    voice: {
      assetId: asId("voice-1"),
      scriptAssetId: asId("script-1"),
      stream: { handle: asId("voice-handle-1"), expiresAt: null },
      duration: durationMs === null ? { kind: "unknown" } : { kind: "known", ms: durationMs, source: "decoded" },
      playbackRate: 1
    }
  };
}

type EffectOf<T extends PlaybackEffect["type"]> = Extract<PlaybackEffect, { type: T }>;

/**
 * Scripted fake runtime: feeds commands/facts into the pure core with an
 * injected clock and id factory, and records every effect for assertions.
 */
export class Sim {
  state: PlaybackState;
  now = 1_000;
  readonly ids = createSequentialIds("t");
  readonly log: PlaybackEffect[] = [];
  last: StepResult | null = null;

  constructor(config: Partial<CoreConfig> = {}, settings: { djEnabled?: boolean } = {}) {
    this.state = createInitialState({ config, settings });
  }

  get snap() {
    return toSnapshot(this.state);
  }

  tick(ms: number): this {
    this.now += ms;
    return this;
  }

  private apply(result: StepResult): StepResult {
    this.state = result.state;
    this.log.push(...result.effects);
    this.last = result;
    return result;
  }

  cmd(command: PlaybackCommand): StepResult {
    return this.apply(step(this.state, { kind: "command", command }, { now: this.now, ids: this.ids }));
  }

  fact(fact: PlaybackFact): StepResult {
    return this.apply(step(this.state, { kind: "fact", fact }, { now: this.now, ids: this.ids }));
  }

  /** Effects emitted since `mark` (an index into log). */
  since(mark: number): PlaybackEffect[] {
    return this.log.slice(mark);
  }

  mark(): number {
    return this.log.length;
  }

  effects<T extends PlaybackEffect["type"]>(type: T, from = 0): EffectOf<T>[] {
    return this.log.slice(from).filter((effect): effect is EffectOf<T> => effect.type === type);
  }

  lastEffect<T extends PlaybackEffect["type"]>(type: T, predicate: (effect: EffectOf<T>) => boolean = () => true): EffectOf<T> {
    const found = this.effects(type).filter(predicate).at(-1);
    if (!found) throw new Error(`no ${type} effect matching predicate`);
    return found;
  }

  itemIdAt(index: number): QueueItemId {
    const entry = this.snap.queue[index];
    if (!entry) throw new Error(`no queue entry ${index}`);
    return entry.item.itemId;
  }

  enqueue(...names: string[]): QueueItemId[] {
    const before = new Set(this.snap.queue.map((entry) => entry.item.itemId));
    this.cmd({
      type: "enqueue",
      position: "end",
      entries: names.map((name) => ({ track: track(name), display: { title: name, artist: "fixture" }, origin: "user" as const }))
    });
    return this.snap.queue.map((entry) => entry.item.itemId).filter((id) => !before.has(id));
  }

  /** Answer the latest prepare.start for an item. */
  resolve(itemId: QueueItemId, override?: Partial<Parameters<typeof media>[1]>): StepResult {
    const request = this.lastEffect("prepare.start", (effect) => effect.itemId === itemId);
    return this.fact({ type: "prepare.resolved", opId: request.opId, itemId, media: media(request.track, override) });
  }

  loadOf(itemId: QueueItemId): { deck: DeckId; loadId: LoadId } {
    const load = this.lastEffect("deck.load", (effect) => effect.itemId === itemId);
    return { deck: load.deck, loadId: load.loadId };
  }

  deck(itemId: QueueItemId, event: MediaEvent): StepResult {
    const { deck, loadId } = this.loadOf(itemId);
    return this.fact({ type: "deck.media", deck, loadId, event });
  }

  /** Resolve, load and confirm playing for the program item. */
  startProgram(itemId: QueueItemId, positionMs = 0): void {
    this.resolve(itemId);
    this.deck(itemId, { kind: "can-play", through: false });
    this.deck(itemId, { kind: "playing", positionMs });
  }

  /** Deliver the asset for the current cue; by default the voice element also reports can-play. */
  cueReady(asset: CueAsset = cueAsset(), options: { playable?: boolean } = {}): StepResult {
    const request = this.lastEffect("cue.request");
    const result = this.fact({
      type: "cue.ready",
      opId: request.opId,
      cueId: request.binding.cueId,
      transitionId: request.binding.transitionId,
      asset
    });
    return options.playable === false ? result : this.voice({ kind: "can-play", through: true });
  }

  voice(event: MediaEvent): StepResult {
    const load = this.lastEffect("voice.load");
    return this.fact({ type: "voice.media", cueId: load.cueId, voiceLoadId: load.voiceLoadId, event });
  }

  receipts(): EffectOf<"receipt.report">[] {
    return this.effects("receipt.report");
  }
}
