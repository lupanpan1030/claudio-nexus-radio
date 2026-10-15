import { boolean, literal, object, optional, string, type Decoder } from "./validation.js";

/** Every awaitable operation ends in exactly one of these. Cancelling settles. */
export type OperationOutcome = "completed" | "cancelled" | "failed" | "timed-out";

export type FailureOutcome = Exclude<OperationOutcome, "completed">;

/**
 * Error classification shared by HTTP and media failures. Classes describe
 * what the caller may do next, not which vendor failed.
 */
export type ErrorClass = "retryable" | "auth-required" | "unavailable" | "expired" | "invalid";

export interface ErrorInfo {
  readonly class: ErrorClass;
  /** Stable machine code, e.g. "stream_expired". */
  readonly code: string;
  readonly message?: string;
  /** True when the failure came from the current user's own action (abort, gesture). */
  readonly userInitiated?: boolean;
}

export const errorClassDecoder = literal("retryable", "auth-required", "unavailable", "expired", "invalid");

export const errorInfoDecoder: Decoder<ErrorInfo> = object<ErrorInfo>({
  class: errorClassDecoder,
  code: string({ min: 1, max: 100, pattern: /^[a-z0-9_.-]+$/ }),
  message: optional(string({ max: 1000 })),
  userInitiated: optional(boolean)
});

export const failureOutcomeDecoder = literal("cancelled", "failed", "timed-out");
