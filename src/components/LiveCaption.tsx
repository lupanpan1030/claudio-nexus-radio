import type { SubtitleTrack, TimingProvenance } from "@claudio/contracts";
import type { ClockReader, HostView } from "@claudio/playback-web";
import { useDisplayedPosition, useVoicePosition } from "../app/hooks";
import { activeLyricIndex, activeSegmentIndex, PROVENANCE_LABEL, scriptText } from "../playback/subtitles";

/**
 * The single subtitle line under the track title: the current lyric line of
 * the displayed recording, or the DJ's current sentence while the DJ is the
 * program output. DJ sentences follow the voice clock only (never the song's
 * position). Estimated sentence times carry a visible 估算 badge. Without
 * any timing the whole script is shown on one truncated line (its title and
 * the voice panel show all of it) — never its first sentence posing as the
 * current one.
 */
export function LiveCaption({ view, live, onOpen }: { readonly view: HostView; readonly live: ClockReader | null; readonly onOpen?: () => void }) {
  const display = view.snapshot?.display;
  const position = useDisplayedPosition(view, live, display?.kind === "music");
  const voicePosition = useVoicePosition(view, live, display?.kind === "voice");
  if (display?.kind === "music") {
    if (display.lyrics.status !== "available" || position === null) return null;
    const index = activeLyricIndex(display.lyrics.asset, position);
    const text = index >= 0 ? (display.lyrics.asset.lines[index]?.text ?? null) : null;
    return text ? <small className="program-subtitle">{text}</small> : null;
  }
  if (display?.kind !== "voice") return null;
  const caption = <VoiceCaption subtitle={display.subtitle} text={display.text} positionMs={voicePosition} />;
  if (!onOpen || !scriptText(display.subtitle, display.text)) return caption;
  return (
    <button type="button" className="caption-open" onClick={onOpen} title="查看口播全文">
      {caption}
    </button>
  );
}

export function VoiceCaption({ subtitle, text, positionMs }: { readonly subtitle: SubtitleTrack | null; readonly text: string | null; readonly positionMs: number | null }) {
  const timing: TimingProvenance = subtitle?.timing ?? "plain-text";
  const index = positionMs !== null ? activeSegmentIndex(subtitle, positionMs) : -1;
  const sentence = index >= 0 ? subtitle?.segments[index]?.text : undefined;
  if (sentence) {
    return (
      <small className="program-subtitle" data-timing={timing}>
        {timing === "estimated" && (
          <span className="caption-badge" title={PROVENANCE_LABEL.estimated} aria-label={PROVENANCE_LABEL.estimated}>
            估算
          </span>
        )}
        <span className="caption-text">{sentence}</span>
      </small>
    );
  }
  const whole = scriptText(subtitle, text);
  if (!whole) return null;
  return (
    <small className="program-subtitle is-whole" data-timing={timing} title={whole}>
      <span className="caption-text">{whole}</span>
    </small>
  );
}
