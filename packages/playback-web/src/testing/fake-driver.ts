import type { CueId, DeckId, LoadId, MediaEvent, VoiceLoadId } from "@claudio/contracts";
import { performanceClock, type RuntimeClock } from "../ports.js";
import { SILENT_SPECTRUM, type ClockReading, type DeckClock, type DriverEffect, type MediaFact, type PlaybackDriver, type SpectrumReader, type VoiceClock } from "../driver/types.js";

interface FakeChannel {
  positionMs: number;
  rate: number;
  observedAt: number;
  state: DeckClock["state"];
}

/**
 * Non-browser executor used by tests and by UI work without audio: it keeps
 * the same identities as the real driver and lets a test report media
 * observations for the current deck/voice loads. It owns no media.
 */
export class FakeDriver implements PlaybackDriver {
  readonly executed: DriverEffect[] = [];
  readonly spectrum: SpectrumReader = SILENT_SPECTRUM;
  private sink: ((fact: MediaFact) => void) | null = null;
  readonly decks: { A: ({ loadId: LoadId } & FakeChannel) | null; B: ({ loadId: LoadId } & FakeChannel) | null } = { A: null, B: null };
  voice: ({ cueId: CueId; voiceLoadId: VoiceLoadId } & FakeChannel) | null = null;
  unlocked = 0;
  disposed = false;

  constructor(private readonly clock: RuntimeClock = performanceClock) {}

  connect(sink: (fact: MediaFact) => void): void {
    this.sink = sink;
  }

  execute(effect: DriverEffect): void {
    if (this.disposed) return;
    this.executed.push(effect);
    const now = this.clock();
    switch (effect.type) {
      case "deck.load":
        this.decks[effect.deck] = { loadId: effect.loadId, positionMs: effect.startAtMs, rate: 0, observedAt: now, state: "loading" };
        return;
      case "deck.unload":
        if (this.decks[effect.deck]?.loadId === effect.loadId) this.decks[effect.deck] = null;
        return;
      case "voice.load":
        this.voice = { cueId: effect.cueId, voiceLoadId: effect.voiceLoadId, positionMs: 0, rate: 0, observedAt: now, state: "loading" };
        return;
      case "voice.stop":
        if (this.voice?.voiceLoadId === effect.voiceLoadId) this.voice = null;
        return;
      default:
        return;
    }
  }

  readClock(): ClockReading {
    const now = this.clock();
    const deck = (id: DeckId): DeckClock | null => {
      const channel = this.decks[id];
      return channel ? { deck: id, loadId: channel.loadId, positionMs: channel.positionMs + (now - channel.observedAt) * channel.rate, rate: channel.rate, observedAt: now, state: channel.state } : null;
    };
    const voice = this.voice;
    const voiceClock: VoiceClock | null = voice
      ? { cueId: voice.cueId, voiceLoadId: voice.voiceLoadId, positionMs: voice.positionMs + (now - voice.observedAt) * voice.rate, rate: voice.rate, observedAt: now, state: voice.state }
      : null;
    return { at: now, source: "media-element", decks: { A: deck("A"), B: deck("B") }, voice: voiceClock };
  }

  unlock(): void {
    this.unlocked += 1;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.sink = null;
    this.decks.A = null;
    this.decks.B = null;
    this.voice = null;
  }

  /** Effects of a type executed so far. */
  effects<T extends DriverEffect["type"]>(type: T): Extract<DriverEffect, { type: T }>[] {
    return this.executed.filter((effect): effect is Extract<DriverEffect, { type: T }> => effect.type === type);
  }

  /** Report an observation for the deck's current load (or an explicit, possibly stale, load). */
  deckEvent(deck: DeckId, event: MediaEvent, loadId?: LoadId): void {
    const current = this.decks[deck];
    const id = loadId ?? current?.loadId;
    if (!id) throw new Error(`deck ${deck} has no load`);
    if (current && current.loadId === id) this.track(current, event);
    this.sink?.({ type: "deck.media", deck, loadId: id, event });
  }

  voiceEvent(event: MediaEvent): void {
    const voice = this.voice;
    if (!voice) throw new Error("no voice load");
    this.track(voice, event);
    this.sink?.({ type: "voice.media", cueId: voice.cueId, voiceLoadId: voice.voiceLoadId, event });
  }

  deckOf(loadId: LoadId): DeckId | null {
    if (this.decks.A?.loadId === loadId) return "A";
    if (this.decks.B?.loadId === loadId) return "B";
    return null;
  }

  private track(channel: FakeChannel, event: MediaEvent): void {
    const now = this.clock();
    const at = (positionMs: number, rate: number, state: FakeChannel["state"]) => Object.assign(channel, { positionMs, rate, observedAt: now, state });
    switch (event.kind) {
      case "playing":
        at(event.positionMs, 1, "playing");
        return;
      case "waiting":
        at(event.positionMs, 0, "waiting");
        return;
      case "paused":
        at(event.positionMs, 0, "paused");
        return;
      case "ended":
        channel.rate = 0;
        channel.state = "ended";
        return;
      default:
        return;
    }
  }
}
