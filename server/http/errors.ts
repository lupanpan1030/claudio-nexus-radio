import type { Response } from "express";
import { PROTOCOL_VERSION, type ApiErrorV1, type ErrorInfo, type ValidationIssue } from "@claudio/contracts";
import { toErrorInfo } from "../application/errors.js";

export function statusForError(info: ErrorInfo): number {
  switch (info.class) {
    case "invalid":
      return info.code === "stale_projection" || info.code === "superseded_executor" || info.code === "cue_conflict" ? 409 : 400;
    case "auth-required":
      return 401;
    case "expired":
      return 410;
    case "unavailable":
      return info.code.endsWith("_not_found") ? 404 : 503;
    case "retryable":
      return info.code === "deadline_exceeded" ? 504 : 503;
  }
}

export function sendError(res: Response, error: unknown): void {
  const info = toErrorInfo(error);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body: ApiErrorV1 = { protocolVersion: PROTOCOL_VERSION, error: info };
  res.status(statusForError(info)).json(body);
}

export function sendInvalid(res: Response, issues: readonly ValidationIssue[]): void {
  const message = issues
    .slice(0, 5)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
  const body: ApiErrorV1 = { protocolVersion: PROTOCOL_VERSION, error: { class: "invalid", code: "invalid_request", message } };
  res.status(400).json(body);
}
