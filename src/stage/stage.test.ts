import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlaybackSnapshot } from "@claudio/contracts";
import { loadFoliaStage } from "./folia-loader";
import { toFoliaInput } from "./folia-input";
import { FoliaStageController } from "./stage-controller";
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
    decks: { A: { loadId: "L1", recordingId: "rec1", clock }, B: { loadId: "L0", recordingId: "old", clock: { positionMs: 99, observedAt: 1, rate: 1 } } }
  } as unknown as PlaybackSnapshot;
}

test("mapper binds identity and clock to the displayed load only; observer samples keep their original observedAt", () => {
  const sample = { loadId: "L1", positionMs: 1000, observedAt: 1000, rate: 1, source: "snapshot" } as const;
  const input = toFoliaInput(musicSnapshot({ positionMs: 1000, observedAt: 1000, rate: 1 }), sample as never, 0);
  assert.deepEqual(input.display, { kind: "music", itemId: "i1", loadId: "L1", sourceRevision: "rev1", recordingId: "rec1", lyrics: { status: "loading" } });
  assert.equal(input.clock?.observedAt, 1000, "never re-stamped as fresh");
  const otherLoad = toFoliaInput(musicSnapshot(null), { ...sample, loadId: "L0" } as never, 0);
  assert.equal(otherLoad.clock, null);
  const voice = toFoliaInput({ ...musicSnapshot(null), display: { kind: "voice", cueId: "c1", transitionId: "t", subtitle: null, text: "x" } } as unknown as PlaybackSnapshot, null, 0);
  assert.deepEqual(voice.display, { kind: "voice", cueId: "c1" });
});

class FakeHandle implements FoliaHandleLike {
  readonly inputs: FoliaInputLike[] = [];
  destroyed = false;
  visible = true;
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
    return { renderer: "ready", status: null, mode: "lattice" };
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
