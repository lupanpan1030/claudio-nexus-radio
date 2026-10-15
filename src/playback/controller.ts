import { asId, type HistoryEntry, type PlaybackCommand, type PlaybackSnapshot, type QueueEntryRequest, type QueueItemId } from "@claudio/contracts";
import type { ReservableIdFactory } from "@claudio/playback-core";
import type { DispatchResult, HostView } from "@claudio/playback-web";
import { upcomingEntries, type RadioRefill } from "./radio-refill";
import { createStatusStore } from "./status-store";
import { voiceControls } from "./voice-model";

export interface ControllerHost {
  getView(): HostView;
  dispatch(command: PlaybackCommand): DispatchResult;
  unlockAudio(): void;
}

/** Services that exist only on the executor page. */
export interface OwnerServices {
  readonly refill: RadioRefill;
  readonly ids: ReservableIdFactory;
}

const PLAYING_INTENT = new Set(["requested", "loading", "playing", "waiting", "exhausted"]);

/**
 * Commands that change what is lined up to play. Pause/resume, seek, volume
 * and voice controls do not make an outstanding answer (chat, radio start) stale.
 */
const INTENT_COMMANDS = new Set<PlaybackCommand["type"]>(["select", "next", "remove", "enqueue", "replace-queue", "stop"]);

/** Explicit transport intents that must keep a pending radio start silent. */
const TRANSPORT_STOPS = new Set<PlaybackCommand["type"]>(["pause", "stop"]);

/** Transport states in which the main button means "pause". */
export function wantsPlayback(snapshot: PlaybackSnapshot | null): boolean {
  return snapshot !== null && PLAYING_INTENT.has(snapshot.transport);
}

/**
 * What the main button (and Space) does now. While a radio start from an
 * empty queue is still choosing or waiting to retry and will play on
 * arrival, it cancels that start; nothing is playing yet, so it is not
 * "pause". `startWillPlay` is the refill status `autoplay`.
 */
export type MainButtonIntent = "pause" | "cancel-start" | "play";

export function mainButtonIntent(snapshot: PlaybackSnapshot | null, startWillPlay: boolean): MainButtonIntent {
  if (wantsPlayback(snapshot)) return "pause";
  return startWillPlay ? "cancel-start" : "play";
}

/**
 * Previous = replay what was confirmed started before, as a new occurrence.
 * Without bookkeeping the newly skipped track becomes the latest history entry
 * and a second press would bounce back to it; the navigator remembers the
 * occurrences it skipped and created until the program moves on by itself.
 */
export class PreviousNavigator {
  private readonly skipped = new Set<QueueItemId>();
  private readonly created = new Set<QueueItemId>();

  observe(snapshot: PlaybackSnapshot | null): void {
    const programId = snapshot?.program?.item.itemId;
    if (!programId) return;
    if (!this.created.has(programId) && !this.skipped.has(programId)) {
      this.skipped.clear();
      this.created.clear();
    }
  }

  target(snapshot: PlaybackSnapshot | null): HistoryEntry | null {
    if (!snapshot) return null;
    const programId = snapshot.program?.item.itemId;
    for (let index = snapshot.history.length - 1; index >= 0; index -= 1) {
      const entry = snapshot.history[index];
      if (!entry || !entry.started) continue;
      const id = entry.item.itemId;
      if (id === programId || this.skipped.has(id) || this.created.has(id)) continue;
      return entry;
    }
    return null;
  }

  commit(snapshot: PlaybackSnapshot, target: HistoryEntry, newItemId: QueueItemId): void {
    if (snapshot.program) this.skipped.add(snapshot.program.item.itemId);
    this.skipped.add(target.item.itemId);
    this.created.add(newItemId);
  }
}

/**
 * The one place user intents become playback commands. `userActionSeq`
 * advances only when the listener changes what is lined up (select, skip,
 * queue edits, stop, starting the radio) — never on pause/resume, seek,
 * volume, voice or clock ticks — so late async answers (chat, radio start)
 * can tell whether they were overtaken. A pending radio start's "play when
 * chosen" is a separate, narrower mark: any pause/stop withdraws it.
 */
export class PlaybackController {
  private readonly seqStore = createStatusStore(0);
  private readonly previousNav = new PreviousNavigator();

  constructor(
    private readonly host: ControllerHost,
    private readonly owner: () => OwnerServices | null
  ) {}

  readonly getUserActionSeq = (): number => this.seqStore.get();
  readonly subscribeUserActionSeq = (listener: () => void): (() => void) => this.seqStore.subscribe(listener);

  /** Feed every published snapshot so Previous resets when the program moves on by itself. */
  observe(snapshot: PlaybackSnapshot | null): void {
    this.previousNav.observe(snapshot);
  }

  canPrevious(snapshot: PlaybackSnapshot | null): boolean {
    return this.previousNav.target(snapshot) !== null;
  }

  /** Main button and Space: pause, cancel a pending radio start, or play (see mainButtonIntent). */
  togglePlay(): void {
    const snapshot = this.snapshot();
    if (!snapshot) return;
    if (mainButtonIntent(snapshot, this.startWillPlay()) === "play") this.play();
    else this.pause();
  }

  /**
   * Idempotent "make it play" (Media Session play). Already playing or a radio
   * start already on its way to playing: nothing changes.
   */
  play(): void {
    const snapshot = this.snapshot();
    if (!snapshot) return;
    this.host.unlockAudio();
    if (wantsPlayback(snapshot) || this.startWillPlay()) return;
    if (snapshot.program || snapshot.queue.length > 0) return void this.user([{ type: "resume" }]);
    this.bumpSeq();
    this.owner()?.refill.startFromEmpty();
  }

  /**
   * Idempotent "make it silent" (Media Session pause). Pauses playback and
   * also withdraws the "play when chosen" of a radio start still selecting,
   * so a late candidate is queued silently instead of starting sound.
   */
  pause(): void {
    const snapshot = this.snapshot();
    if (!snapshot) return;
    if (wantsPlayback(snapshot)) return void this.user([{ type: "pause" }]);
    this.owner()?.refill.cancelStartPlayback();
  }

  next(): void {
    const snapshot = this.snapshot();
    if (!snapshot) return;
    this.host.unlockAudio();
    if (!snapshot.program && upcomingEntries(snapshot).length === 0) {
      this.bumpSeq();
      this.owner()?.refill.startFromEmpty();
      return;
    }
    this.user([{ type: "next" }]);
  }

  previous(): void {
    const snapshot = this.snapshot();
    const owner = this.owner();
    const target = this.previousNav.target(snapshot);
    if (!snapshot || !owner || !target) return;
    this.host.unlockAudio();
    const itemId = asId<QueueItemId>(owner.ids.reserve("item"));
    this.previousNav.commit(snapshot, target, itemId);
    this.user([{ type: "select", target: { kind: "track", entry: { track: target.item.track, display: target.item.display, origin: "user", itemId } } }]);
    // Not claimed (command ignored, e.g. another page took over): give the reservation back.
    owner.ids.release(itemId);
  }

  stop(): void {
    this.user([{ type: "stop" }]);
  }

  /** Seeks the program music; never moves a DJ voice. */
  seek(positionMs: number): void {
    if (!Number.isFinite(positionMs) || positionMs < 0) return;
    this.host.dispatch({ type: "seek", positionMs });
  }

  setVolume(value: number): void {
    this.host.dispatch({ type: "set-volume", channel: "music", value: Math.min(1, Math.max(0, value)) });
  }

  setDjEnabled(enabled: boolean): void {
    this.host.dispatch({ type: "set-dj-enabled", enabled });
  }

  /** Main DJ button: stop the voice while it is active, else replay this song's retained narration. */
  voiceMain(): void {
    const controls = voiceControls(this.snapshot());
    this.host.unlockAudio();
    if (controls.mainAction === "stop") this.host.dispatch({ type: "voice.stop" });
    else if (controls.mainAction === "replay") this.host.dispatch({ type: "voice.replay" });
  }

  /** Voice panel button: pause/resume the voice itself; replays when nothing is active. */
  voicePanel(): void {
    const controls = voiceControls(this.snapshot());
    this.host.unlockAudio();
    if (controls.panelAction === "pause") this.host.dispatch({ type: "voice.pause" });
    else if (controls.panelAction === "resume") this.host.dispatch({ type: "voice.resume" });
    else if (controls.panelAction === "replay") this.host.dispatch({ type: "voice.replay" });
  }

  /**
   * A row already in the queue plays now as that same occurrence: its item id,
   * origin and any media already prepared for it are kept, and every other
   * row stays queued. Like any manual move it drops the pending DJ cue.
   */
  selectItem(itemId: QueueItemId): void {
    this.host.unlockAudio();
    this.user([{ type: "select", target: { kind: "item", itemId } }]);
  }

  /** Plays one track now as a new occurrence, keeping the rest of the queue. */
  playTrack(entry: QueueEntryRequest): void {
    this.host.unlockAudio();
    this.user([{ type: "select", target: { kind: "track", entry } }]);
  }

  /** Applies a planned multi-step intent (e.g. a chat reply) as one user action. */
  apply(commands: readonly PlaybackCommand[], options: { readonly gesture: boolean }): void {
    if (commands.length === 0) return;
    if (options.gesture) this.host.unlockAudio();
    this.user(commands);
  }

  private startWillPlay(): boolean {
    return this.owner()?.refill.getStatus().autoplay === true;
  }

  private snapshot(): PlaybackSnapshot | null {
    const view = this.host.getView();
    return view.canControl ? view.snapshot : null;
  }

  private bumpSeq(): void {
    this.seqStore.set(this.seqStore.get() + 1);
  }

  private user(commands: readonly PlaybackCommand[]): void {
    if (!this.host.getView().canControl) return;
    if (commands.some((command) => INTENT_COMMANDS.has(command.type))) this.bumpSeq();
    // Pause/stop withdraw a pending radio start's autoplay without making chat answers stale.
    if (commands.some((command) => TRANSPORT_STOPS.has(command.type))) this.owner()?.refill.cancelStartPlayback();
    for (const command of commands) this.host.dispatch(command);
  }
}
