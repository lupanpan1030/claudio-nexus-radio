import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackCommand, PlaybackSnapshot, TrackRef } from "@claudio/contracts";
import { sendChat } from "../api";
import type { CatalogIndex } from "../playback/catalog";
import { decodeRef } from "../playback/catalog";
import { planChatReply, shouldDeliver, type ChatReplyWire } from "../playback/chat-intent";
import type { ChatItem, ChatReply, PlaylistSuggestion } from "../types";

export interface ChatSuggestion {
  readonly id: number;
  readonly summary: string;
  /** The reply itself; adopting re-plans it against the queue as it is then. */
  readonly reply: ChatReplyWire;
  readonly playlist: PlaylistSuggestion | null;
}

export interface ChatMessage extends ChatItem {
  /** A late playback suggestion the listener can adopt explicitly. */
  readonly suggestion?: ChatSuggestion;
}

export interface ChatDeps {
  readonly catalog: CatalogIndex;
  /** Live snapshot getter (owner only); null on observer pages. */
  readonly snapshot: () => PlaybackSnapshot | null;
  readonly userActionSeq: () => number;
  readonly apply: (commands: readonly PlaybackCommand[], options: { readonly gesture: boolean }) => void;
  readonly remember: (pairs: readonly { readonly legacyId: string; readonly ref: TrackRef }[]) => void;
  readonly setStatus: (message: string) => void;
}

function greeting(): string {
  const hour = new Date().getHours();
  return `${hour < 11 ? "早上好" : hour < 18 ? "中午好" : "晚上好"}，DJ 小王子`;
}

function statedPairs(reply: ChatReply): { legacyId: string; ref: TrackRef }[] {
  const picks = [reply.pick, reply.queuePick, ...(reply.playlist?.picks ?? [])];
  const pairs: { legacyId: string; ref: TrackRef }[] = [];
  for (const pick of picks) {
    const ref = pick ? decodeRef((pick as { track?: unknown }).track) : null;
    if (pick && ref) pairs.push({ legacyId: pick.songId, ref });
  }
  return pairs;
}

/**
 * Chat with Claudio. Plain replies are text only (never spoken). A reply's
 * playback part is planned against the snapshot at answer time; if the
 * listener changed playback after asking, a destructive or self-starting
 * plan is offered as a suggestion instead of being applied.
 */
export function useChat(deps: ChatDeps) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [{ role: "assistant", content: greeting() }]);
  const [pending, setPending] = useState(false);
  const [playlist, setPlaylist] = useState<PlaylistSuggestion | null>(null);
  const latest = useRef(deps);
  latest.current = deps;
  const nextId = useRef(1);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  /** Call from the submit gesture; the reply is applied later without a gesture. */
  const send = useCallback(async (raw: string) => {
    const options = { gesture: false } as const;
    const message = raw.trim();
    if (!message) return;
    const askedAtSeq = latest.current.userActionSeq();
    const controller = new AbortController();
    inFlight.current?.abort();
    inFlight.current = controller;
    setMessages((items) => [...items, { role: "user", content: message }]);
    setPending(true);
    try {
      const reply = await sendChat(message, controller.signal);
      if (controller.signal.aborted) return;
      const current = latest.current;
      const pairs = statedPairs(reply);
      current.remember(pairs);
      const catalog = current.catalog.withPairs(pairs);
      if (reply.remembered) current.setStatus(`Claudio 记住了：${reply.remembered}`);
      const plan = planChatReply(reply as ChatReplyWire, current.snapshot(), catalog);
      const overtaken = current.userActionSeq() !== askedAtSeq;
      const delivery = shouldDeliver(plan, overtaken);
      if (reply.playlist && delivery === "apply") setPlaylist(reply.playlist);
      if (delivery === "apply") {
        current.apply(plan.commands, options);
        current.setStatus(plan.summary);
      }
      const suggestion: ChatSuggestion | undefined = delivery === "suggest" ? { id: nextId.current++, summary: plan.summary, reply: reply as ChatReplyWire, playlist: reply.playlist ?? null } : undefined;
      setMessages((items) => [...items, { role: "assistant", content: reply.reply, ...(suggestion ? { suggestion } : {}) }]);
      if (plan.unresolved.length > 0) current.setStatus(`${plan.unresolved.length} 首歌暂时无法在本机曲库定位，已跳过。`);
    } catch (error) {
      if (controller.signal.aborted) return;
      setMessages((items) => [...items, { role: "assistant", content: error instanceof Error ? error.message : "这次对话失败了。" }]);
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(false);
      }
    }
  }, []);

  /** The listener adopts a late suggestion: a fresh intent planned on the current queue. */
  const adopt = useCallback((suggestion: ChatSuggestion) => {
    const current = latest.current;
    const plan = planChatReply(suggestion.reply, current.snapshot(), current.catalog);
    current.apply(plan.commands, { gesture: true });
    if (suggestion.playlist) setPlaylist(suggestion.playlist);
    current.setStatus(plan.summary || suggestion.summary);
    setMessages((items) => items.map((item) => (item.suggestion?.id === suggestion.id ? { role: item.role, content: item.content } : item)));
  }, []);

  return { messages, pending, playlist, send, adopt };
}
