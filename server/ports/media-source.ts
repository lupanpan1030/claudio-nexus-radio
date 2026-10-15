import type {
  DurationInfo,
  MediaCapabilities,
  RecordingIdentity,
  SourceRevision,
  TrackRef
} from "@claudio/contracts";

/**
 * Provider-private description of one resolved recording (hash, file
 * identity, signed URL...). JSON-serializable, persisted server-side only and
 * never sent to clients.
 */
export type SourceBinding = Readonly<Record<string, unknown>>;

export interface ResolvedSource {
  readonly recording: RecordingIdentity;
  /**
   * Names one recording as served for one TrackRef. Stable while a refresh
   * (e.g. a new signed URL) provably serves the same recording; must change
   * whenever the recording changes or continuity cannot be proven. It is
   * scoped to the ref: the same recording under two refs keeps one shared
   * recordingId but gets two revisions, so a revision never names two refs.
   */
  readonly sourceRevision: SourceRevision;
  readonly duration: DurationInfo;
  readonly capabilities: MediaCapabilities;
  /** Epoch ms after which this binding must not start a new load; null = provider sets none. */
  readonly expiresAt: number | null;
  readonly binding: SourceBinding;
}

export interface PreviousSource {
  readonly sourceRevision: SourceRevision;
  readonly binding: SourceBinding;
}

export interface ResolveContext {
  readonly signal: AbortSignal;
  readonly reason: "initial" | "refresh" | "retry";
  /** The binding being refreshed; providers re-resolve the same recording, never a lookalike. */
  readonly previous: PreviousSource | null;
}

export interface StreamRequest {
  /** Raw Range header, if any. */
  readonly range: string | null;
  readonly signal: AbortSignal;
}

/** HTTP-agnostic stream answer; the HTTP layer only copies it to the response. */
export interface MediaStream {
  readonly status: 200 | 206 | 416;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array> | null;
}

/**
 * One playback source. `open` must serve exactly the bound recording: when it
 * cannot, it fails instead of switching to another recording.
 */
export interface MediaSourcePort {
  resolve(ref: TrackRef, context: ResolveContext): Promise<ResolvedSource>;
  open(binding: SourceBinding, request: StreamRequest): Promise<MediaStream>;
}
