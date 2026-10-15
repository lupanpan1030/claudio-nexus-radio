import { array, decode, literal, nullable, object, trackDisplayDecoder, trackRefDecoder, type QueueEntryRequest } from "@claudio/contracts";
import type { QueueStore } from "./ports.js";

/** Structural subset of Web Storage, injected (never read from a global). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORED_VERSION = 1;

const storedQueueDecoder = object<{ version: 1; entries: QueueEntryRequest[] }>({
  version: literal(STORED_VERSION),
  entries: array(
    object<QueueEntryRequest>({
      track: trackRefDecoder,
      display: nullable(trackDisplayDecoder),
      origin: literal("user", "radio", "chat", "restore")
    }),
    { max: 500 }
  )
});

/**
 * Versioned queue intent in Web Storage. Only the executor writes. Unknown
 * or malformed data is ignored (and left in place), never half-applied.
 * The old app's queue keys are not read here: importing them is a separate,
 * one-time migration step.
 */
export function createStorageQueueStore(storage: KeyValueStorage, key: string): QueueStore {
  return {
    load() {
      const raw = storage.getItem(key);
      if (raw === null) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return [];
      }
      const decoded = decode(storedQueueDecoder, parsed);
      return decoded.ok ? decoded.value.entries : [];
    },
    save(entries) {
      storage.setItem(key, JSON.stringify({ version: STORED_VERSION, entries }));
    }
  };
}
