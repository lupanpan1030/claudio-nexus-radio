import assert from "node:assert/strict";
import { test } from "node:test";
import { SpeechInputSession, type RecognitionLike, type RecognitionResultEvent } from "./speech-input";

class FakeRecognition implements RecognitionLike {
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((event: RecognitionResultEvent) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  start() {
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
  }
  abort() {
    this.aborted += 1;
  }
  emit(text: string, isFinal: boolean) {
    const result = Object.assign([{ transcript: text }], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

function rig() {
  const tracks = [{ stopped: 0, stop() { this.stopped += 1; } }];
  let grant: (() => void) | null = null;
  let deny: ((error: unknown) => void) | null = null;
  const recognition = new FakeRecognition();
  const timers: { callback: () => void; cleared: boolean }[] = [];
  const finals: string[] = [];
  const statuses: string[] = [];
  const session = new SpeechInputSession(
    {
      getUserMedia: () => new Promise((resolve, reject) => {
        grant = () => resolve({ getTracks: () => tracks });
        deny = reject;
      }),
      createRecognition: () => recognition,
      setTimeout: (callback) => {
        const timer = { callback, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      }
    },
    { onListening: () => {}, onInterim: () => {}, onFinal: (text) => finals.push(text), onStatus: (message) => statuses.push(message) }
  );
  return { session, tracks, recognition, timers, finals, statuses, grant: () => grant?.(), deny: (error: unknown) => deny?.(error) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("final transcript is submitted exactly once and the microphone is released on end", async () => {
  const r = rig();
  const started = r.session.start();
  r.grant();
  await started;
  r.recognition.emit("播放晴天", false);
  r.recognition.emit("播放晴天", true);
  r.recognition.emit("播放晴天", true);
  assert.deepEqual(r.finals, ["播放晴天"]);
  r.recognition.onend?.();
  assert.equal(r.tracks[0]?.stopped, 1);
  assert.equal(r.session.listening, false);
  assert.equal(r.timers[0]?.cleared, true);
});

test("stop while permission is pending: the late stream is closed and recognition never starts", async () => {
  const r = rig();
  const started = r.session.start();
  r.session.stop();
  r.grant();
  await started;
  await tick();
  assert.equal(r.tracks[0]?.stopped, 1);
  assert.equal(r.recognition.started, 0);
});

test("15 s timeout and unmount both release mic and recognizer once", async () => {
  const r = rig();
  const started = r.session.start();
  r.grant();
  await started;
  r.timers[0]?.callback();
  assert.equal(r.tracks[0]?.stopped, 1);
  assert.equal(r.recognition.aborted, 1);
  assert.match(r.statuses.at(-1) ?? "", /超时/);
  r.session.stop(null);
  assert.equal(r.tracks[0]?.stopped, 1, "no double release");
});

test("denied permission ends the session with a readable message", async () => {
  const r = rig();
  const started = r.session.start();
  r.deny(Object.assign(new Error("no"), { name: "NotAllowedError" }));
  await started;
  assert.equal(r.session.listening, false);
  assert.match(r.statuses.at(-1) ?? "", /麦克风权限/);
});
