import assert from "node:assert/strict";
import test from "node:test";
import {
  asId,
  PLAYBACK_BUDGETS,
  PLAYBACK_HTTP_TIMEOUTS,
  PLAYBACK_OPERATION_BUDGETS,
  type OperationId,
  type OperationKind,
  type PlaybackFact
} from "@claudio/contracts";
import { DEFAULT_OPERATION_DEADLINES, OperationRunner, PortError } from "../src/index.js";
import { ManualTimers, flush } from "./helpers.js";

function runner() {
  const facts: PlaybackFact[] = [];
  const timers = new ManualTimers();
  const late: unknown[] = [];
  const ops = new OperationRunner({
    emit: (fact) => facts.push(fact),
    timers,
    clock: () => timers.now,
    deadlines: { prepare: 1_000 },
    log: (entry) => entry.event === "operation.late" && late.push(entry.data)
  });
  return { ops, facts, timers, late };
}

const opId = (n: number) => asId<OperationId>(`op:${n}`);

function spec(id: OperationId, run: (signal: AbortSignal) => Promise<string>) {
  return {
    kind: "prepare" as const,
    opId: id,
    run,
    completed: (value: string): PlaybackFact => ({ type: "receipt.settled", idempotencyKey: asId(value), itemId: asId("i"), outcome: "recorded" }),
    failed: (outcome: "failed" | "timed-out", error: { code: string }): PlaybackFact => ({
      type: "prepare.settled",
      opId: id,
      itemId: asId("i"),
      outcome,
      error: { class: "retryable", code: error.code }
    })
  };
}

test("cancel settles immediately even when the port ignores its AbortSignal; the late answer is dropped", async () => {
  const { ops, facts, late } = runner();
  let answer!: (value: string) => void;
  let signal!: AbortSignal;
  ops.start(spec(opId(1), (s) => ((signal = s), new Promise<string>((resolve) => (answer = resolve)))));
  ops.cancel(opId(1));
  assert.equal(await ops.outcome(opId(1)), "cancelled");
  assert.equal(signal.aborted, true);
  assert.equal(ops.activeCount, 0);
  answer("late");
  await flush();
  assert.deepEqual(facts, [], "cancellation produces no fact; the core already settled");
  assert.equal(late.length, 1);
});

test("a never-settling port is closed by the deadline with a timed-out fact and an aborted signal", async () => {
  const { ops, facts, timers } = runner();
  let signal!: AbortSignal;
  ops.start(spec(opId(2), (s) => ((signal = s), new Promise<string>(() => {}))));
  timers.advance(999);
  assert.equal(facts.length, 0);
  timers.advance(1);
  assert.equal(await ops.outcome(opId(2)), "timed-out");
  assert.equal(signal.aborted, true);
  assert.equal((signal.reason as DOMException).name, "TimeoutError");
  assert.deepEqual(facts, [{ type: "prepare.settled", opId: opId(2), itemId: "i", outcome: "timed-out", error: { class: "retryable", code: "prepare_timeout" } }]);
  assert.equal(timers.size, 0);
});

test("synchronous throws and classified PortErrors both become failed facts with the effect's identity", async () => {
  const { ops, facts } = runner();
  ops.start(
    spec(opId(3), () => {
      throw new Error("sync boom");
    })
  );
  ops.start(spec(opId(4), async () => Promise.reject(new PortError({ class: "auth-required", code: "login_needed" }))));
  await flush();
  assert.equal(await ops.outcome(opId(3)), "failed");
  assert.equal(await ops.outcome(opId(4)), "failed");
  assert.deepEqual(
    facts.map((f) => (f.type === "prepare.settled" ? [f.opId, f.outcome, f.error?.code] : null)),
    [
      [opId(3), "failed", "prepare_failed"],
      [opId(4), "failed", "login_needed"]
    ]
  );
});

test("dispose cancels everything in flight and later starts are ignored", async () => {
  const { ops, timers } = runner();
  const signals: AbortSignal[] = [];
  for (const n of [5, 6]) ops.start(spec(opId(n), (s) => (signals.push(s), new Promise<string>(() => {}))));
  ops.dispose();
  assert.deepEqual(await Promise.all([ops.outcome(opId(5)), ops.outcome(opId(6))]), ["cancelled", "cancelled"]);
  assert.ok(signals.every((s) => s.aborted));
  assert.equal(timers.size, 0);
  ops.start(spec(opId(7), async () => "x"));
  assert.equal(ops.outcome(opId(7)), undefined);
});

test("default guards come from the shared budget: each kind outlives its slowest healthy server path, then still closes a hung port", async () => {
  const facts: PlaybackFact[] = [];
  const timers = new ManualTimers();
  const ops = new OperationRunner({ emit: (fact) => facts.push(fact), timers, clock: () => timers.now });
  assert.deepEqual(DEFAULT_OPERATION_DEADLINES, PLAYBACK_OPERATION_BUDGETS);

  // Slowest healthy answer as the HTTP ports see it: every server stage on the path
  // runs to its full budget, then the exchange in flight returns (at most one long-poll request).
  const slowestHealthy: Record<OperationKind, number> = {
    prepare: PLAYBACK_BUDGETS.candidateMs + PLAYBACK_BUDGETS.sourceMs + PLAYBACK_HTTP_TIMEOUTS.longPollRequestMs,
    cue: PLAYBACK_BUDGETS.scriptMs + PLAYBACK_BUDGETS.voiceMs + PLAYBACK_HTTP_TIMEOUTS.longPollRequestMs,
    // One POST: the port's own HTTP timeout ends it, never the guard.
    lyrics: PLAYBACK_HTTP_TIMEOUTS.lyricsRequestMs
  };
  assert.ok(PLAYBACK_BUDGETS.lyricsMs < PLAYBACK_HTTP_TIMEOUTS.lyricsRequestMs && PLAYBACK_HTTP_TIMEOUTS.lyricsRequestMs < DEFAULT_OPERATION_DEADLINES.lyrics);

  const kinds: OperationKind[] = ["prepare", "cue", "lyrics"];
  const answers = new Map<OperationKind, (value: string) => void>();
  kinds.forEach((kind, index) => {
    ops.start(kindSpec(kind, opId(100 + index), () => new Promise<string>((resolve) => answers.set(kind, resolve))));
    ops.start(kindSpec(kind, opId(200 + index), () => new Promise<string>(() => {})));
  });
  let elapsed = 0;
  for (const kind of [...kinds].sort((a, b) => slowestHealthy[a] - slowestHealthy[b])) {
    timers.advance(slowestHealthy[kind] - elapsed);
    elapsed = slowestHealthy[kind];
    answers.get(kind)!(kind);
    await flush();
    assert.equal(await ops.outcome(opId(100 + kinds.indexOf(kind))), "completed", `${kind} answered at ${elapsed} ms is delivered, not timed out`);
    assert.ok(facts.some((fact) => fact.type === "receipt.settled" && fact.idempotencyKey === kind));
  }
  timers.advance(DEFAULT_OPERATION_DEADLINES.cue - elapsed);
  for (const [index, kind] of kinds.entries()) assert.equal(await ops.outcome(opId(200 + index)), "timed-out", `${kind}: a hung port still ends`);
  assert.equal(facts.filter((fact) => fact.type === "prepare.settled" && fact.outcome === "timed-out").length, 3);
  assert.equal(ops.activeCount, 0);
  assert.equal(timers.size, 0);
});

function kindSpec(kind: OperationKind, id: OperationId, run: (signal: AbortSignal) => Promise<string>) {
  return {
    kind,
    opId: id,
    run,
    completed: (value: string): PlaybackFact => ({ type: "receipt.settled", idempotencyKey: asId(value), itemId: asId("i"), outcome: "recorded" }),
    failed: (outcome: "failed" | "timed-out", error: { code: string }): PlaybackFact => ({
      type: "prepare.settled",
      opId: id,
      itemId: asId("i"),
      outcome,
      error: { class: "retryable", code: error.code }
    })
  };
}
