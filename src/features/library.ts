import { useCallback, useEffect, useRef, useState } from "react";
import type { TrackRef } from "@claudio/contracts";
import { getLibraryRows } from "../api";
import { CatalogIndex } from "../playback/catalog";

export interface LibraryState {
  readonly catalog: CatalogIndex;
  /** Rows the library returned (including rows without a TrackRef). */
  readonly trackCount: number;
  readonly error: string | null;
  reload(): Promise<void>;
  /** Adds server-stated (legacy id → TrackRef) pairs, e.g. from chat picks. */
  remember(pairs: readonly { readonly legacyId: string; readonly ref: TrackRef }[]): void;
}

/** Display catalog for the UI. Reloading never touches what is already queued or playing. */
export function useLibrary(): LibraryState {
  const [catalog, setCatalog] = useState(CatalogIndex.EMPTY);
  const [trackCount, setTrackCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const rows = await getLibraryRows(controller.signal);
      if (controller.signal.aborted) return;
      setCatalog(CatalogIndex.fromLibraryRows(rows));
      setTrackCount(rows.length);
      setError(null);
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "曲库读取失败");
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => inFlight.current?.abort();
  }, [reload]);

  const remember = useCallback((pairs: readonly { readonly legacyId: string; readonly ref: TrackRef }[]) => {
    if (pairs.length > 0) setCatalog((current) => current.withPairs(pairs));
  }, []);

  return { catalog, trackCount, error, reload, remember };
}
