import { isStageSettled, type ErrorInfo, type Stage } from "@claudio/contracts";
import { abortKind, isAbort, toErrorInfo } from "./errors.js";

export const pending = <T>(): Stage<T> => ({ status: "pending" });
export const inProgress = <T>(): Stage<T> => ({ status: "in-progress" });
export const ready = <T>(value: T): Stage<T> => ({ status: "ready", value });
export const failed = <T>(error: ErrorInfo): Stage<T> => ({ status: "failed", error });
export const skipped = <T>(reason: string): Stage<T> => ({ status: "skipped", reason });

/** Terminal stage for an error thrown by a stage runner. */
export function settledFromError<T>(error: unknown, signal: AbortSignal): Stage<T> {
  const kind = isAbort(error) ? error.kind : abortKind(signal);
  if (kind === "timed-out") return { status: "timed-out" };
  if (kind === "cancelled") return { status: "cancelled" };
  return failed(toErrorInfo(error, "stage_failed"));
}

/**
 * Applies `next` only if `current` has not settled. Terminal stages never
 * revert, which is what makes late results harmless.
 */
export function advance<T>(current: Stage<T>, next: Stage<T>): Stage<T> {
  return isStageSettled(current) ? current : next;
}

/** Settles an unsettled stage with a terminal status (cancel/interrupt/expire). */
export function terminate<T>(current: Stage<T>, status: "cancelled" | "interrupted" | "expired"): Stage<T> {
  return isStageSettled(current) ? current : { status };
}
