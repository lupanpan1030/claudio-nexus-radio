import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { HostView, ClockReader } from "@claudio/playback-web";
import { useDisplayedPosition, useTicker, useVoicePosition } from "../app/hooks";
import { displayedMusicSample } from "../playback/clock";
import { activeLyricIndex, activeSegmentIndex, lyricsStatusText, PROVENANCE_LABEL, subtitleLines } from "../playback/subtitles";
import { loadFoliaStage } from "./folia-loader";
import { toFoliaInput } from "./folia-input";
import type { FoliaPin } from "./folia-types";
import pinJson from "./folia-stage.pin.json";
import { FoliaStageController, type StageState } from "./stage-controller";
import { pageClock } from "../playback/clock";
import "./LyricsPanel.css";

const pin = pinJson as FoliaPin;
const OFF: StageState = { phase: "off", reason: null, drawing: false };

const loadPinnedStage = () =>
  loadFoliaStage(pin, {
    fetchFn: (input, init) => fetch(input, init),
    importModule: (url) => import(/* @vite-ignore */ url)
  });

/**
 * Song lyrics for the displayed music plus, while the DJ is the program
 * output, Claudio's own DJ subtitle. The optional Folia stage only draws
 * timed lyrics; Claudio's basic lyrics stay underneath as the honest
 * fallback for loading/missing/unmatched/plain text and for any stage failure.
 */
export function LyricsPanel(props: {
  readonly view: HostView;
  readonly live: ClockReader | null;
  readonly visible: boolean;
  readonly stageEnabled: boolean;
  /** Seek counter of the executor page (0 on observers). */
  readonly seekEpoch: number;
  readonly onStageToggle: (enabled: boolean) => void;
}) {
  const { view, live, visible, stageEnabled } = props;
  const snapshot = view.snapshot;
  const display = snapshot?.display ?? { kind: "none" as const };
  const position = useDisplayedPosition(view, live, visible);
  const voicePosition = useVoicePosition(view, live, visible && display.kind === "voice");
  const lyrics = display.kind === "music" ? display.lyrics : null;
  const asset = lyrics?.status === "available" ? lyrics.asset : null;
  const active = asset && position !== null ? activeLyricIndex(asset, position) : -1;
  const activeRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    if (visible && active >= 0) activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active, visible]);

  const stageHost = useRef<HTMLDivElement | null>(null);
  const controller = useMemo(() => (stageEnabled ? new FoliaStageController(loadPinnedStage, { now: pageClock, appearance: { fontStyle: "sans", subtitle: "none" } }) : null), [stageEnabled]);
  const stageState = useSyncExternalStore(controller ? controller.state.subscribe : noopSubscribe, controller ? controller.state.get : () => OFF, () => OFF);

  useEffect(() => {
    if (!controller || !stageHost.current) return;
    controller.attach(stageHost.current);
    return () => controller.detach();
  }, [controller]);

  useEffect(() => controller?.setVisible(visible), [controller, visible]);

  // Owner: feed live samples of the displayed load ~4×/s while playing; observer: only broadcast samples.
  const playing = snapshot?.transport === "playing";
  const tick = useTicker(Boolean(controller) && visible && playing && view.canControl, 250);
  useEffect(() => {
    if (!controller) return;
    controller.push(view.executorInstanceId, toFoliaInput(snapshot, displayedMusicSample(snapshot, view.canControl ? live : null), props.seekEpoch));
  }, [controller, snapshot, view.executorInstanceId, view.canControl, live, tick, props.seekEpoch]);

  const voiceLines = display.kind === "voice" ? subtitleLines(display.subtitle, display.text) : [];
  const voiceActive = display.kind === "voice" && voicePosition !== null ? activeSegmentIndex(display.subtitle, voicePosition) : -1;
  const statusText = display.kind === "music" ? lyricsStatusText(lyrics) : display.kind === "none" ? "播放后这里会显示歌词" : "";
  const showBasic = !stageState.drawing;

  return (
    <section className="lyrics-panel" aria-label="歌词">
      <header className="lyrics-panel-head">
        <small>{display.kind === "voice" ? "Claudio 正在串场" : asset ? `歌词 · ${PROVENANCE_LABEL[asset.timing]}` : "歌词"}</small>
        <button
          type="button"
          className={stageEnabled ? "lyrics-stage-toggle active" : "lyrics-stage-toggle"}
          aria-pressed={stageEnabled}
          onClick={() => props.onStageToggle(!stageEnabled)}
          title="使用 Folia 舞台渲染逐行/逐字歌词；关闭后显示基本歌词"
        >
          舞台{stageEnabled ? "开" : "关"}
        </button>
      </header>
      <div className="lyrics-panel-body">
        {stageEnabled && <div ref={stageHost} className={display.kind === "music" ? "lyrics-stage-host" : "lyrics-stage-host is-hidden"} aria-hidden="true" />}
        {display.kind === "voice" ? (
          <ol className="lyrics-lines dj-subtitle">
            {voiceLines.map((line, index) => (
              <li key={`${index}-${line}`} className={index === voiceActive ? "active" : voiceActive < 0 ? "plain" : ""}>
                {line}
              </li>
            ))}
          </ol>
        ) : statusText ? (
          <p className="lyrics-status">{statusText}</p>
        ) : asset && showBasic ? (
          <ol className={asset.timing === "plain-text" ? "lyrics-lines plain" : "lyrics-lines"}>
            {asset.lines.map((line, index) => (
              <li key={index} ref={index === active ? activeRef : undefined} className={index === active ? "active" : index < active ? "passed" : ""}>
                {line.text || "♪"}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      {stageEnabled && (
        <footer className="lyrics-panel-foot">
          {stageState.phase === "loading" && <small>舞台加载中…</small>}
          {stageState.phase === "fallback" && <small title={stageState.reason ?? undefined}>舞台不可用，已改用基本歌词</small>}
          <small>
            舞台渲染基于 <a href="/vendor/folia-stage/SOURCE.md" target="_blank" rel="noreferrer">Folia（AGPL-3.0）对应源码</a> ·{" "}
            <a href="/vendor/folia-stage/THIRD_PARTY_LICENSES.txt" target="_blank" rel="noreferrer">第三方许可</a>
          </small>
        </footer>
      )}
    </section>
  );
}

const noopSubscribe = () => () => {};
