import type { HostView } from "@claudio/playback-web";
import type { ProtocolCheck } from "./protocol";
import type { RefillStatus } from "./radio-refill";
import type { OwnerStartup } from "./session";

/**
 * The one sentence about playback the listener should know right now, in
 * plain Chinese; null when nothing needs saying. A requested play is never
 * described as sound: loading, buffering, blocked, failed and an exhausted
 * queue are told apart.
 */
export function playbackNotice(input: {
  readonly protocol: { readonly status: "checking" } | ProtocolCheck;
  readonly view: HostView;
  readonly startup: OwnerStartup;
  readonly refill: RefillStatus;
}): string | null {
  const { protocol, view, startup, refill } = input;
  if (protocol.status === "checking") return "正在连接 Claudio 服务…";
  if (protocol.status === "mismatch") return "服务器的播放协议与这个页面的版本不一致，播放器没有启动。请同时更新前后端后刷新。";
  if (protocol.status === "unreachable") return "连不上 Claudio 服务，播放器没有启动。";
  if (view.role === "observer") return "另一个 Claudio 页面正在播放，这里只显示它的状态。";
  if (view.role === "pending") return "正在启动播放器…";
  if (startup.status === "failed") return `播放器初始化失败：${startup.message}`;
  if (startup.status === "starting") return "正在启动播放器…";
  const snapshot = view.snapshot;
  if (!snapshot) return null;
  if (!view.exclusive) return "这个浏览器无法保证只有一个页面在播放，请只保留一个 Claudio 页面。";
  // Same words as the main button, which cancels such a start ("取消开播").
  if (refill.autoplay && refill.phase === "selecting") return "正在为你挑选一首歌…再按播放键可取消开播。";
  if (refill.autoplay && refill.phase === "retry-wait") return "这次没挑到歌，稍后自动重试…再按播放键可取消开播。";
  if (refill.userInitiated && refill.phase === "selecting" && snapshot.transport === "idle") return "已取消开播；挑到的歌会放进队列，不会自动播放。";
  switch (snapshot.transport) {
    case "blocked":
      return "浏览器拦住了自动播放，点一下播放键继续。";
    case "failed":
      return `这首没能播放${snapshot.program?.error?.message ? `：${snapshot.program.error.message}` : "。"}`;
    case "requested":
    case "loading":
      return "正在载入…";
    case "waiting":
      return "缓冲中…";
    case "exhausted":
      if (refill.phase === "selecting" || refill.phase === "retry-wait") return "队列播完了，正在挑选下一首…";
      if (refill.phase === "no-candidate") return "电台暂时挑不出下一首，可以在聊天里点歌。";
      if (refill.phase === "gave-up") return "挑选下一首失败了，稍后再按下一首试试。";
      return "队列播完了，等待下一首。";
    case "idle":
      if (refill.userInitiated && refill.phase === "gave-up") return "没能挑到歌，稍后再试一次。";
      if (refill.userInitiated && refill.phase === "no-candidate") return "电台暂时挑不出歌，可以在聊天里点歌。";
      return snapshot.queue.length > 0 ? "已恢复上次的队列，按播放继续。" : null;
    default:
      return null;
  }
}
