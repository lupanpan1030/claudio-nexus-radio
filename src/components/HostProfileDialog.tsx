import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { AnimatedContent } from "./AnimatedContent";
import { ParticleField } from "./ParticleField";

const CompanionModel = lazy(() => import("./CompanionModel").then((module) => ({ default: module.CompanionModel })));

type HostProfileDialogProps = {
  open: boolean;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  isPlaying: boolean;
  libraryCount: number;
  /** Tracks confirmed started in this playback session (not legacy selections). */
  playedCount: number;
  gptOnline: boolean;
  fishStatus: "online" | "standby" | "offline";
  kugouOnline: boolean;
};

export function HostProfileDialog(props: HostProfileDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [isCompanionReady, setIsCompanionReady] = useState(false);
  const handleCompanionReady = useCallback(() => setIsCompanionReady(true), []);

  useEffect(() => {
    if (!props.open) setIsCompanionReady(false);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousOverflow;
      props.returnFocusRef.current?.focus();
    };
  }, [props.open, props.onClose, props.returnFocusRef]);

  if (!props.open) return null;
  return (
    <div className="host-profile-backdrop" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <AnimatedContent className="host-profile-motion">
      <section className={`host-profile-dialog${isCompanionReady ? " is-companion-ready" : ""}`} role="dialog" aria-modal="true" aria-labelledby="host-profile-title">
        <ParticleField variant="profile" />
        <button ref={closeRef} type="button" className="host-profile-close" onClick={props.onClose} aria-label="关闭 Claudio 主持人主页"><X size={17} /></button>

        <header className="host-profile-header">
          <div className="host-avatar-large host-avatar-large--original" aria-hidden="true" />
          <div>
            <h2 id="host-profile-title">Claudio</h2>
            <span className="host-profile-kicker"><i /> 一开机我就打碟</span>
          </div>
        </header>

        <p className="host-manifesto" aria-label="斯人若彩虹，遇上方知有">
          <span>{[..."斯人若彩虹"].map((character, index) => <i className="manifesto-char" style={{ animationDelay: `${900 + index * 110}ms` }} key={index}>{character}</i>)}</span>
          <span>{[..."遇上方知有"].map((character, index) => <i className="manifesto-char" style={{ animationDelay: `${1800 + index * 110}ms` }} key={index}>{character}</i>)}</span>
        </p>

        <div className="host-profile-pet-zone">
          <div className="host-profile-stage">
            <div className="host-interaction-field">
              <span>SIGNAL FIELD</span>
              <strong>我在</strong>
              <small>你说</small>
            </div>
            <Suspense fallback={<div className="companion-model-loading" />}> <CompanionModel isPlaying={props.isPlaying} onReady={handleCompanionReady} /> </Suspense>
          </div>

          <div className="host-stats">
            <div><strong>{props.isPlaying ? "LIVE" : "READY"}</strong><small>STATUS</small></div>
            <div><strong>{props.libraryCount.toLocaleString()}</strong><small>TRACKS</small></div>
            <div><strong>{props.playedCount}</strong><small>PLAYED</small></div>
          </div>
        </div>

        <section className="host-taste-board">
          <small>CLAUDIO · SIGNALS</small>
          <div className="host-services">
            <ServiceStatus label="GPT" status={props.gptOnline ? "online" : "offline"} />
            <ServiceStatus label="FISH TTS" status={props.fishStatus} />
            <ServiceStatus label="KUGOU" status={props.kugouOnline ? "online" : "offline"} />
          </div>
          <div className="host-tastes">
            <span style={{ animationDelay: "470ms" }}>深情电台</span><span style={{ animationDelay: "535ms" }}>90S 华语</span><span style={{ animationDelay: "600ms" }}>旧情歌</span>
            <span style={{ animationDelay: "665ms" }}>PIANO-SOLO</span><span style={{ animationDelay: "730ms" }}>RETRO-BALLAD</span><span style={{ animationDelay: "795ms" }}>久石让 &amp; 张信哲</span>
          </div>
        </section>
      </section>
      </AnimatedContent>
    </div>
  );
}

function ServiceStatus({ label, status }: { label: string; status: "online" | "standby" | "offline" }) {
  return <span className={status}><i />{label}</span>;
}
