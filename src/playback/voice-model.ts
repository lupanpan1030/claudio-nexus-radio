import type { NarrationReplayBlock, PlaybackSnapshot, SubtitleTrack } from "@claudio/contracts";

export type VoiceMainAction = "stop" | "replay";
export type VoicePanelAction = "pause" | "resume" | "replay";

export interface VoiceControls {
  /** A voice is in the channel (starting, speaking, buffering or paused). */
  readonly active: boolean;
  readonly speaking: boolean;
  readonly origin: "transition" | "manual" | null;
  /** Paused by the listener from the voice panel (survives a global pause/resume). */
  readonly userPaused: boolean;
  /** Main DJ button: stop while active, replay the current song's retained narration otherwise. */
  readonly mainAction: VoiceMainAction | null;
  readonly panelAction: VoicePanelAction | null;
  /** Text and subtitles to show in the panel: the live voice, else the retained narration. */
  readonly text: string | null;
  readonly subtitle: SubtitleTrack | null;
  /** True while a cue is being written/synthesized (nothing audible yet). */
  readonly preparing: boolean;
  /** Why replay is unavailable (from the core), for an honest disabled title. */
  readonly replayBlock: NarrationReplayBlock | null;
}

const ACTIVE = new Set(["starting", "speaking", "waiting", "paused"]);

/**
 * Pure mapping from the snapshot to the two voice controls. Never invents an
 * asset: replay is offered only when the core says this song's retained
 * narration is replayable (not expired, same recording, nothing else speaking).
 */
export function voiceControls(snapshot: PlaybackSnapshot | null): VoiceControls {
  const voice = snapshot?.voice ?? null;
  const retained = snapshot?.narration.retained ?? null;
  const replay = snapshot?.narration.replay ?? null;
  const active = voice !== null && ACTIVE.has(voice.status);
  const replayable = replay?.available === true && retained !== null;
  const userPaused = active && voice?.status === "paused" && voice.pausedBy === "user";
  const mainAction: VoiceMainAction | null = active ? "stop" : replayable ? "replay" : null;
  const panelAction: VoicePanelAction | null = active
    ? voice?.status === "paused"
      ? "resume"
      : "pause"
    : replayable
      ? "replay"
      : null;
  return {
    active,
    speaking: voice?.status === "speaking",
    origin: voice?.origin ?? null,
    userPaused,
    mainAction,
    panelAction,
    text: active ? (voice?.scriptText ?? null) : (retained?.scriptText ?? null),
    subtitle: active ? (voice?.subtitle ?? null) : (retained?.subtitle ?? null),
    preparing: voice !== null && voice.status === "requested",
    replayBlock: replay && !replay.available ? replay.reason : null
  };
}
