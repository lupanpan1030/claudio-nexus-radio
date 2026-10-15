import type { PlaybackSnapshot } from "@claudio/contracts";

/** Structural subset of BroadcastChannel (injectable for tests/non-DOM hosts). */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export type ChannelFactory = (name: string) => BroadcastChannelLike;

export const PROTOCOL = "claudio.playback-snapshot/2";

/**
 * `epoch` is the runtime clock time at which the sending page started its
 * runtime. Web Locks hand execution over one page at a time, so a successor's
 * epoch is larger than its predecessor's: observers order executors by it
 * (and messages of one executor by `seq`) without keeping a history of ids.
 */
export type ChannelMessage =
  | { readonly protocol: typeof PROTOCOL; readonly type: "snapshot"; readonly instanceId: string; readonly epoch: number; readonly seq: number; readonly snapshot: PlaybackSnapshot }
  /** An observer asks the executor to re-send its latest snapshot. */
  | { readonly protocol: typeof PROTOCOL; readonly type: "hello" }
  | { readonly protocol: typeof PROTOCOL; readonly type: "ended"; readonly instanceId: string; readonly epoch: number; readonly seq: number };

export function parseChannelMessage(data: unknown): ChannelMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.protocol !== PROTOCOL) return null;
  switch (message.type) {
    case "hello":
      return { protocol: PROTOCOL, type: "hello" };
    case "snapshot":
      if (!hasIdentity(message)) return null;
      if (typeof message.snapshot !== "object" || message.snapshot === null) return null;
      return message as unknown as ChannelMessage;
    case "ended":
      if (!hasIdentity(message)) return null;
      return message as unknown as ChannelMessage;
    default:
      return null;
  }
}

function hasIdentity(message: Record<string, unknown>): boolean {
  return typeof message.instanceId === "string" && typeof message.epoch === "number" && Number.isFinite(message.epoch) && Number.isSafeInteger(message.seq);
}

export function defaultChannelFactory(): ChannelFactory | null {
  const Ctor = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike }).BroadcastChannel;
  return Ctor ? (name) => new Ctor(name) : null;
}
