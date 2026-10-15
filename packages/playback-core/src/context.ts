import { asId, type OperationId, type OperationKind, type PlaybackEffect } from "@claudio/contracts";
import type { IdFactory, IdKind } from "./ids.js";
import type { CoreState } from "./state.js";

/** Values the runtime supplies with every input; the core reads no clock. */
export interface CoreEnv {
  /** Runtime clock ms (monotonic, epoch-aligned). */
  readonly now: number;
  readonly ids: IdFactory;
}

export type StepNote =
  /** Fact for an identity that is no longer current; state unchanged. */
  | { readonly kind: "stale"; readonly reason: string }
  /** Repeated fact for the same identity (e.g. second `ended`). */
  | { readonly kind: "duplicate"; readonly reason: string }
  /** Command/fact accepted but nothing applicable. */
  | { readonly kind: "ignored"; readonly reason: string }
  /** Notable decision worth logging (degrade, late cue, refresh...). */
  | { readonly kind: "decision"; readonly reason: string };

/** Mutable working copy for one step. Only the step function creates it. */
export class StepContext {
  readonly effects: PlaybackEffect[] = [];
  readonly notes: StepNote[] = [];

  constructor(
    readonly s: CoreState,
    readonly env: CoreEnv
  ) {}

  get now(): number {
    return this.env.now;
  }

  id<T extends string>(kind: IdKind): T {
    return asId(this.env.ids.next(kind)) as unknown as T;
  }

  emit(effect: PlaybackEffect): void {
    this.effects.push(effect);
  }

  note(kind: StepNote["kind"], reason: string): void {
    this.notes.push({ kind, reason });
  }

  openOperation(kind: OperationKind): OperationId {
    const opId = this.id<OperationId>("op");
    this.s.pending[opId] = { opId, kind };
    return opId;
  }

  /** Settle locally (the core stops waiting) and ask the runtime to abort. */
  cancelOperation(opId: OperationId | null): void {
    if (opId === null) return;
    const pending = this.s.pending[opId];
    if (!pending) return;
    delete this.s.pending[opId];
    this.emit({ type: "operation.cancel", opId, kind: pending.kind });
  }

  /** Settle because a result arrived. Returns false when the op is not pending. */
  closeOperation(opId: OperationId, kind: OperationKind): boolean {
    const pending = this.s.pending[opId];
    if (!pending || pending.kind !== kind) return false;
    delete this.s.pending[opId];
    return true;
  }
}
