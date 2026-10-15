import type { ClockReader, HostView } from "@claudio/playback-web";
import { useDisplayedPosition, useVoicePosition } from "../app/hooks";
import { activeLyricIndex, activeSegmentIndex, subtitleLines } from "../playback/subtitles";

/**
 * The single subtitle line under the track title: the current lyric line of
 * the displayed recording, or the DJ's current sentence while the DJ is the
 * program output. Without trustworthy timing it shows nothing (lyrics) or
 * the opening of the script (DJ) — never an estimated position.
 */
export function LiveCaption({ view, live }: { readonly view: HostView; readonly live: ClockReader | null }) {
  const display = view.snapshot?.display;
  const position = useDisplayedPosition(view, live, display?.kind === "music");
  const voicePosition = useVoicePosition(view, live, display?.kind === "voice");
  let text: string | null = null;
  if (display?.kind === "music" && display.lyrics.status === "available" && position !== null) {
    const index = activeLyricIndex(display.lyrics.asset, position);
    text = index >= 0 ? (display.lyrics.asset.lines[index]?.text ?? null) : null;
  } else if (display?.kind === "voice") {
    const lines = subtitleLines(display.subtitle, display.text);
    const index = voicePosition !== null ? activeSegmentIndex(display.subtitle, voicePosition) : -1;
    text = index >= 0 ? (lines[index] ?? null) : (lines[0] ?? null);
  }
  if (!text) return null;
  return <small className="program-subtitle">{text}</small>;
}
