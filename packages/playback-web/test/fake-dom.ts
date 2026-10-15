/**
 * Minimal stand-ins for HTMLAudioElement and AudioContext, enough to drive the
 * real BrowserDriver/MediaSlot code deterministically in Node. Events are
 * dispatched only when a test calls `fire`, mirroring queued media tasks.
 */

export class FakeParam {
  readonly calls: string[] = [];
  constructor(public value: number) {}
  cancelScheduledValues(t: number) {
    this.calls.push(`cancel@${t}`);
  }
  setValueAtTime(v: number, t: number) {
    this.calls.push(`set(${round(v)})@${t}`);
    this.value = v;
  }
  setValueCurveAtTime(curve: Float32Array, t: number, d: number) {
    this.calls.push(`curve(${round(curve[0]!)}→${round(curve[curve.length - 1]!)})@${round(t)}+${round(d)}`);
    this.value = curve[curve.length - 1]!;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(`linear(${round(v)})@${t}`);
    this.value = v;
  }
  setTargetAtTime(v: number, t: number, tau: number) {
    this.calls.push(`target(${round(v)})@${t}/${tau}`);
    this.value = v;
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export class FakeNode {
  readonly outputs: FakeNode[] = [];
  disconnected = 0;
  connect<T extends FakeNode>(node: T): T {
    this.outputs.push(node);
    return node;
  }
  disconnect() {
    this.disconnected++;
    this.outputs.length = 0;
  }
}

export class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}

export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  getByteFrequencyData(target: Uint8Array) {
    target.fill(7);
  }
  getByteTimeDomainData(target: Uint8Array) {
    target.fill(128);
  }
}

export class FakeCompressor extends FakeNode {
  threshold = new FakeParam(0);
  knee = new FakeParam(0);
  ratio = new FakeParam(0);
  attack = new FakeParam(0);
  release = new FakeParam(0);
}

export class FakeAudioContext extends EventTarget {
  private stateValue: "running" | "suspended" | "closed";
  currentTime = 10;
  sampleRate = 44_100;
  readonly destination = new FakeNode();
  readonly sources: FakeNode[] = [];
  readonly gains: FakeGain[] = [];
  resumeCalls = 0;
  /** When false, resume() stays pending (no user activation). */
  resumeAllowed: boolean;
  private pendingResume: (() => void)[] = [];

  constructor(state: "running" | "suspended" = "running") {
    super();
    this.stateValue = state;
    this.resumeAllowed = state === "running";
  }
  get state() {
    return this.stateValue;
  }
  /** Changes the state and fires `statechange`, as the browser does. */
  setState(next: "running" | "suspended" | "closed") {
    if (this.stateValue === next) return;
    this.stateValue = next;
    this.dispatchEvent(new Event("statechange"));
  }
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  createDynamicsCompressor() {
    return new FakeCompressor();
  }
  createMediaElementSource(element: FakeMediaElement) {
    if (element.tapped) throw new DOMException("HTMLMediaElement already connected previously to a different MediaElementSourceNode", "InvalidStateError");
    element.tapped = true;
    const node = new FakeNode();
    this.sources.push(node);
    return node;
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.stateValue === "closed") return Promise.reject(new DOMException("closed", "InvalidStateError"));
    if (this.resumeAllowed) {
      this.setState("running");
      return Promise.resolve();
    }
    return new Promise((resolve) => this.pendingResume.push(resolve));
  }
  suspend(): Promise<void> {
    if (this.stateValue === "closed") return Promise.reject(new DOMException("closed", "InvalidStateError"));
    this.setState("suspended");
    return Promise.resolve();
  }
  /** A user gesture arrived: pending resumes complete. */
  allowResume() {
    this.resumeAllowed = true;
    this.setState("running");
    for (const resolve of this.pendingResume.splice(0)) resolve();
  }
  async close() {
    this.setState("closed");
  }
}

interface PendingPlay {
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class FakeMediaElement extends EventTarget {
  src = "";
  preload = "";
  crossOrigin: string | null = null;
  private position = 0;
  duration = Number.NaN;
  paused = true;
  ended = false;
  seeking = false;
  /** When true a seek is declined synchronously (empty `seekable`): no seeking, no seeked. */
  seekableEmpty = false;
  readonly seeks: number[] = [];
  readyState = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  error: { code: number; message: string } | null = null;
  tapped = false;
  loads = 0;
  /** How play() answers: resolve at once, reject, or stay pending. */
  playMode: "resolve" | "not-allowed" | "pending" = "resolve";
  readonly plays: PendingPlay[] = [];

  get currentTime() {
    return this.position;
  }
  /** Setting it runs the seek algorithm: `seeking` turns true synchronously; `completeSeek` fires seeked. */
  set currentTime(seconds: number) {
    if (this.readyState === 0) {
      this.position = seconds;
      return;
    }
    if (this.seekableEmpty) return;
    this.position = seconds;
    this.ended = false;
    this.seeking = true;
    this.seeks.push(seconds);
  }
  /** Media time advances without a seek (playback). */
  advanceTo(seconds: number) {
    this.position = seconds;
  }
  /** The engine finished the latest seek: seeking=false, then the queued `seeked`. */
  completeSeek() {
    this.seeking = false;
    this.fire("seeked");
  }
  load() {
    this.loads++;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  play(): Promise<void> {
    this.paused = false;
    return new Promise<void>((resolve, reject) => {
      if (this.playMode === "resolve") return resolve();
      if (this.playMode === "not-allowed") {
        this.paused = true;
        return reject(new DOMException("play() failed because the user didn't interact with the document first.", "NotAllowedError"));
      }
      this.plays.push({ resolve, reject });
    });
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    // A pending play() is rejected by pause(), as browsers do.
    for (const pending of this.plays.splice(0)) pending.reject(new DOMException("The play() request was interrupted by a call to pause().", "AbortError"));
  }
  /** Deliver a media event (the browser's queued task). */
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
  /** Simulate metadata + enough data to play. */
  ready(durationSeconds: number) {
    this.duration = durationSeconds;
    this.readyState = 1;
    this.fire("loadedmetadata");
    this.readyState = 4;
    this.fire("canplay");
  }
}
