import type { DurationInfo, RecordingIdentity, SourceRevision } from "@claudio/contracts";
import type { SourceBinding } from "./media-source.js";

/** Lyrics as the provider delivered them, before timing provenance is decided. */
export type RawLyrics =
  | {
      readonly kind: "text";
      /** krc = KuGou word-timed; lrc may carry enhanced <mm:ss> word tags; plain has no timing. */
      readonly format: "lrc" | "krc" | "plain";
      readonly text: string;
      /** Stable evidence of which lyric document this is (file hash, provider lyric id). */
      readonly documentKey: string;
    }
  | { readonly kind: "missing"; readonly reason: "not-found" | "instrumental" | "unsupported" }
  /** The provider has lyrics but cannot tie them to this recording. */
  | { readonly kind: "unmatched" };

export interface LyricsLookup {
  readonly recording: RecordingIdentity;
  readonly sourceRevision: SourceRevision;
  readonly duration: DurationInfo;
  readonly binding: SourceBinding;
}

/** Optional provider capability: lyrics for an already resolved recording only. */
export interface LyricsSourcePort {
  fetch(lookup: LyricsLookup, options: { readonly signal: AbortSignal }): Promise<RawLyrics>;
}
