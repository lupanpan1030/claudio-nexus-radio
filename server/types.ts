import type { TrackRef } from "@claudio/contracts";

/** tracks.source values written by this server's scanners and imports. */
export type KnownTrackSource = "main" | "kugou-cache" | "kugou-api";

/**
 * tracks.source exactly as stored. Values outside KnownTrackSource are kept
 * verbatim rather than relabelled, so no provider is credited with a row it
 * cannot serve; the composition's ref rule maps them to no TrackRef.
 */
export type TrackSource = KnownTrackSource | (string & {});

export type TrackRecord = {
  id: string;
  title: string;
  artist: string;
  album: string;
  filePath: string;
  folder: string;
  extension: string;
  source: TrackSource;
  playable: boolean;
  size: number;
  addedAt: string;
};

// Transitional alias for the existing server-side code. New boundaries should
// use TrackRecord so persistence-only fields are not confused with API DTOs.
export type Track = TrackRecord;

export type TrackDto = Pick<
  TrackRecord,
  "id" | "title" | "artist" | "album" | "extension" | "source" | "playable"
>;

/** v1 library row: the public fields plus the TrackRef the server maps it to (null = no provider serves it). */
export type LibraryTrackDto = TrackDto & {
  ref: TrackRef | null;
};

export type LibraryResponse = {
  tracks: Array<TrackDto | LibraryTrackDto>;
  total: number;
};

export type PlaybackSource = {
  mode: "api" | "local";
  streamUrl: string;
  source: "kugou-api" | "main";
  reason: string;
};

export type ClaudeSegue = "fade_in" | "direct" | "talk_first";

export type ClaudeDecision = {
  say: string;
  play: string[];
  reason: string;
  segue: ClaudeSegue;
};

export type ContextFragment = {
  key:
    | "systemPrompt"
    | "userCorpus"
    | "environmentContext"
    | "memoryContext"
    | "userInputContext"
    | "executionContext";
  title: string;
  content: string;
};

export type ClaudeRequestMode = "chat" | "next" | "queue" | "dj-line";

export type ContextAssembly = {
  mode: ClaudeRequestMode;
  systemPrompt: string;
  userCorpus: string;
  environmentContext: string;
  memoryContext: string;
  userInputContext: string;
  executionContext: string;
  fragments: ContextFragment[];
  assembledPrompt: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
};

export type RadioPick = {
  songId: string;
  djLine: string;
  reason: string;
  moodTags: string[];
  source: "ai" | "openai" | "rules";
  segue?: ClaudeSegue;
  decision?: ClaudeDecision;
};

export type PlaylistSuggestion = {
  playlistId: string;
  title: string;
  scene: string;
  summary: string;
  picks: RadioPick[];
  source: "rules" | "ai";
  generatedAt: string;
  missingTracks?: Array<{
    title: string;
    artist?: string;
    reason: string;
    candidates?: Array<{
      songId: string;
      title: string;
      artist: string;
      score: number;
      playable?: boolean;
      source?: Track["source"];
      extension?: string;
    }>;
  }>;
};

export type PlaylistLinkInspection = {
  inputUrl: string;
  platform: "netease" | "kugou" | "qqmusic" | "unknown";
  playlistId?: string;
  status: "recognized" | "unsupported" | "invalid";
  message: string;
  nextStep: string;
};

export type RecommendationScoreBreakdown = {
  taste_like: number;
  artist_taste: number;
  scene_taste: number;
  track_repeat: number;
  artist_repeat: number;
  family_repeat: number;
  scene_match: number;
  profile_match: number;
  family_mix: number;
  jitter: number;
};

export type RecommendationAuditCandidate = {
  songId: string;
  title: string;
  artist: string;
  album: string;
  family: string;
  source: Track["source"];
  score: number;
  scoreBreakdown: RecommendationScoreBreakdown;
};

export type RecommendationAuditInput = {
  mode: "next" | "queue";
  query: string;
  selectedSongId: string;
  selectedTitle: string;
  selectedArtist: string;
  family: string;
  source: RadioPick["source"];
  djLine: string;
  reason: string;
  scoreBreakdown: RecommendationScoreBreakdown;
  candidates: RecommendationAuditCandidate[];
};

export type RecommendationAuditLog = RecommendationAuditInput & {
  id: number;
  createdAt: string;
};

export type WeatherContext = {
  city: string;
  summary: string;
  temperature?: number;
  windSpeed?: number;
  observedAt?: string;
  source?: "browser" | "manual" | "fallback";
  available?: boolean;
};

export type SanitizedWeatherContext = {
  available: boolean;
  summary: string;
  temperature?: number;
  windSpeed?: number;
  observedAt?: string;
  source: "browser" | "manual" | "fallback";
};

export type CalendarInterruptionLevel = "low" | "normal" | "quiet";

export type SanitizedCalendarContext = {
  available: boolean;
  block: "morning" | "work" | "lunch" | "afternoon" | "evening" | "night";
  label: string;
  interruptionLevel: CalendarInterruptionLevel;
  djGuidance: string;
  nextWindow: string;
  source: "local-rules";
};

export type DailyPlanBlockKey = "morning" | "commute" | "work" | "lunch" | "workout" | "night" | "sleep";

export type DailyPlanBlock = {
  key: DailyPlanBlockKey;
  title: string;
  timeRange: string;
  scene: string;
  description: string;
  picks: RadioPick[];
};

export type DailyPlan = {
  dateKey: string;
  date: string;
  city: string;
  weatherSummary: string;
  generatedFrom: string;
  activatedAt?: string;
  currentBlockKey?: DailyPlanBlockKey;
  nextBlockKey?: DailyPlanBlockKey;
  blocks: DailyPlanBlock[];
};

export type ChatReply = {
  reply: string;
  pick?: RadioPick;
  queuePick?: RadioPick;
  weather?: WeatherContext;
  remembered?: string;
  decision?: ClaudeDecision;
  dailyPlan?: DailyPlan;
  playlist?: PlaylistSuggestion;
};

export type TasteAction =
  | "like"
  | "skip"
  | "commute"
  | "morning"
  | "work"
  | "sleep"
  | "focus"
  | "nostalgia"
  | "other";
