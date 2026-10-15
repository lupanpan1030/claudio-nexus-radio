export type ClaudeSegue = "fade_in" | "direct" | "talk_first";

export type ClaudeDecision = {
  say: string;
  play: string[];
  reason: string;
  segue: ClaudeSegue;
};

/** Library sources this client knows by name; the server reports any stored value as is. */
export type KnownTrackSource = "main" | "kugou-cache" | "kugou-api";

export type TrackDto = {
  id: string;
  title: string;
  artist: string;
  album: string;
  extension: string;
  /** Stored library source, possibly one this client does not know: compare for display only, never to infer identity. */
  source: KnownTrackSource | (string & {});
  playable: boolean;
  /**
   * v1 library rows: the server-stated TrackRef, or null when no provider
   * serves the row. Read only through decodeRef; absent from legacy servers.
   */
  ref?: unknown;
};

export type Track = TrackDto;

export type RadioPick = {
  songId: string;
  djLine: string;
  reason: string;
  moodTags: string[];
  source: "ai" | "openai" | "rules";
  weather?: WeatherContext;
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

export type KuGouPlaylist = {
  id: string;
  name: string;
  trackCount?: number;
};

export type KuGouLoginAccount = {
  userid: string;
  nickname?: string;
  avatar?: string;
};

export type KuGouLoginStatus = {
  loggedIn: boolean;
  userid?: string;
  loggedInAt?: string;
  expiresAt?: string;
  needsLogin?: boolean;
  reason?: string;
};

export type KuGouLoginResult =
  | {
      ok: true;
      status: KuGouLoginStatus;
    }
  | {
      ok: false;
      requiresAccountSelection?: boolean;
      accounts?: KuGouLoginAccount[];
      error?: string;
    };

export type KuGouLibrarySyncStatus = {
  syncedAt?: string;
  playlistCount: number;
  trackCount: number;
  membershipCount: number;
};

export type KuGouLibrarySyncResult = KuGouLibrarySyncStatus & {
  added: number;
  updated: number;
  removed: number;
};

export type DjLineResult = {
  songId: string;
  djLine: string;
  source: "ai" | "rules";
  usedLlm: boolean;
  rejectedReason?: string;
  rawDjLine?: string;
  decision?: ClaudeDecision;
  lineMode?: string;
  quality?: {
    length: number;
    target: string;
    imageHits: string[];
    actionHits: string[];
    startsWithSimile: boolean;
  };
};

export type ProgramLineType = "opening" | "interlude" | "closing";

export type ProgramLineResult = {
  type: ProgramLineType;
  line: string;
  source: "ai" | "rules";
  usedLlm: boolean;
  rejectedReason?: string;
  rawLine?: string;
};

export type DjSampleFeedbackKind = "approved" | "rejected";

export type DjSampleFeedbackResult =
  | {
      ok: true;
      sample: {
        id: string;
        text: string;
        why?: string;
        songId?: string;
        createdAt?: string;
      };
    }
  | {
      ok: false;
      error: string;
    };

export type TtsResult =
  | {
      ok: true;
      audioUrl: string;
      cacheHit: boolean;
      source: "fish";
      fileName: string;
    }
  | {
      ok: false;
      fallback: "browser";
      error: string;
    };

export type WeatherContext = {
  available: boolean;
  summary: string;
  temperature?: number;
  windSpeed?: number;
  observedAt?: string;
  source: "browser" | "manual" | "fallback";
};

export type CalendarContext = {
  available: boolean;
  block: "morning" | "work" | "lunch" | "afternoon" | "evening" | "night";
  label: string;
  interruptionLevel: "low" | "normal" | "quiet";
  djGuidance: string;
  nextWindow: string;
  source: "local-rules";
};

export type ChatReply = {
  reply: string;
  pick?: RadioPick;
  queuePick?: RadioPick;
  weather?: WeatherContext;
  remembered?: string;
  decision?: ClaudeDecision;
  playlist?: PlaylistSuggestion;
};

export type TasteProfile = {
  taste: string;
  routines: string;
  moodRules: string;
  interviews: string;
};

export type TasteTrainingResult = {
  ok: boolean;
  memory: string;
  nextQuestion: string;
  docs: TasteProfile;
  usedOpenAI: boolean;
};

export type TodayPick = RadioPick & {
  createdAt: string;
  title: string;
  artist: string;
};

export type ChatItem = {
  role: "user" | "assistant";
  content: string;
};

export type Health = {
  ok: boolean;
  libraryDir: string;
  tracks: number;
  ai: boolean;
  aiProvider?: string;
  aiModel?: string;
  djAiModel?: string;
  djAiTimeoutMs?: number;
  djAiReasoningEffort?: string;
  activeDailyPlan?: {
    dateKey: string;
    activatedAt: string;
    currentBlockKey: string;
  } | null;
};

export type NowPlayingDjStatus = "idle" | "writing" | "voice_preparing" | "voice_ready" | "voice_failed";

export type NowPlayingDj = {
  songId: string;
  say: string;
  voiceUrl: string;
  source: "ai" | "rules";
  status: NowPlayingDjStatus;
};

export type NowPlayingSnapshot = {
  updatedAt: string;
  playback: {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    volume: number;
  };
  currentTrack: Pick<Track, "id" | "title" | "artist" | "album" | "extension" | "source" | "playable"> | null;
  currentPick: RadioPick | null;
  dj: NowPlayingDj | null;
  queue: {
    activePlaylistId: string | null;
    activePlaylistTitle: string | null;
    length: number;
    nextSongId: string | null;
  };
  source: "web";
};
