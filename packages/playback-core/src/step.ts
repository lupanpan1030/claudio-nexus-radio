import type { PlaybackCommand, PlaybackEffect, PlaybackFact } from "@claudio/contracts";
import { applyCommand } from "./commands.js";
import { StepContext, type CoreEnv, type StepNote } from "./context.js";
import { applyFact } from "./facts.js";
import { cloneState, deepFreeze, type PlaybackState } from "./state.js";

export type CoreInput =
  | { readonly kind: "command"; readonly command: PlaybackCommand }
  | { readonly kind: "fact"; readonly fact: PlaybackFact };

export interface StepResult {
  /** Same reference as the input state when the input was rejected as stale. */
  readonly state: PlaybackState;
  readonly effects: readonly PlaybackEffect[];
  readonly notes: readonly StepNote[];
}

/**
 * The only transition function: (state, input, env) → (state, effects).
 * Pure apart from the injected id factory; never mutates `state`. The
 * returned state is frozen and shares unchanged payloads with the input, so
 * `state` must itself come from createInitialState/step.
 */
export function step(state: PlaybackState, input: CoreInput, env: CoreEnv): StepResult {
  const ctx = new StepContext(cloneState(state), env);
  if (input.kind === "command") {
    applyCommand(ctx, input.command);
  } else if (applyFact(ctx, input.fact) === "stale") {
    return { state, effects: [], notes: ctx.notes };
  }
  ctx.s.version = state.version + 1;
  return { state: deepFreeze(ctx.s), effects: ctx.effects, notes: ctx.notes };
}

export const command = (value: PlaybackCommand): CoreInput => ({ kind: "command", command: value });
export const fact = (value: PlaybackFact): CoreInput => ({ kind: "fact", fact: value });
