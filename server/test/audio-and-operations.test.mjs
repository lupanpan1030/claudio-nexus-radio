import assert from "node:assert/strict";
import test from "node:test";
import { probeAudioDuration } from "../adapters/audio/duration.ts";
import { OperationAbort, abortKind } from "../application/errors.ts";
import { SharedFlight, withDeadline } from "../application/operations.ts";
import { makeWav } from "../testing/wav.ts";

/** CBR MPEG-1 Layer III 128 kbps 44.1 kHz frames (417 bytes each, 1152 samples). */
function makeMp3(frames, { id3 = false } = {}) {
  const frameLength = 417;
  const parts = [];
  if (id3) parts.push(Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)]));
  for (let index = 0; index < frames; index += 1) {
    const frame = new Uint8Array(frameLength);
    frame.set([0xff, 0xfb, 0x90, 0x64]);
    parts.push(frame);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

test("WAV duration comes from the container header", () => {
  assert.deepEqual(probeAudioDuration(makeWav(1500), "wav"), { kind: "known", ms: 1500, source: "container-metadata" });
});

test("MP3 duration counts real frames (ID3 skipped); garbage stays unknown", () => {
  const expected = Math.round(((100 * 1152) / 44100) * 1000);
  assert.deepEqual(probeAudioDuration(makeMp3(100), "mp3"), { kind: "known", ms: expected, source: "container-metadata" });
  assert.deepEqual(probeAudioDuration(makeMp3(100, { id3: true }), "mp3"), { kind: "known", ms: expected, source: "container-metadata" });
  assert.deepEqual(probeAudioDuration(new Uint8Array(4096).fill(7), "mp3"), { kind: "unknown" });
  assert.deepEqual(probeAudioDuration(makeWav(500), "m4a"), { kind: "unknown" });
});

test("deadline aborts are classified as timed-out, parent aborts as cancelled", async () => {
  const parent = new AbortController();
  const scoped = withDeadline(parent.signal, 10);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(abortKind(scoped.signal), "timed-out");
  scoped.dispose();
  const second = withDeadline(parent.signal, 10_000);
  parent.abort(new OperationAbort("cancelled"));
  assert.equal(abortKind(second.signal), "cancelled");
  second.dispose();
});

test("shared flight: one subscriber leaving does not cancel the others; all leaving aborts the job", async () => {
  const flight = new SharedFlight();
  let release;
  let jobSignal;
  let starts = 0;
  const start = (signal) => {
    starts += 1;
    jobSignal = signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const a = new AbortController();
  const b = new AbortController();
  const first = flight.run("k", start, a.signal);
  const second = flight.run("k", start, b.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  a.abort();
  await assert.rejects(first, (error) => error instanceof OperationAbort && error.kind === "cancelled");
  assert.equal(jobSignal.aborted, false, "remaining subscriber keeps the job alive");
  release("audio");
  assert.equal(await second, "audio");

  const c = new AbortController();
  const lonely = flight.run("k2", start, c.signal);
  await new Promise((resolve) => setImmediate(resolve));
  c.abort();
  await assert.rejects(lonely);
  assert.equal(jobSignal.aborted, true, "last subscriber leaving aborts the shared job");
  assert.equal(flight.size, 0);
});
