import { createHash } from "node:crypto";
import {
  asId,
  decode,
  lyricsAvailabilityDecoder,
  lyricsResultMatches,
  type AssetId,
  type LyricsAvailability,
  type RecordingId,
  type SourceRevision,
  type TrackRef
} from "@claudio/contracts";
import type { RawLyrics } from "../../ports/lyrics.js";
import type { ProviderRegistry } from "../../ports/providers.js";
import type { Clock } from "../../ports/runtime.js";
import type { LyricsAssetStore, ResolvedSourceRecord, ResolvedSourceStore } from "../../ports/stores.js";
import { appError } from "../errors.js";
import { raceAbort, SharedFlight, withDeadline } from "../operations.js";
import type { PlaybackPolicy } from "../policy.js";
import { sameRef } from "../sources.js";
import { LYRICS_PARSER_VERSION, looksInstrumental, parseLyricsDocument } from "./parse.js";

export interface LyricsQuery {
  readonly track: TrackRef;
  readonly sourceRevision: SourceRevision;
  /** Must equal the recording this server resolved under the revision. */
  readonly recordingId: RecordingId;
}

/**
 * Lyrics for one exact resolved recording. Never searches by title: only the
 * provider bound to the revision is asked, with that revision's private binding.
 */
export class LyricsService {
  private readonly flights = new SharedFlight<LyricsAvailability>();

  constructor(
    private readonly deps: {
      readonly providers: ProviderRegistry;
      readonly resolvedSources: ResolvedSourceStore;
      readonly store: LyricsAssetStore;
      readonly clock: Clock;
      readonly policy: PlaybackPolicy;
    }
  ) {}

  async forRevision(query: LyricsQuery, signal: AbortSignal): Promise<LyricsAvailability> {
    const source = this.deps.resolvedSources.get(query.sourceRevision);
    if (!source) throw appError("expired", "unknown_source_revision", "resolve the source again before asking for lyrics");
    if (!sameRef(source.track, query.track) || query.recordingId !== source.recordingId) {
      throw appError("invalid", "revision_mismatch", "revision does not belong to this track/recording");
    }
    const cached = this.deps.store.get(query.sourceRevision, LYRICS_PARSER_VERSION);
    // A cached row that no longer decodes or names another recording is re-derived, never served.
    if (cached && isDeliverable(cached, source)) return cached;
    return this.flights.run(query.sourceRevision, (flightSignal) => this.load(source, flightSignal), signal);
  }

  private async load(source: ResolvedSourceRecord, signal: AbortSignal): Promise<LyricsAvailability> {
    const port = this.deps.providers.get(source.track.providerId)?.lyrics;
    let result: LyricsAvailability;
    if (!port) {
      result = { status: "missing", reason: "unsupported" };
    } else {
      const scoped = withDeadline(signal, this.deps.policy.lyricsDeadlineMs);
      let raw: RawLyrics;
      try {
        // The deadline settles the lookup even when the port ignores its signal.
        raw = await raceAbort(
          port.fetch(
            {
              recording: { recordingId: source.recordingId, confidence: source.confidence },
              sourceRevision: source.sourceRevision,
              duration: source.duration,
              binding: source.binding
            },
            { signal: scoped.signal }
          ),
          scoped.signal
        );
      } finally {
        scoped.dispose();
      }
      result = toAvailability(source, raw);
    }
    this.deps.store.put(source.sourceRevision, result, this.deps.clock.now(), LYRICS_PARSER_VERSION);
    return result;
  }
}

function isDeliverable(result: LyricsAvailability, source: Pick<ResolvedSourceRecord, "sourceRevision" | "recordingId">): boolean {
  return decode(lyricsAvailabilityDecoder, result).ok && lyricsResultMatches(result, source);
}

export function toAvailability(source: Pick<ResolvedSourceRecord, "sourceRevision" | "recordingId">, raw: RawLyrics): LyricsAvailability {
  if (raw.kind === "missing") return { status: "missing", reason: raw.reason };
  if (raw.kind === "unmatched") return { status: "unmatched" };
  if (looksInstrumental(raw.text)) return { status: "missing", reason: "instrumental" };
  const parsed = parseLyricsDocument(raw.format, raw.text);
  if (!parsed) return { status: "missing", reason: "not-found" };
  const assetId = asId<AssetId>(
    `ly_${createHash("sha256").update(`${source.sourceRevision}\n${raw.documentKey}`).digest("hex").slice(0, 32)}`
  );
  const result: LyricsAvailability = {
    status: "available",
    asset: {
      assetId,
      recordingId: source.recordingId,
      sourceRevision: source.sourceRevision,
      timing: parsed.timing,
      offsetMs: parsed.offsetMs,
      lines: parsed.lines
    }
  };
  // The parser keeps its output inside the wire contract; if it ever does not, refuse rather than ship it.
  return isDeliverable(result, source) ? result : { status: "missing", reason: "not-found" };
}
