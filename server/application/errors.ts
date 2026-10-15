import type { ErrorClass, ErrorInfo } from "@claudio/contracts";

/** A failure the application can classify for callers (HTTP maps class → status). */
export class AppError extends Error {
  readonly info: ErrorInfo;

  constructor(errorClass: ErrorClass, code: string, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options);
    this.name = "AppError";
    this.info = message === undefined ? { class: errorClass, code } : { class: errorClass, code, message: message.slice(0, 1000) };
  }
}

export function appError(errorClass: ErrorClass, code: string, message?: string, cause?: unknown): AppError {
  return new AppError(errorClass, code, message, cause === undefined ? undefined : { cause });
}

/** Why an operation's signal fired. */
export type AbortKind = "cancelled" | "timed-out";

export class OperationAbort extends Error {
  constructor(readonly kind: AbortKind, message: string = kind) {
    super(message);
    this.name = kind === "timed-out" ? "TimeoutError" : "AbortError";
  }
}

export function abortKind(signal: AbortSignal): AbortKind | null {
  if (!signal.aborted) return null;
  const reason: unknown = signal.reason;
  if (reason instanceof OperationAbort) return reason.kind;
  if (reason instanceof Error && reason.name === "TimeoutError") return "timed-out";
  return "cancelled";
}

export function throwIfAborted(signal: AbortSignal): void {
  const kind = abortKind(signal);
  if (kind) throw new OperationAbort(kind);
}

export function isAbort(error: unknown): error is OperationAbort {
  return error instanceof OperationAbort;
}

export function toErrorInfo(error: unknown, fallbackCode = "internal_error"): ErrorInfo {
  if (error instanceof AppError) return error.info;
  if (error instanceof OperationAbort) {
    return error.kind === "timed-out"
      ? { class: "retryable", code: "deadline_exceeded" }
      : { class: "retryable", code: "cancelled", userInitiated: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { class: "retryable", code: fallbackCode, message: message.slice(0, 300) };
}
