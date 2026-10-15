import { useCallback, useEffect, useRef, useState } from "react";

/** Structural subsets so the control flow can be tested with fakes. */
export interface MicStreamLike {
  getTracks(): readonly { stop(): void }[];
}

export interface RecognitionResultEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<ArrayLike<{ readonly transcript: string }> & { readonly isFinal: boolean }>;
}

export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { readonly error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface SpeechInputDeps {
  readonly getUserMedia: (() => Promise<MicStreamLike>) | null;
  readonly createRecognition: (() => RecognitionLike) | null;
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly timeoutMs?: number;
}

export interface SpeechCallbacks {
  readonly onListening: (listening: boolean) => void;
  readonly onInterim: (text: string) => void;
  /** Called at most once per session with the final transcript. */
  readonly onFinal: (text: string) => void;
  readonly onStatus: (message: string) => void;
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
  "not-allowed": "语音输入需要麦克风权限。",
  "service-not-allowed": "浏览器禁用了语音识别服务。",
  network: "语音识别服务暂时不可用，请检查网络后再试。",
  "no-speech": "没有听到声音，等麦克风启动后再说一次。",
  "audio-capture": "没有找到可用的麦克风。",
  aborted: "语音输入已取消。"
};

/**
 * One microphone session: permission → recognition → one final transcript.
 * Every exit (stop, timeout, error, end, late permission, dispose) releases
 * the microphone tracks and the recognizer exactly once.
 */
export class SpeechInputSession {
  private active = false;
  private submitted = false;
  private mic: MicStreamLike | null = null;
  private recognition: RecognitionLike | null = null;
  private timer: unknown = null;

  constructor(
    private readonly deps: SpeechInputDeps,
    private readonly callbacks: SpeechCallbacks
  ) {}

  get listening(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    if (this.active) return;
    if (!this.deps.createRecognition) return this.callbacks.onStatus("语音输入需要支持 Web Speech 的 Chromium 浏览器。");
    if (!this.deps.getUserMedia) return this.callbacks.onStatus("这个浏览器无法使用麦克风。");
    this.active = true;
    this.submitted = false;
    this.callbacks.onListening(true);
    this.callbacks.onStatus("正在请求麦克风权限…");
    this.timer = this.deps.setTimeout(() => this.finish("语音输入超时，请再试一次。"), this.deps.timeoutMs ?? 15_000);
    let mic: MicStreamLike;
    try {
      mic = await this.deps.getUserMedia();
    } catch (error) {
      if (!this.active) return;
      const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "unknown";
      return this.finish(name === "NotAllowedError" ? "语音输入需要麦克风权限。" : `麦克风不可用：${name}。`);
    }
    if (!this.active) {
      // Permission arrived after a stop/timeout/unmount: release it at once.
      for (const track of mic.getTracks()) track.stop();
      return;
    }
    this.mic = mic;
    const recognition = this.deps.createRecognition();
    this.recognition = recognition;
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    recognition.onresult = (event) => {
      if (this.recognition !== recognition) return;
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join("")
        .trim();
      if (transcript) this.callbacks.onInterim(transcript);
      const current = event.results[event.resultIndex];
      if (!this.submitted && current?.isFinal && transcript) {
        this.submitted = true;
        recognition.stop();
        this.callbacks.onStatus("正在发送语音请求…");
        this.callbacks.onFinal(transcript);
      }
    };
    recognition.onerror = (event) => {
      if (this.recognition !== recognition) return;
      this.callbacks.onStatus(ERROR_TEXT[event.error ?? ""] ?? `语音输入失败：${event.error ?? "unknown"}。`);
    };
    recognition.onend = () => {
      if (this.recognition === recognition) this.finish(null);
    };
    this.callbacks.onStatus("正在聆听…");
    try {
      recognition.start();
    } catch (error) {
      this.finish(`语音输入无法开始：${error instanceof Error ? error.name : "unknown"}。`);
    }
  }

  /** User pressed the mic button again, or the owner went away. */
  stop(message: string | null = "语音输入已停止。"): void {
    if (this.active) this.finish(message);
  }

  private finish(message: string | null): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        // Already stopped.
      }
    }
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    this.mic = null;
    this.callbacks.onListening(false);
    if (message) this.callbacks.onStatus(message);
  }
}

function browserDeps(): SpeechInputDeps {
  const globalWindow = typeof window === "undefined" ? undefined : (window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike });
  const Recognition = globalWindow?.SpeechRecognition ?? globalWindow?.webkitSpeechRecognition;
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  return {
    getUserMedia: media?.getUserMedia ? () => media.getUserMedia({ audio: true }) : null,
    createRecognition: Recognition ? () => new Recognition() : null,
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number)
  };
}

/** React binding: the session is released on unmount. */
export function useSpeechInput(options: { readonly onInterim: (text: string) => void; readonly onFinal: (text: string) => void; readonly setStatus: (message: string) => void }) {
  const [listening, setListening] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  const session = useRef<SpeechInputSession | null>(null);

  useEffect(() => {
    const created = new SpeechInputSession(browserDeps(), {
      onListening: setListening,
      onInterim: (text) => latest.current.onInterim(text),
      onFinal: (text) => latest.current.onFinal(text),
      onStatus: (message) => latest.current.setStatus(message)
    });
    session.current = created;
    return () => {
      created.stop(null);
      if (session.current === created) session.current = null;
    };
  }, []);

  const toggle = useCallback(() => {
    const current = session.current;
    if (!current) return;
    if (current.listening) current.stop();
    else void current.start();
  }, []);

  return { listening, toggle };
}
