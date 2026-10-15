import { FormEvent, type RefObject } from "react";
import { Loader2, Mic } from "lucide-react";
import type { ChatMessage, ChatSuggestion } from "../features/chat";
import { AnimatedContent } from "./AnimatedContent";

type ChatPanelProps = {
  chat: ChatMessage[];
  onAdopt: (suggestion: ChatSuggestion) => void;
  canControl: boolean;
  isChatting: boolean;
  chatText: string;
  status: string;
  currentTrack: { title: string; artist: string } | null;
  isListening: boolean;
  onChatSubmit: (event?: FormEvent) => void;
  onChatTextChange: (text: string) => void;
  onVoiceInput: () => void;
  onHostProfileOpen: (trigger: HTMLButtonElement) => void;
  hostProfileTriggerRef: RefObject<HTMLButtonElement | null>;
};

export function ChatPanel({
  chat,
  onAdopt,
  canControl,
  isChatting,
  chatText,
  status,
  currentTrack,
  isListening,
  onChatSubmit,
  onChatTextChange,
  onVoiceInput,
  onHostProfileOpen,
  hostProfileTriggerRef
}: ChatPanelProps) {
  const visibleChat = chat;

  return (
    <div className={`chat-panel ${isChatting ? "is-thinking" : ""}`}>
      <div className="connected-line">已连接 Claudio</div>
      <div className="chat-log">
        {visibleChat.map((item, index) => (
          <AnimatedContent key={`${item.role}-${index}`} className="chat-message-motion" distance={14} duration={0.38} initialOpacity={0} scale={0.985}>
            <article className={`${item.role} ${index === 0 ? "featured " : ""}chat-message`}>
              {item.role === "assistant" ? (
                <button ref={index === 0 ? hostProfileTriggerRef : undefined} type="button" className="avatar-button" onClick={(event) => onHostProfileOpen(event.currentTarget)} aria-label="打开 Claudio 主持人主页">
                  <span className="chat-avatar claudio-avatar" />
                </button>
              ) : <span className="chat-avatar user-avatar" />}
              <div className="message-body">
                <small>{item.role === "assistant" ? "Claudio" : "我"}</small>
                <p>{item.content}</p>
                {item.suggestion && (
                  <button type="button" className="chat-suggestion" onClick={() => onAdopt(item.suggestion!)} disabled={!canControl} title="这条建议是在你调整播放之后才返回的，点一下才会生效">
                    {item.suggestion.summary}
                  </button>
                )}
              </div>
            </article>
          </AnimatedContent>
        ))}
        {isChatting && (
          <AnimatedContent className="chat-message-motion" distance={10} duration={0.3} initialOpacity={0} scale={0.985}>
            <article className="assistant chat-message">
              <button type="button" className="avatar-button" onClick={(event) => onHostProfileOpen(event.currentTarget)} aria-label="打开 Claudio 主持人主页">
                <span className="chat-avatar claudio-avatar" />
              </button>
              <div className="message-body">
                <small>Claudio</small>
                <p>一开机我就打碟ing</p>
              </div>
            </article>
          </AnimatedContent>
        )}
      </div>
      <p className="now-playing-caption">
        正在播放：{currentTrack ? `${currentTrack.title} / ${currentTrack.artist}` : "等待信号"}
      </p>
      <form className="chat-form" onSubmit={onChatSubmit}>
        <input
          value={chatText}
          onChange={(event) => onChatTextChange(event.target.value)}
          placeholder="和 Claudio 说点什么…"
          aria-label="聊天输入"
        />
        <button
          type="button"
          className={`mic-button ${isListening ? "listening" : ""}`}
          onClick={onVoiceInput}
          disabled={isChatting}
          title={isListening ? "停止语音输入" : "语音输入"}
          aria-label={isListening ? "停止语音输入" : "语音输入"}
          aria-pressed={isListening}
        >
          {isListening ? <Loader2 className="spin" size={17} /> : <Mic size={17} />}
        </button>
      </form>
      <div className="screen-status" role="status">{status}</div>
    </div>
  );
}
