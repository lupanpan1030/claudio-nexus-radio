import type { ErrorInfo } from "./operation.js";
import { errorInfoDecoder } from "./operation.js";
import type { MediaReadiness } from "./media.js";
import { literal, object, string, tagged, type Decoder } from "./validation.js";

/**
 * Result of one preparation stage. Terminal statuses never revert to
 * "pending"; a retry is a new preparation version.
 */
export type Stage<T> =
  | { readonly status: "pending" }
  | { readonly status: "in-progress" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "failed"; readonly error: ErrorInfo }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "cancelled" }
  | { readonly status: "timed-out" }
  /** The server restarted while the stage ran; the client must re-prepare. */
  | { readonly status: "interrupted" }
  | { readonly status: "expired" };

export type StageStatus = Stage<unknown>["status"];

export function isStageSettled(stage: Stage<unknown>): boolean {
  return stage.status !== "pending" && stage.status !== "in-progress";
}

export function stageDecoder<T>(value: Decoder<T>): Decoder<Stage<T>> {
  const bare = <S extends StageStatus>(status: S) =>
    object({ status: literal(status) }) as unknown as Decoder<Extract<Stage<T>, { status: S }>>;
  return tagged<Stage<T>, "status">("status", {
    pending: bare("pending"),
    "in-progress": bare("in-progress"),
    ready: object({ status: literal("ready"), value }) as Decoder<Extract<Stage<T>, { status: "ready" }>>,
    failed: object({ status: literal("failed"), error: errorInfoDecoder }),
    skipped: object({ status: literal("skipped"), reason: string({ max: 200 }) }),
    cancelled: bare("cancelled"),
    "timed-out": bare("timed-out"),
    interrupted: bare("interrupted"),
    expired: bare("expired")
  });
}

/**
 * Music readiness ladder. The server can attest the first two; the executor
 * attests loadability/playability. A URL is not "playable".
 */
export type MusicReadiness = "none" | "candidate" | "resolved" | "loadable" | "playable";

/** Voice readiness ladder: a voice URL alone is "asset", not "playable". */
export type VoiceReadiness = "none" | "script" | "asset" | "playable";

export function musicReadinessFromMedia(resolved: boolean, media: MediaReadiness): MusicReadiness {
  if (!resolved) return "none";
  if (media === "can-play" || media === "can-play-through") return "playable";
  if (media === "metadata") return "loadable";
  return "resolved";
}
