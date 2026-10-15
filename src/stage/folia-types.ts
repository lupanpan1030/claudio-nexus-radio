/**
 * Claudio's own minimal structural view of the Folia stage module (contract
 * version 2). Written here from its documented API, not copied from the
 * stage's generated declarations; only what Claudio uses is described, and
 * everything is read-only data: no commands, no media.
 */

export type FoliaTransport = "idle" | "requested" | "loading" | "playing" | "waiting" | "paused" | "blocked" | "failed" | "exhausted";

export interface FoliaLyricsAssetLike {
  readonly assetId: string;
  readonly recordingId: string;
  readonly sourceRevision: string;
  readonly timing: "native-word" | "native-line" | "estimated" | "plain-text";
  readonly offsetMs: number;
  readonly lines: readonly { readonly startMs?: number; readonly endMs?: number; readonly text: string; readonly words?: readonly { readonly startMs: number; readonly endMs: number; readonly text: string }[] }[];
}

export type FoliaLyricsViewLike =
  | { readonly status: "none" }
  | { readonly status: "loading" }
  | { readonly status: "available"; readonly asset: FoliaLyricsAssetLike }
  | { readonly status: "missing"; readonly reason: string }
  | { readonly status: "unmatched" }
  | { readonly status: "failed" };

export type FoliaDisplayLike =
  | { readonly kind: "none" }
  | { readonly kind: "voice"; readonly cueId: string }
  | {
      readonly kind: "music";
      readonly itemId: string;
      readonly loadId: string | null;
      readonly sourceRevision: string | null;
      readonly recordingId: string | null;
      readonly lyrics: FoliaLyricsViewLike;
    };

export interface FoliaClockLike {
  readonly loadId: string;
  readonly positionMs: number;
  readonly observedAt: number;
  readonly rate: number;
  readonly seekEpoch?: number;
}

export interface FoliaInputLike {
  readonly version: number;
  readonly display: FoliaDisplayLike;
  readonly clock: FoliaClockLike | null;
  readonly transport: FoliaTransport;
}

export interface FoliaFailureLike {
  readonly kind: string;
  readonly message: string;
  readonly rendererDisabled: boolean;
}

export type FoliaUpdateResult = { readonly accepted: true } | { readonly accepted: false; readonly reason: string; readonly detail?: string };

export interface FoliaHandleLike {
  update(input: FoliaInputLike): FoliaUpdateResult;
  setVisible(visible: boolean): void;
  resize(): void;
  destroy(): void;
  getDiagnostics(): { readonly renderer: string; readonly status: string | null; readonly mode: string };
}

export interface FoliaMountOptionsLike {
  readonly appearance?: { readonly primaryColor?: string; readonly accentColor?: string; readonly secondaryColor?: string; readonly backgroundColor?: string; readonly fontStyle?: "sans" | "serif" | "mono"; readonly fontFamily?: string; readonly subtitle?: "translation" | "romanization" | "none" };
  readonly onFailure?: (failure: FoliaFailureLike) => void;
  readonly fallback?: "builtin" | "none";
  readonly now?: () => number;
}

export type FoliaMount = (host: HTMLElement, options?: FoliaMountOptionsLike) => FoliaHandleLike;

export interface FoliaPin {
  readonly name: string;
  readonly version: string;
  readonly contractVersion: number;
  readonly sourceSha256: string;
  readonly entry: string;
  readonly entrySha256: string;
  readonly stageGitCommit: string | null;
  /** Directory served by the app (gitignored export). */
  readonly base: string;
}
