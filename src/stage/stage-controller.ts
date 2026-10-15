import { createStatusStore, type StatusStore } from "../playback/status-store";
import type { FoliaLoadResult } from "./folia-loader";
import type { FoliaHandleLike, FoliaInputLike, FoliaMount, FoliaMountOptionsLike } from "./folia-types";

export type StagePhase = "off" | "loading" | "ready" | "fallback";

export interface StageState {
  readonly phase: StagePhase;
  /** Why the stage is not used (shown in diagnostics, never blocks audio). */
  readonly reason: string | null;
  /** True while the stage itself draws timed lyrics (Lattice); otherwise Claudio's basic lyrics show. */
  readonly drawing: boolean;
}

const OFF: StageState = Object.freeze({ phase: "off", reason: null, drawing: false });

/**
 * Lifecycle of one mounted Folia stage, independent of React. One handle per
 * executor epoch: when the executor instance changes the old handle is
 * destroyed and a new one starts with a fresh, strictly increasing sequence.
 * A late lazy import is ignored once detached. Any failure ends in "fallback"
 * (Claudio's own lyrics) and never reaches playback.
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

  constructor(
    private readonly load: () => Promise<FoliaLoadResult>,
    private readonly options: Pick<FoliaMountOptionsLike, "appearance" | "now">
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
    try {
      this.handle = this.mount(this.host, { ...this.options, fallback: "none", onFailure: (failure) => {
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

  private refreshDrawing(): void {
    const handle = this.handle;
    if (!handle) return;
    let drawing = false;
    try {
      const diagnostics = handle.getDiagnostics();
      drawing = diagnostics.mode === "lattice" && diagnostics.renderer !== "failed" && diagnostics.renderer !== "disabled";
    } catch {
      drawing = false;
    }
    const current = this.state.get();
    if (current.phase === "ready" && current.drawing !== drawing) this.state.set({ phase: "ready", reason: null, drawing });
  }

  private fallback(reason: string): void {
    this.destroyHandle();
    this.state.set({ phase: "fallback", reason, drawing: false });
  }

  private destroyHandle(): void {
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
