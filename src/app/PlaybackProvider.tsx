import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { HostView } from "@claudio/playback-web";
import { CatalogIndex } from "../playback/catalog";
import { checkProtocol, type ProtocolCheck } from "../playback/protocol";
import { readSettings, safeStorage, type AppSettings, type SafeStorage } from "../playback/persistence";
import { createPlaybackSession, createRingLog, type PlaybackSession } from "../playback/session";
import type { StatusStore } from "../playback/status-store";
import { getLibraryRows } from "../api";

export type ProtocolState = { readonly status: "checking" } | ProtocolCheck;

interface PlaybackContextValue {
  readonly protocol: ProtocolState;
  readonly session: PlaybackSession | null;
  readonly storage: SafeStorage;
}

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

const browserFetch = (input: string, init: RequestInit) => fetch(input, init);
const storage = safeStorage(() => (typeof window === "undefined" ? null : window.localStorage));
const readAppSettings = (): AppSettings => readSettings(storage);

/** Diagnostics only (dev builds and tests): read-only view of the executor's log and host state. */
const ring = createRingLog();

/**
 * Owns the page's single playback session. The protocol handshake comes
 * first; on a version mismatch no player is started. Session creation is
 * deferred one macrotask so StrictMode's mount→unmount→mount never builds two
 * runtimes (or two AudioContexts) at once; cleanup disposes the session,
 * which releases the executor lock for the next page.
 */
export function PlaybackProvider({ children }: { readonly children: ReactNode }) {
  const [protocol, setProtocol] = useState<ProtocolState>({ status: "checking" });
  const [session, setSession] = useState<PlaybackSession | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    checkProtocol(browserFetch, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setProtocol(result);
      },
      () => {}
    );
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (protocol.status !== "ready") return;
    let created: PlaybackSession | null = null;
    const timer = window.setTimeout(() => {
      created = createPlaybackSession({
        fetchFn: browserFetch,
        paths: protocol.paths,
        origin: window.location.origin,
        storage,
        settings: readAppSettings,
        log: ring.log,
        loadCatalog: async (signal) => {
          const { rows, total } = await getLibraryRows(signal);
          return CatalogIndex.fromLibraryRows(rows, total);
        }
      });
      setSession(created);
      if (import.meta.env.DEV) {
        const active = created;
        (window as unknown as { __claudioPlayback?: unknown }).__claudioPlayback = Object.freeze({
          view: () => active.host.getView(),
          clock: () => active.host.clock.read(),
          log: () => ring.entries(),
          // Same intent path as the progress slider, at ms precision (the slider steps whole seconds).
          seek: (positionMs: number) => active.controller.seek(positionMs)
        });
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (created) void created.dispose();
      setSession(null);
    };
  }, [protocol]);

  return <PlaybackContext.Provider value={{ protocol, session, storage }}>{children}</PlaybackContext.Provider>;
}

export function usePlaybackContext(): PlaybackContextValue {
  const value = useContext(PlaybackContext);
  if (!value) throw new Error("usePlaybackContext outside PlaybackProvider");
  return value;
}

const EMPTY_VIEW: HostView = Object.freeze({ role: "pending", executorInstanceId: null, snapshot: null, canControl: false, exclusive: true });
const noop = () => () => {};

/** The executor's (or observed) snapshot view; re-renders only when the host publishes. */
export function usePlaybackView(): HostView {
  const { session } = usePlaybackContext();
  return useSyncExternalStore(session ? session.host.subscribe : noop, session ? session.host.getView : () => EMPTY_VIEW, () => EMPTY_VIEW);
}

export function useStore<T>(store: StatusStore<T> | null, fallback: T): T {
  return useSyncExternalStore(store ? store.subscribe : noop, store ? store.get : () => fallback, () => fallback);
}

export { storage as appStorage, readAppSettings };
