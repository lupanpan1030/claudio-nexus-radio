import { useCallback, useEffect, useState } from "react";
import { getCalendarContext, getHealth } from "../api";
import { readSettings, writeSettings, type AppSettings, type SafeStorage } from "../playback/persistence";
import type { CalendarContext, Health } from "../types";

/** Health and local calendar context; failures only leave them empty. */
export function useServerContext() {
  const [health, setHealth] = useState<Health | null>(null);
  const [calendar, setCalendar] = useState<CalendarContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    getHealth().then((value) => !cancelled && setHealth(value), () => {});
    getCalendarContext().then((value) => !cancelled && setCalendar(value ?? null), () => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return { health, calendar };
}

/** Wall clock that re-renders once per minute, aligned to the minute. */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      setNow(new Date());
      interval = window.setInterval(() => setNow(new Date()), 60_000);
    }, 60_000 - (Date.now() % 60_000) + 20);
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);
  return now;
}

/** Theme and stage preference, versioned in storage; playback settings are written by the executor. */
export function useAppSettings(storage: SafeStorage) {
  const [settings, setSettings] = useState<AppSettings>(() => readSettings(storage));
  const update = useCallback(
    (patch: Partial<Pick<AppSettings, "theme" | "stageEnabled">>) => {
      setSettings((current) => {
        const next = { ...readSettings(storage), ...current, ...patch };
        writeSettings(storage, { ...readSettings(storage), theme: next.theme, stageEnabled: next.stageEnabled });
        return next;
      });
    },
    [storage]
  );
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);
  return [settings, update] as const;
}
