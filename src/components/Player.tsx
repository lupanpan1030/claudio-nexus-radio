import { CSSProperties, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Heart, Loader2, Pause, Play, SkipBack, SkipForward, Square, Volume2 } from "lucide-react";
import type { ClockReader, HostView, SpectrumReader } from "@claudio/playback-web";
import { AnimatedContent } from "./AnimatedContent";
import { ElasticVolumeSlider } from "./ElasticVolumeSlider";
import { createWaveMemory, formatClock, shapeWave, WAVE_BARS } from "./wave";
import { useProgramPosition, useVoicePosition } from "../app/hooks";
import { wantsPlayback, type PlaybackController } from "../playback/controller";
import { activeSegmentIndex, PROVENANCE_LABEL, subtitleLines } from "../playback/subtitles";
import type { VoiceControls } from "../playback/voice-model";
import type { TasteState } from "../features/taste";
import "./Player.transcript.css";

export interface PlayerTrack {
  readonly title: string;
  readonly artist: string;
}

type PlayerProps = {
  view: HostView;
  live: ClockReader | null;
  spectrum: SpectrumReader;
  controller: PlaybackController | null;
  track: PlayerTrack | null;
  /** One short line under the artist: the current lyric or DJ sentence. */
  caption: ReactNode;
  voice: VoiceControls;
  taste: TasteState;
  canPrevious: boolean;
  busy: boolean;
  /** A radio start from an empty queue will play when its pick arrives (the main button then cancels it). */
  starting: boolean;
  lyrics: (visible: boolean) => ReactNode;
  onHostProfileOpen: (trigger: HTMLButtonElement) => void;
};

const SILENT_LEVELS: readonly number[] = Object.freeze(Array(WAVE_BARS).fill(0));

/**
 * Display and intent only: everything shown comes from the playback snapshot
 * and read-only clock/spectrum readers; every button calls the controller.
 * No media element, AudioContext or volume automation lives here.
 */
export function Player({ view, live, spectrum, controller, track, caption, voice, taste, canPrevious, busy, starting, lyrics, onHostProfileOpen }: PlayerProps) {
  const [isVoicePanelOpen, setIsVoicePanelOpen] = useState(false);
  const [clockTime, setClockTime] = useState(() => new Date());
  const [voiceLevels, setVoiceLevels] = useState<readonly number[]>(SILENT_LEVELS);
  const activeTranscriptRef = useRef<HTMLParagraphElement | null>(null);
  const snapshot = view.snapshot;
  const canControl = view.canControl && controller !== null;
  // Same rule as controller.togglePlay: "pause" also while a radio start is on its way to playing.
  const isPlaying = wantsPlayback(snapshot) || starting;
  const isSongWaveActive = snapshot?.transport === "playing";
  const program = snapshot?.program ?? null;
  const programDeck = program?.deck ? snapshot?.decks[program.deck] : null;
  const durationMs = programDeck && programDeck.loadId === program?.loadId && programDeck.duration.kind === "known" ? programDeck.duration.ms : null;
  const positionMs = useProgramPosition(view, live);
  const canSeek = canControl && durationMs !== null && positionMs !== null;
  const progress = durationMs && positionMs !== null ? Math.min(100, (positionMs / durationMs) * 100) : 0;
  const voicePosition = useVoicePosition(view, live, isVoicePanelOpen);
  const isVoiceActive = voice.speaking;
  const transcript = useMemo(() => subtitleLines(voice.subtitle, voice.text), [voice.subtitle, voice.text]);
  const timedTranscript = voice.subtitle !== null && voice.subtitle.timing !== "plain-text";
  const activeTranscriptIndex = voice.active && voicePosition !== null ? activeSegmentIndex(voice.subtitle, voicePosition) : -1;
  const footerWaveShape = useMemo(
    () => Array.from({ length: 68 }, (_, index) => {
      const pulse = 0.34 + Math.abs(Math.sin(index * 0.63)) * 0.28;
      const swell = Math.exp(-((index - 20) ** 2) / 122) * 0.24 + Math.exp(-((index - 49) ** 2) / 146) * 0.2;
      return Math.min(1, pulse + swell);
    }),
    []
  );

  useEffect(() => {
    if (isVoicePanelOpen && activeTranscriptIndex >= 0) {
      activeTranscriptRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [activeTranscriptIndex, isVoicePanelOpen]);

  useEffect(() => {
    if (!isVoicePanelOpen) return;
    const timer = window.setInterval(() => setClockTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [isVoicePanelOpen]);

  // Visual sampling of the driver's music analyser only while the panel is open and music plays.
  useEffect(() => {
    if (!isVoicePanelOpen || !isSongWaveActive) {
      setVoiceLevels((current) => (current.some((level) => level !== 0) ? SILENT_LEVELS : current));
      return;
    }
    const samples = new Uint8Array(128);
    const memory = createWaveMemory();
    let frame = 0;
    let lastFrame = 0;
    const update = (time: number) => {
      if (time - lastFrame >= 50) {
        const bins = spectrum.readMusic(samples);
        setVoiceLevels((previous) => shapeWave(samples, bins, memory, previous));
        lastFrame = time;
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [isVoicePanelOpen, isSongWaveActive, spectrum]);

  const voiceTitle = voice.mainAction === "stop" ? "停止口播" : voice.mainAction === "replay" ? "重播这首的串词" : voice.preparing ? "串词正在准备" : "这首还没有可重播的串词";
  const panelVoiceLabel = voice.panelAction === "pause" ? "暂停口播" : voice.panelAction === "resume" ? "继续口播" : voice.panelAction === "replay" ? "重播串词" : "暂无串词";
  const djEnabled = snapshot?.settings.djEnabled ?? true;
  const seek = (seconds: number) => controller?.seek(seconds * 1000);

  return (
    <div className={`transport-strip ${isPlaying ? "is-playing" : "is-paused"} ${isVoiceActive ? "voice-active" : ""} ${voice.preparing ? "voice-preparing" : ""}`}>
      <div className="now-mini" key={program?.item.itemId ?? "waiting"}>
        <button className="mini-cover wave-trigger" type="button" onClick={() => setIsVoicePanelOpen(true)} aria-label="打开 Claudio 口播与歌词面板" title="打开口播与歌词面板">
          <span className="mini-bars">
            <i />
            <i />
            <i />
            <i />
          </span>
        </button>
        <div className="mini-copy">
          <strong>{track?.title ?? "等待信号"}</strong>
          <span>{track?.artist ?? "Claudio Radio"}</span>
          {caption}
        </div>
        <div className="track-signal" aria-hidden="true">
          {Array.from({ length: 18 }).map((_, index) => (
            <i key={index} style={{ "--signal-index": index, "--signal-delay": `${index * -47}ms` } as CSSProperties & Record<string, string | number>} />
          ))}
        </div>
      </div>

      <div className="transport">
        <button className="icon-button secondary" onClick={() => controller?.previous()} disabled={!canControl || !canPrevious} title="上一首" aria-label="上一首">
          <SkipBack />
        </button>
        <button className="icon-button primary" onClick={() => controller?.togglePlay()} disabled={!canControl} title={isPlaying ? "暂停" : "播放"} aria-label={isPlaying ? "暂停" : "播放"}>
          {isPlaying ? <Pause /> : <Play />}
        </button>
        <button className="icon-button secondary" onClick={() => controller?.next()} disabled={!canControl} title="下一首" aria-label="下一首">
          {busy ? <Loader2 className="spin" /> : <SkipForward />}
        </button>
        <button className="icon-button secondary" onClick={() => controller?.voiceMain()} disabled={!canControl || voice.mainAction === null} title={voiceTitle} aria-label={voiceTitle}>
          {voice.mainAction === "stop" ? <Square /> : <Volume2 />}
        </button>
      </div>

      <div className="taste-controls compact" aria-label="偏好反馈">
        <button className={taste.liked ? "taste-chip icon-only active" : "taste-chip icon-only"} onClick={taste.toggleLike} disabled={!taste.available || taste.pending} title="喜欢这首" aria-label="喜欢这首" aria-pressed={taste.liked}>
          <Heart />
        </button>
        <button className={djEnabled ? "taste-chip word active" : "taste-chip word"} type="button" onClick={() => controller?.setDjEnabled(!djEnabled)} disabled={!canControl} aria-pressed={djEnabled} title={djEnabled ? "自动串词已开启，点击关闭" : "自动串词已关闭，点击开启"}>
          DJ
        </button>
        <button className={taste.liked ? "taste-chip word active" : "taste-chip word"} type="button" onClick={taste.toggleLike} disabled={!taste.available || taste.pending} aria-pressed={taste.liked}>
          FAV
        </button>
      </div>

      <ElasticVolumeSlider value={snapshot?.settings.musicVolume ?? 0.5} onChange={(value) => controller?.setVolume(value)} />

      <div className="progress-row">
        <span>{formatClock(positionMs)}</span>
        <input aria-label="播放进度" type="range" min="0" max={durationMs ? Math.floor(durationMs / 1000) : 0} step="1" value={positionMs !== null ? Math.floor(positionMs / 1000) : 0} disabled={!canSeek} onChange={(event) => seek(Number(event.target.value))} style={{ "--progress": `${progress}%` } as CSSProperties & Record<string, string>} />
        <span>{formatClock(durationMs)}</span>
      </div>

      {isVoicePanelOpen && (
        <div className="voice-panel-backdrop" role="dialog" aria-modal="true" aria-label="Claudio 口播与歌词">
          <AnimatedContent className="voice-panel-motion">
          <div className="voice-panel">
            <button className="voice-panel-close" type="button" onClick={() => setIsVoicePanelOpen(false)} aria-label="关闭面板">
              关闭
            </button>
            <div className="voice-panel-head">
              <div className="voice-brand">
                <button type="button" className="avatar-button" onClick={(event) => onHostProfileOpen(event.currentTarget)} aria-label="打开 Claudio 主持人主页">
                  <span className="chat-avatar claudio-avatar" />
                </button>
                <div>
                  <strong>Claudio</strong>
                  <small>{isVoiceActive ? "正在说…" : voice.userPaused ? "口播已暂停" : voice.preparing ? "串词准备中…" : "待机"}</small>
                </div>
              </div>
              <span className="voice-timer">{clockTime.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
            </div>
            <div className={`voice-wave ${isSongWaveActive ? "active" : ""}`} aria-hidden="true">
              {Array.from({ length: WAVE_BARS }).map((_, index) => (
                <i key={index} style={{ "--bar": "100%", "--energy": `${isSongWaveActive ? (voiceLevels[index] ?? 0) : 0}` } as CSSProperties & Record<string, string>} />
              ))}
            </div>
            <div className="voice-card">
              <h2>{track?.title ?? "Claudio Signal"}</h2>
              <p>{track?.artist ?? "Claudio Radio"}</p>
              <div className="voice-playback-row">
                <button type="button" onClick={() => controller?.togglePlay()} disabled={!canControl} aria-label={isPlaying ? "暂停歌曲" : "播放歌曲"}>
                  {isPlaying ? <Pause /> : <Play />}
                </button>
                <input
                  className="voice-song-progress"
                  aria-label="歌曲播放进度"
                  type="range"
                  min="0"
                  max={durationMs ? Math.floor(durationMs / 1000) : 0}
                  step="1"
                  value={positionMs !== null ? Math.floor(positionMs / 1000) : 0}
                  disabled={!canSeek}
                  onChange={(event) => seek(Number(event.target.value))}
                  style={{ "--progress": `${progress}%` } as CSSProperties & Record<string, string>}
                />
                <span>{formatClock(positionMs)} / {formatClock(durationMs)}</span>
              </div>
              {lyrics(isVoicePanelOpen)}
              <div className="voice-transcript">
                {transcript.length === 0 ? (
                  <p><small>Claudio</small>下一段串词正在准备中</p>
                ) : (
                  transcript.map((line, index) => (
                    <p ref={index === activeTranscriptIndex ? activeTranscriptRef : undefined} key={`${index}-${line}`} className={index === activeTranscriptIndex ? "active" : timedTranscript ? "" : "plain"}>
                      <small>{!timedTranscript ? "Claudio · 全文" : voice.subtitle?.timing === "estimated" ? `Claudio · ${PROVENANCE_LABEL.estimated}` : "Claudio · 按口播时间"}</small>
                      {timedTranscript ? (
                        <span className="karaoke-line">
                          {[...line].map((character, charIndex) => (
                            <span className="karaoke-char" key={`${character}-${charIndex}`} style={{ "--character-progress": index <= activeTranscriptIndex ? "100%" : "0%" } as CSSProperties & Record<string, string>}>
                              {character}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="karaoke-line">{line}</span>
                      )}
                    </p>
                  ))
                )}
              </div>
              <div className="voice-footer">
                <span>{formatClock(voice.active ? voicePosition : null)}</span>
                <div className={`footer-wave ${isVoiceActive ? "active" : ""}`} aria-hidden="true">
                  {Array.from({ length: 68 }).map((_, index) => (
                    <i key={index} style={{ "--bar": `${26 + (footerWaveShape[index] ?? 0) * 56}%`, "--energy": `${isVoiceActive ? 0.2 + spectrum.voiceLevel() * 0.54 : 0.24}` } as CSSProperties & Record<string, string>} />
                  ))}
                </div>
                <button type="button" onClick={() => controller?.voicePanel()} disabled={!canControl || voice.panelAction === null} aria-label={panelVoiceLabel} title={panelVoiceLabel}>
                  {voice.panelAction === "pause" ? <Pause /> : <Play />}
                </button>
              </div>
            </div>
          </div>
          </AnimatedContent>
        </div>
      )}
    </div>
  );
}
