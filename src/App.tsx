import { useCallback, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { PlaybackProvider, usePlaybackContext, usePlaybackView, useStore } from "./app/PlaybackProvider";
import { useAppSettings, useMinuteClock, useServerContext } from "./features/environment";
import { useKuGouAccount } from "./features/account";
import { useLibrary } from "./features/library";
import { useTaste } from "./features/taste";
import { useChat } from "./features/chat";
import { useSpeechInput } from "./features/speech-input";
import { useMediaControls } from "./features/media-controls";
import { playbackNotice } from "./playback/notice";
import { upcomingEntries, type RefillStatus } from "./playback/radio-refill";
import type { OwnerStartup } from "./playback/session";
import { voiceControls } from "./playback/voice-model";
import { LyricsPanel } from "./stage/LyricsPanel";
import { TopBar } from "./components/TopBar";
import { ProfileCard } from "./components/ProfileCard";
import { Player, type PlayerTrack } from "./components/Player";
import { LiveCaption } from "./components/LiveCaption";
import { ChatPanel } from "./components/ChatPanel";
import { PlaylistQueue } from "./components/PlaylistQueue";
import { HostProfileDialog } from "./components/HostProfileDialog";
import { DotGrid } from "./components/DotGrid";
import { ClickSpark } from "./components/ClickSpark";
import { SideRays } from "./components/SideRays";

const NO_STARTUP: OwnerStartup = { status: "none" };
const IDLE_REFILL: RefillStatus = { phase: "idle", userInitiated: false, autoplay: false, attempts: 0, lastError: null };
const noopSubscribe = () => () => {};

export function App() {
  return (
    <PlaybackProvider>
      <RadioApp />
    </PlaybackProvider>
  );
}

/**
 * Layout and wiring only. Playback state comes from the executor snapshot;
 * every playback intent goes through the session's controller. Account,
 * library, preferences, chat and speech are independent feature hooks.
 */
function RadioApp() {
  const { protocol, session, storage } = usePlaybackContext();
  const view = usePlaybackView();
  const owner = useStore(session?.owner ?? null, null);
  const startup = useStore(session?.startup ?? null, NO_STARTUP);
  const refill = useSyncExternalStore(owner ? owner.refill.subscribeStatus : noopSubscribe, owner ? owner.refill.getStatus : () => IDLE_REFILL, () => IDLE_REFILL);
  const controller = session?.controller ?? null;
  const live = view.canControl && session ? session.host.clock : null;
  const snapshot = view.snapshot;

  const [settings, updateSettings] = useAppSettings(storage);
  const [eventStatus, setStatus] = useState("正在准备 Claudio 电台");
  const [chatText, setChatText] = useState("");
  const [isHostProfileOpen, setIsHostProfileOpen] = useState(false);
  const hostProfileTriggerRef = useRef<HTMLButtonElement>(null);
  const now = useMinuteClock();
  const { health, calendar } = useServerContext();
  const library = useLibrary();
  const account = useKuGouAccount({ onLibraryChanged: library.reload, setStatus });

  const shownItem = snapshot?.program?.item ?? (snapshot && snapshot.transport === "idle" ? (upcomingEntries(snapshot)[0]?.item ?? null) : null);
  const catalogEntry = shownItem ? library.catalog.byTrack(shownItem.track) : null;
  const track: PlayerTrack | null = shownItem
    ? { title: shownItem.display?.title || catalogEntry?.display.title || "未知歌曲", artist: shownItem.display?.artist || catalogEntry?.display.artist || "未知歌手" }
    : null;
  const taste = useTaste({ legacyId: catalogEntry?.legacyId ?? null }, setStatus);
  const voice = voiceControls(snapshot);

  const getSnapshot = useCallback(() => (session?.host.getView().canControl ? session.host.getView().snapshot : null), [session]);
  const chat = useChat({
    catalog: library.catalog,
    snapshot: getSnapshot,
    userActionSeq: () => controller?.getUserActionSeq() ?? 0,
    apply: (commands, options) => controller?.apply(commands, options),
    remember: library.remember,
    setStatus
  });
  const speech = useSpeechInput({
    onInterim: setChatText,
    onFinal: (text) => {
      setChatText("");
      void chat.send(text);
    },
    setStatus
  });
  useMediaControls(controller, view);

  const openHostProfile = useCallback((trigger: HTMLButtonElement) => {
    hostProfileTriggerRef.current = trigger;
    setIsHostProfileOpen(true);
  }, []);

  const submitChat = (event?: FormEvent) => {
    event?.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    session?.host.unlockAudio();
    setChatText("");
    void chat.send(text);
  };

  const notice = playbackNotice({ protocol, view, startup, refill });
  const playedCount = snapshot ? snapshot.history.filter((entry) => entry.started).length + (snapshot.program?.started ? 1 : 0) : 0;
  const busy = snapshot?.transport === "requested" || snapshot?.transport === "loading" || (refill.autoplay && refill.phase === "selecting");
  const weekday = now.toLocaleDateString("zh-CN", { weekday: "long" });
  const dateStamp = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replaceAll(" ", " / ").toUpperCase();
  const fishStatus = snapshot?.voice?.status === "failed" ? "offline" : voice.text ? "online" : "standby";

  return (
    <main className="shell">
      <DotGrid className="dot-grid--ambient" />
      <section className="stage">
        <SideRays />
        <TopBar
          theme={settings.theme}
          onThemeToggle={(theme) => updateSettings({ theme })}
          kugouLibraryStatus={account.libraryStatus}
          kugouMobile={account.mobile}
          kugouCode={account.code}
          kugouAccounts={account.accounts}
          selectedKuGouUserId={account.selectedUserId}
          kugouLoginStatus={account.loginStatus}
          isKuGouAuthBusy={account.busy}
          isImportingPlaylist={account.syncing}
          onKuGouMobileChange={account.setMobile}
          onKuGouCodeChange={account.setCode}
          onKuGouUserSelect={account.selectUser}
          onKuGouCaptchaSend={account.sendCaptcha}
          onKuGouLogin={account.login}
          onKuGouLogout={account.logout}
          onHostProfileOpen={openHostProfile}
        />

        <section className="claudio-console">
          <ProfileCard now={now} weekday={weekday} dateStamp={dateStamp} />

          <div className="player-strip">
            <div className="station-spacer" aria-hidden="true" />
            <Player
              view={view}
              live={live}
              spectrum={session?.host.spectrum ?? SILENT}
              controller={controller}
              track={track}
              caption={<LiveCaption view={view} live={live} />}
              voice={voice}
              taste={taste}
              canPrevious={controller?.canPrevious(snapshot) ?? false}
              busy={busy}
              starting={refill.autoplay}
              lyrics={(visible) => (
                <LyricsPanel view={view} live={live} visible={visible} stageEnabled={settings.stageEnabled} onStageToggle={(stageEnabled) => updateSettings({ stageEnabled })} />
              )}
              onHostProfileOpen={openHostProfile}
            />
          </div>

          <PlaylistQueue snapshot={snapshot} controller={controller} canControl={view.canControl} playlist={chat.playlist} />

          <ChatPanel
            chat={chat.messages}
            onAdopt={chat.adopt}
            canControl={view.canControl}
            isChatting={chat.pending}
            chatText={chatText}
            status={notice ?? (calendar && eventStatus === "正在准备 Claudio 电台" ? `今日场景：${calendar.label}` : eventStatus)}
            currentTrack={track}
            isListening={speech.listening}
            onChatSubmit={submitChat}
            onChatTextChange={setChatText}
            onVoiceInput={speech.toggle}
            onHostProfileOpen={openHostProfile}
            hostProfileTriggerRef={hostProfileTriggerRef}
          />
        </section>
      </section>
      <HostProfileDialog
        open={isHostProfileOpen}
        onClose={() => setIsHostProfileOpen(false)}
        returnFocusRef={hostProfileTriggerRef}
        isPlaying={snapshot?.transport === "playing"}
        libraryCount={library.trackCount}
        playedCount={playedCount}
        gptOnline={Boolean(health?.ai)}
        fishStatus={fishStatus}
        kugouOnline={Boolean(account.loginStatus?.loggedIn)}
      />
      <ClickSpark />
    </main>
  );
}

const SILENT = Object.freeze({ readMusic: () => 0, readVoice: () => 0, voiceLevel: () => 0 });
