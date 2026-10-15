import { createStatusStore, type StatusStore } from "../playback/status-store";
import type { FoliaLoadResult } from "./folia-loader";
import type { FoliaHandleLike, FoliaInputLike, FoliaMount, FoliaMountOptionsLike } from "./folia-types";

export type StagePhase = "off" | "loading" | "ready" | "fallback";

export interface StageState {
  readonly phase: StagePhase;
  /** Why the stage is not used (shown in diagnostics, never blocks audio). */
  readonly reason: string | null;
  /**
   * True only while the stage really shows timed lyrics: Lattice mode, its
   * WebGL renderer ready and no status overlay (not starting, not awaiting a
   * clock). Otherwise Claudio's basic lyrics show.
   */
  readonly drawing: boolean;
}

/** Readiness probe while the renderer starts: fixed cadence, bounded count, cancelled with the handle. */
export interface StageProbePolicy {
  readonly intervalMs: number;
  readonly maxProbes: number;
}

export const DEFAULT_PROBE_POLICY: StageProbePolicy = Object.freeze({ intervalMs: 150, maxProbes: 60 });

interface ProbeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimers: ProbeTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** The stage's own visibility rule for its canvas (renderer state and status both count). */
export function stageDraws(diagnostics: { readonly renderer: string; readonly status: string | null; readonly mode: string }): boolean {
  return diagnostics.mode === "lattice" && diagnostics.renderer === "ready" && diagnostics.status === null;
}

const OFF: StageState = Object.freeze({ phase: "off", reason: null, drawing: false });

/**
 * Lifecycle of one mounted Folia stage, independent of React. One handle per
 * executor epoch: when the executor instance changes the old handle is
 * destroyed and a new one starts with a fresh, strictly increasing sequence.
 * A late lazy import is ignored once detached. Any failure ends in "fallback"
 * (Claudio's own lyrics) and never reaches playback.
 *
 * The stage reports failures but not success, and its renderer starts
 * asynchronously. While it is starting the controller re-reads diagnostics on
 * a short, bounded timer (not per frame), so `drawing` turns true when the
 * canvas really appears even if no new input arrives (paused song, quiet
 * observer). The probe stops once the renderer settles or the handle goes
 * away. A renderer still starting when the probe budget runs out is given
 * up: the handle is destroyed and the stage falls back to the basic lyrics,
 * so a renderer that finishes later can never draw next to them. Callbacks
 * of a destroyed handle are ignored.
 */
export class FoliaStageController {
  readonly state: StatusStore<StageState> = createStatusStore<StageState>(OFF);
  private handle: FoliaHandleLike | null = null;
  private mount: FoliaMount | null = null;
  private host: HTMLElement | null = null;
  private epoch: string | null = null;
  private sequence = 0;
  private token = 0;
  private visible = true;
  private last: Omit<FoliaInputLike, "version"> | null = null;
  private probe: { handle: unknown; left: number } | null = null;
  /** Bumped whenever a handle is destroyed; callbacks of older handles compare against it. */
  private mounted = 0;

  constructor(
    private readonly load: () => Promise<FoliaLoadResult>,
    private readonly options: Pick<FoliaMountOptionsLike, "appearance" | "now">,
    private readonly probePolicy: StageProbePolicy = DEFAULT_PROBE_POLICY,
    private readonly timers: ProbeTimers = globalTimers
  ) {}

  attach(host: HTMLElement): void {
    if (this.host === host) return;
    this.detach();
    this.host = host;
    const token = ++this.token;
    this.state.set({ phase: "loading", reason: null, drawing: false });
    this.load().then(
      (result) => {
        if (token !== this.token) return;
        if (!result.ok) return this.fallback(result.reason);
        this.mount = result.mount;
        this.state.set({ phase: "ready", reason: null, drawing: false });
        this.recreate();
      },
      (error: unknown) => {
        if (token === this.token) this.fallback(error instanceof Error ? error.message : String(error));
      }
    );
  }

  detach(): void {
    this.token += 1;
    this.destroyHandle();
    this.host = null;
    this.mount = null;
    this.state.set(OFF);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.handle?.setVisible(visible);
  }

  /** Feeds one input for `epoch` (the executor instance whose snapshot it came from). */
  push(epoch: string | null, input: Omit<FoliaInputLike, "version">): void {
    this.last = input;
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      this.recreate();
      return;
    }
    this.send(input);
  }

  private recreate(): void {
    this.destroyHandle();
    if (!this.mount || !this.host || this.epoch === null || this.state.get().phase === "fallback") return;
    const generation = this.mounted;
    try {
      this.handle = this.mount(this.host, { ...this.options, fallback: "none", onFailure: (failure) => {
        if (generation !== this.mounted) return;
        if (failure.rendererDisabled) this.fallback(`renderer disabled: ${failure.kind}`);
        else this.refreshDrawing();
      } });
      this.sequence = 0;
      this.handle.setVisible(this.visible);
    } catch (error) {
      return this.fallback(error instanceof Error ? error.message : String(error));
    }
    if (this.last) this.send(this.last);
  }

  private send(input: Omit<FoliaInputLike, "version">): void {
    const handle = this.handle;
    if (!handle) return;
    try {
      const result = handle.update({ ...input, version: ++this.sequence });
      if (!result.accepted && result.reason === "destroyed") return this.fallback("stage destroyed");
    } catch (error) {
      return this.fallback(error instanceof Error ? error.message : String(error));
    }
    this.refreshDrawing();
  }

  /** Read-only diagnostics of the mounted stage (dev tooling); null without a handle. */
  diagnostics(): unknown {
    try {
      return this.handle?.getDiagnostics() ?? null;
    } catch {
      return null;
    }
  }

  private refreshDrawing(): void {
    const handle = this.handle;
    if (!handle) return;
    let drawing = false;
    let starting = false;
    try {
      const diagnostics = handle.getDiagnostics();
      drawing = stageDraws(diagnostics);
      starting = diagnostics.mode === "lattice" && (diagnostics.renderer === "creating" || diagnostics.renderer === "idle");
    } catch {
      drawing = false;
    }
    const current = this.state.get();
    if (current.phase === "ready" && current.drawing !== drawing) this.state.set({ phase: "ready", reason: null, drawing });
    if (starting) this.startProbe();
    else this.stopProbe();
  }

  private startProbe(): void {
    if (this.probe) return;
    this.probe = { handle: null, left: this.probePolicy.maxProbes };
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    const probe = this.probe;
    if (!probe) return;
    if (probe.left <= 0) {
      this.probe = null;
      return this.fallback(`renderer not ready within ${this.probePolicy.intervalMs * this.probePolicy.maxProbes}ms`);
    }
    probe.left -= 1;
    probe.handle = this.timers.setTimeout(() => {
      if (this.probe !== probe) return;
      probe.handle = null;
      this.refreshDrawing();
      if (this.probe === probe) this.scheduleProbe();
    }, this.probePolicy.intervalMs);
  }

  private stopProbe(): void {
    const probe = this.probe;
    this.probe = null;
    if (probe?.handle != null) this.timers.clearTimeout(probe.handle);
  }

  private fallback(reason: string): void {
    this.destroyHandle();
    this.state.set({ phase: "fallback", reason, drawing: false });
  }

  private destroyHandle(): void {
    this.stopProbe();
    this.mounted += 1;
    const handle = this.handle;
    this.handle = null;
    if (!handle) return;
    try {
      handle.destroy();
    } catch {
      // Destroy is idempotent on the stage side; a throwing destroy must not leak into the app.
    }
  }
}
