export type IdKind = "item" | "load" | "transition" | "cue" | "voice-load" | "op";

/**
 * Injected identity source. Implementations must never repeat a value within
 * one executor instance; prefixing with the instance id keeps ids unique
 * across reloads.
 */
export interface IdFactory {
  next(kind: IdKind): string;
}

/** Deterministic counter-based ids, e.g. "exec1:item:3". */
export function createSequentialIds(prefix: string): IdFactory {
  let counter = 0;
  return {
    next(kind) {
      counter += 1;
      return `${prefix}:${kind}:${counter}`;
    }
  };
}
