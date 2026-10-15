import { useEffect } from "react";
import type { HostView } from "@claudio/playback-web";
import type { PlaybackController } from "../playback/controller";
import { wantsPlayback } from "../playback/controller";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON";
}

/**
 * Media keys (Media Session) and the Space shortcut, registered only on the
 * executor page and mapped to the same controller as the buttons. Typing in
 * inputs is never intercepted; handlers are cleared on unmount/role change.
 */
export function useMediaControls(controller: PlaybackController | null, view: HostView) {
  const canControl = view.canControl && controller !== null;
  const program = view.snapshot?.program?.item.display ?? null;
  const playing = wantsPlayback(view.snapshot);

  useEffect(() => {
    if (!canControl || !controller) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.code !== "Space" || isTypingTarget(event.target)) return;
      event.preventDefault();
      controller.togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canControl, controller]);

  useEffect(() => {
    const session = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
    if (!session || !canControl || !controller) return;
    const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => controller.togglePlay()],
      ["pause", () => controller.togglePlay()],
      ["nexttrack", () => controller.next()],
      ["previoustrack", () => controller.previous()]
    ];
    for (const [action, handler] of actions) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Unsupported action in this browser.
      }
    }
    return () => {
      for (const [action] of actions) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Ignore.
        }
      }
    };
  }, [canControl, controller]);

  useEffect(() => {
    const session = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
    if (!session || !canControl) return;
    session.metadata = program && typeof MediaMetadata !== "undefined" ? new MediaMetadata({ title: program.title, artist: program.artist, album: program.album ?? "Claudio Radio" }) : null;
    session.playbackState = program ? (playing ? "playing" : "paused") : "none";
  }, [canControl, playing, program]);
}
