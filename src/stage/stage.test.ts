import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaybackSnapshot } from "@claudio/contracts";
import { loadFoliaStage } from "./folia-loader";
import { toFoliaInput } from "./folia-input";
import { FoliaStageController, stageDraws } from "./stage-controller";
import type { FoliaHandleLike, FoliaInputLike, FoliaMount, FoliaPin } from "./folia-types";

const pin: FoliaPin = { name: "claudio-folia-stage", version: "0.1.0", contractVersion: 2, sourceSha256: "src", entry: "folia-stage.js", entrySha256: "entry", stageGitCommit: "c", base: "/vendor/folia-stage/" };
const info = { name: pin.name, contractVersion: 2, sourceSha256: "src", entry: "folia-stage.js", files: [{ path: "folia-stage.js", sha256: "entry" }] };
const respond = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
const fakeModule = (sourceSha256 = "src") => ({ mountFoliaStage: () => ({}), FOLIA_STAGE_BUILD_INFO: { sourceSha256, contractVersion: 2 } });

test("loader returns early on any manifest or module mismatch and never imports a mismatched build", async () => {
  let imported = 0;
  const importModule = async () => {
    imported += 1;
    return fakeModule();
  };
  assert.equal((await loadFoliaStage(pin, { fetchFn: respond(info, 404), importModule })).ok, false);
  assert.equal((await loadFoliaStage(pin, { fetchFn: respond({ ...info, sourceSha256: "other" }), importModule })).ok, false);
  assert.equal((await loadFoliaStage(pin, { fetchFn: respond({ ...info, files: [{ path: "folia-stage.js", sha256: "x" }] }), importModule })).ok, false);
  assert.equal((await loadFoliaStage(pin, { fetchFn: respond({ ...info, contractVersion: 1 }), importModule })).ok, false);
  assert.equal(imported, 0, "no import after a manifest mismatch");
  const halfUpdated = await loadFoliaStage(pin, { fetchFn: respond(info), importModule: async () => fakeModule("newer") });
  assert.deepEqual(halfUpdated, { ok: false, reason: "loaded module is not the pinned build" });
  const failing = await loadFoliaStage(pin, { fetchFn: respond(info), importModule: async () => Promise.reject(new Error("chunk 404")) });
  assert.equal(failing.ok, false);
  assert.equal((await loadFoliaStage(pin, { fetchFn: respond(info), importModule })).ok, true);
});

function musicSnapshot(clock: { positionMs: number; observedAt: number; rate: number } | null, version = 1): PlaybackSnapshot {
  return {
    version,
    transport: "playing",
    display: { kind: "music", itemId: "i1", deck: "A", loadId: "L1", sourceRevision: "rev1", lyrics: { status: "loading" } },
    decks: { A: { loadId: "L1", recordingId: "rec1", clock, seekEpoch: 3 }, B: { loadId: "L0", recordingId: "old", clock: { positionMs: 99, observedAt: 1, rate: 1 }, seekEpoch: 9 } }
  } as unknown as PlaybackSnapshot;
}

test("mapper binds identity and clock to the displayed load only; observer samples keep their original observedAt", () => {
  const sample = { loadId: "L1", positionMs: 1000, observedAt: 1000, rate: 1, source: "snapshot" } as const;
  const input = toFoliaInput(musicSnapshot({ positionMs: 1000, observedAt: 1000, rate: 1 }), sample as never);
  assert.deepEqual(input.display, { kind: "music", itemId: "i1", loadId: "L1", sourceRevision: "rev1", recordingId: "rec1", lyrics: { status: "loading" } });
  assert.equal(input.clock?.observedAt, 1000, "never re-stamped as fresh");
  assert.equal(input.clock?.seekEpoch, 3, "the displayed load's core seek epoch, identical for owner and observers");
  const otherLoad = toFoliaInput(musicSnapshot(null), { ...sample, loadId: "L0" } as never);
  assert.equal(otherLoad.clock, null);
  const voice = toFoliaInput({ ...musicSnapshot(null), display: { kind: "voice", cueId: "c1", transitionId: "t", subtitle: null, text: "x" } } as unknown as PlaybackSnapshot, null);
  assert.deepEqual(voice.display, { kind: "voice", cueId: "c1" });
});

class FakeHandle implements FoliaHandleLike {
  readonly inputs: FoliaInputLike[] = [];
  destroyed = false;
  visible = true;
  diagnostics: { renderer: string; status: string | null; mode: string } = { renderer: "ready", status: null, mode: "lattice" };
  diagnosticReads = 0;
  update(input: FoliaInputLike) {
    const last = this.inputs.at(-1);
    if (this.destroyed) return { accepted: false as const, reason: "destroyed" };
    if (last && input.version <= last.version) return { accepted: false as const, reason: "stale-version" };
    this.inputs.push(input);
    return { accepted: true as const };
  }
  setVisible(visible: boolean) {
    this.visible = visible;
  }
  resize() {}
  destroy() {
    this.destroyed = true;
  }
  getDiagnostics() {
    this.diagnosticReads += 1;
    return this.diagnostics;
  }
}

test("controller: one handle per executor epoch, fresh sequence on takeover, late import ignored after detach", async () => {
  const handles: FakeHandle[] = [];
  let failure: ((failure: { kind: string; message: string; rendererDisabled: boolean }) => void) | undefined;
  const mount: FoliaMount = (_host, options) => {
    failure = options?.onFailure;
    const handle = new FakeHandle();
    handles.push(handle);
    return handle;
  };
  const host = {} as HTMLElement;
  const controller = new FoliaStageController(async () => ({ ok: true, mount }), {});
  controller.push("exec-1", { display: { kind: "none" }, clock: null, transport: "idle" });
  controller.attach(host);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handles.length, 1);
  controller.push("exec-1", { display: { kind: "none" }, clock: null, transport: "playing" });
  assert.deepEqual(handles[0]?.inputs.map((input) => input.version), [1, 2]);
  controller.push("exec-2", { display: { kind: "none" }, clock: null, transport: "idle" });
  assert.equal(handles[0]?.destroyed, true, "old epoch destroyed");
  assert.deepEqual(handles[1]?.inputs.map((input) => input.version), [1], "new epoch starts its own sequence");
  assert.equal(controller.state.get().drawing, true);
  failure?.({ kind: "context-lost", message: "lost", rendererDisabled: true });
  assert.equal(controller.state.get().phase, "fallback");
  assert.equal(handles[1]?.destroyed, true);

  let release: (value: { ok: true; mount: FoliaMount }) => void = () => {};
  const slow = new FoliaStageController(() => new Promise((resolve) => (release = resolve)), {});
  slow.push("exec-1", { display: { kind: "none" }, clock: null, transport: "idle" });
  slow.attach(host);
  slow.detach();
  const before = handles.length;
  release({ ok: true, mount });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handles.length, before, "no mount after detach");
  assert.equal(slow.state.get().phase, "off");
});

class StepTimers {
  private next = 0;
  readonly pending = new Map<number, () => void>();
  setTimeout(callback: () => void) {
    const id = ++this.next;
    this.pending.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown) {
    this.pending.delete(handle as number);
  }
  tick() {
    const due = [...this.pending];
    this.pending.clear();
    for (const [, callback] of due) callback();
  }
}

test("drawing means the canvas is really shown: starting or clock-less renderers keep basic lyrics", () => {
  assert.equal(stageDraws({ mode: "lattice", renderer: "creating", status: "renderer-starting" }), false);
  assert.equal(stageDraws({ mode: "lattice", renderer: "ready", status: "awaiting-clock" }), false);
  assert.equal(stageDraws({ mode: "lattice", renderer: "failed", status: "renderer-failed" }), false);
  assert.equal(stageDraws({ mode: "status", renderer: "ready", status: null }), false);
  assert.equal(stageDraws({ mode: "lattice", renderer: "ready", status: null }), true);
});

test("an asynchronously ready renderer flips drawing without new input; the probe is bounded and cancelled", async () => {
  const first = new FakeHandle();
  // The real stage reports renderer-starting right after its first timed input.
  first.diagnostics = { renderer: "creating", status: "renderer-starting", mode: "lattice" };
  const mount: FoliaMount = () => first;
  const timers = new StepTimers();
  const controller = new FoliaStageController(async () => ({ ok: true, mount }), {}, { intervalMs: 150, maxProbes: 5 }, timers);
  controller.attach({} as HTMLElement);
  await new Promise((resolve) => setImmediate(resolve));
  const paused = { display: { kind: "none" as const }, clock: null, transport: "paused" as const };
  controller.push("exec-1", paused);
  assert.equal(controller.state.get().drawing, false, "renderer starting: basic lyrics stay");
  assert.equal(timers.pending.size, 1, "one probe pending");
  timers.tick();
  assert.equal(controller.state.get().drawing, false);
  first.diagnostics = { renderer: "ready", status: null, mode: "lattice" };
  timers.tick(); // no push: the song is paused / the observer gets nothing new
  assert.equal(controller.state.get().drawing, true, "ready + no status: the stage draws now");
  assert.equal(timers.pending.size, 0, "probe ends once the renderer settled");

  // awaiting-clock never counts as drawing and needs no probe (only new input changes it).
  first.diagnostics = { renderer: "ready", status: "awaiting-clock", mode: "lattice" };
  controller.push("exec-1", paused);
  assert.equal(controller.state.get().drawing, false);
  assert.equal(timers.pending.size, 0);

  first.diagnostics = { renderer: "creating", status: "renderer-starting", mode: "lattice" };
  controller.push("exec-1", paused);
  assert.equal(timers.pending.size, 1);
  controller.detach();
  assert.equal(timers.pending.size, 0, "detach cancels the probe");
  assert.equal(first.destroyed, true);
});

test("a renderer still starting when the probe budget runs out is destroyed: it can never draw next to the basic lyrics", async () => {
  const handles: FakeHandle[] = [];
  const failures: ((failure: { kind: string; message: string; rendererDisabled: boolean }) => void)[] = [];
  const mount: FoliaMount = (_host, options) => {
    const handle = new FakeHandle();
    handle.diagnostics = { renderer: "creating", status: "renderer-starting", mode: "lattice" };
    handles.push(handle);
    if (options?.onFailure) failures.push(options.onFailure);
    return handle;
  };
  const timers = new StepTimers();
  const controller = new FoliaStageController(async () => ({ ok: true, mount }), {}, { intervalMs: 150, maxProbes: 5 }, timers);
  controller.attach({} as HTMLElement);
  await new Promise((resolve) => setImmediate(resolve));
  const paused = { display: { kind: "none" as const }, clock: null, transport: "paused" as const };
  controller.push("exec-1", paused);
  const first = handles[0]!;
  // Paused page, no new input: only the bounded probe runs.
  for (let index = 0; index < 4; index += 1) timers.tick();
  assert.equal(controller.state.get().phase, "ready", "still within the budget");
  timers.tick();
  const state = controller.state.get();
  assert.equal(state.phase, "fallback");
  assert.equal(state.drawing, false);
  assert.match(state.reason ?? "", /not ready within 750ms/);
  assert.equal(first.destroyed, true, "the late renderer has no handle left to draw with");
  assert.equal(timers.pending.size, 0, "no polling after the budget");

  // Just beyond the budget the renderer would have been ready: nothing changes.
  first.diagnostics = { renderer: "ready", status: null, mode: "lattice" };
  for (let index = 0; index < 5; index += 1) timers.tick();
  controller.push("exec-1", paused);
  failures[0]?.({ kind: "webgl", message: "late", rendererDisabled: false });
  failures[0]?.({ kind: "webgl", message: "late", rendererDisabled: true });
  assert.deepEqual(controller.state.get(), state, "late callbacks and inputs of the destroyed handle are inert");
  assert.equal(handles.length, 1, "no new handle while in fallback");
  assert.equal(first.inputs.length, 1, "nothing sent to the destroyed handle");

  // Turning the stage off and on again starts afresh.
  controller.detach();
  controller.attach({} as HTMLElement);
  await new Promise((resolve) => setImmediate(resolve));
  controller.push("exec-1", paused);
  assert.equal(handles.length, 2);
  handles[1]!.diagnostics = { renderer: "ready", status: null, mode: "lattice" };
  timers.tick();
  assert.equal(controller.state.get().drawing, true);
  failures[0]?.({ kind: "webgl", message: "stale", rendererDisabled: true });
  assert.equal(controller.state.get().phase, "ready", "a destroyed handle's callback cannot fail the new one");
  controller.detach();
});
