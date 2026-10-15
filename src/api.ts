import type {
  ChatReply,
  CalendarContext,
  DjSampleFeedbackKind,
  DjSampleFeedbackResult,
  Health,
  KuGouLoginResult,
  KuGouLoginStatus,
  KuGouLibrarySyncResult,
  KuGouLibrarySyncStatus,
  KuGouPlaylist,
  PlaylistLinkInspection,
  PlaylistSuggestion,
  ProgramLineResult,
  ProgramLineType,
  RadioPick,
  TasteProfile,
  TasteTrainingResult,
  Track,
  WeatherContext
} from "./types";

export class ApiError extends Error {
  needsLogin: boolean;

  constructor(message: string, options: { needsLogin?: boolean } = {}) {
    super(message);
    this.needsLogin = options.needsLogin === true;
  }
}

export async function getHealth(): Promise<Health> {
  const response = await fetch("/api/health");
  return response.json();
}



export async function scanLibrary(): Promise<{ ok: boolean; count: number; error?: string }> {
  const response = await fetch("/api/library/scan", { method: "POST" });
  return response.json();
}

export async function getLibrary(query = "", limit = 5000): Promise<{ tracks: Track[]; total: number }> {
  const url = new URL("/api/library", window.location.origin);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url);
  return response.json();
}



export async function generateProgramLine(
  type: ProgramLineType,
  options: {
    scene?: string;
    recentTracks?: Array<{ title?: string; artist?: string }>;
  } = {}
): Promise<ProgramLineResult> {
  const response = await fetch("/api/dj/program-line", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type,
      scene: options.scene ?? "",
      recentTracks: options.recentTracks ?? []
    })
  });

  if (!response.ok) {
    const details = await response.json();
    throw new Error(details.error ?? "AI DJ program line failed");
  }

  return response.json();
}


export async function sendDjSampleFeedback(options: {
  kind: DjSampleFeedbackKind;
  text: string;
  songId?: string;
  reason?: string;
}): Promise<DjSampleFeedbackResult> {
  const response = await fetch("/api/dj/sample-feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options)
  });

  const result = (await response.json()) as DjSampleFeedbackResult;
  if (!response.ok || !result.ok) {
    throw new Error(result.ok ? "DJ feedback failed" : result.error);
  }
  return result;
}

export async function getRadioQueue(query = "", count = 4): Promise<{ picks: RadioPick[] }> {
  const response = await fetch("/api/radio/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, count, withWeather: false })
  });

  if (!response.ok) {
    const details = await response.json();
    throw new Error(details.error ?? "无法生成播放队列");
  }

  return response.json();
}

export async function importPlaylist(playlist: string): Promise<PlaylistSuggestion> {
  const response = await fetch("/api/playlist/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playlist })
  });

  if (!response.ok) {
    const details = await response.json();
    throw new Error(details.error ?? "无法导入歌单");
  }

  return response.json();
}

export async function importLatestInboxPlaylist(): Promise<PlaylistSuggestion> {
  const response = await fetch("/api/playlist/inbox/latest", { method: "POST" });

  if (!response.ok) {
    const details = await response.json();
    throw new Error(details.error ?? "无法载入最新歌单");
  }

  return response.json();
}

export async function getPendingInboxPlaylist(): Promise<PlaylistSuggestion | null> {
  const response = await fetch("/api/playlist/inbox/pending");

  if (!response.ok) {
    const details = await response.json();
    throw new Error(details.error ?? "无法读取待载入歌单");
  }

  const result = await response.json();
  return result.playlist ?? null;
}

export async function inspectPlaylistLink(url: string): Promise<PlaylistLinkInspection> {
  const response = await fetch("/api/playlist/link/inspect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });

  if (!response.ok) {
    const details = await response.json();
    throw new Error(details.error ?? "无法识别歌单链接");
  }

  return response.json();
}

export async function getKuGouPlaylists(): Promise<KuGouPlaylist[]> {
  const response = await fetch("/api/kugou/playlists");
  const result = await response.json();
  if (!response.ok) {
    throw new ApiError(result.error ?? "KuGou playlists failed.", { needsLogin: result.needsLogin });
  }
  return result.playlists ?? [];
}

export async function getKuGouLoginStatus(): Promise<KuGouLoginStatus> {
  const response = await fetch("/api/kugou/login/status");
  return response.json();
}

export async function logoutKuGou(): Promise<KuGouLoginStatus> {
  const response = await fetch("/api/kugou/logout", { method: "POST" });
  if (!response.ok) throw new Error("KuGou logout failed.");
  return response.json();
}

export async function sendKuGouCaptcha(mobile: string): Promise<void> {
  const response = await fetch("/api/kugou/captcha/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mobile })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.error ?? "KuGou captcha failed.");
  }
}

export async function loginKuGouCellphone(options: {
  mobile: string;
  code: string;
  userid?: string;
}): Promise<KuGouLoginResult> {
  const response = await fetch("/api/kugou/login/cellphone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options)
  });
  const result = await response.json();
  if (!response.ok) {
    return { ok: false, error: result.error ?? "KuGou login failed." };
  }
  return result;
}

export async function getKuGouLibrarySyncStatus(): Promise<KuGouLibrarySyncStatus> {
  const response = await fetch("/api/kugou/library/status");
  return response.json();
}

export async function syncKuGouLibrary(): Promise<KuGouLibrarySyncResult> {
  const response = await fetch("/api/kugou/library/sync", { method: "POST" });

  const result = await response.json();
  if (!response.ok) {
    throw new ApiError(result.error ?? "KuGou library sync failed.", { needsLogin: result.needsLogin });
  }
  return result;
}


export async function getWeather(): Promise<WeatherContext> {
  const response = await fetch("/api/weather");
  const result = await response.json();
  return result.weather;
}

export async function updateWeatherLocation(lat: number, lng: number): Promise<WeatherContext> {
  const response = await fetch("/api/weather/location", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lat, lng })
  });

  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.error ?? "Weather location update failed");
  }
  return result.weather;
}

export async function getCalendarContext(): Promise<CalendarContext> {
  const response = await fetch("/api/calendar/context");
  const result = await response.json();
  return result.calendar;
}

export async function sendChat(message: string, signal?: AbortSignal): Promise<ChatReply> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal
  });

  if (!response.ok) {
    const details = await response.json();
    throw new Error(details.error ?? "对话失败");
  }

  return response.json();
}

export async function getTasteProfile(): Promise<TasteProfile> {
  const response = await fetch("/api/taste-profile");
  return response.json();
}

export async function trainTaste(message: string): Promise<TasteTrainingResult> {
  const response = await fetch("/api/taste-profile/train", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });

  if (!response.ok) {
    const details = await response.json();
    throw new Error(details.error ?? "品味训练失败");
  }

  return response.json();
}

/** Preference marks. A non-2xx answer is a failure: the caller must not show the mark as saved. */
export async function setTaste(trackId: string, action: string, active: boolean, signal?: AbortSignal): Promise<void> {
  const response = await fetch("/api/taste", {
    method: active ? "POST" : "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackId, action }),
    signal
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true) throw new Error(result?.error ?? `偏好保存失败（HTTP ${response.status}）`);
}

/** Raw library rows and the library's own total; the playback catalog decodes the TrackRef each row may carry. */
export async function getLibraryRows(signal?: AbortSignal, limit = 5000): Promise<{ readonly rows: unknown[]; readonly total: number | null }> {
  const url = new URL("/api/library", window.location.origin);
  url.searchParams.set("q", "");
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`曲库读取失败（HTTP ${response.status}）`);
  const result = await response.json();
  return { rows: Array.isArray(result?.tracks) ? result.tracks : [], total: typeof result?.total === "number" ? result.total : null };
}
