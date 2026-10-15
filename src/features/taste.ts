import { useCallback, useEffect, useRef, useState } from "react";
import { setTaste } from "../api";

export interface TasteTarget {
  /** Legacy library row id the taste API keys on; null when this client cannot name the track. */
  readonly legacyId: string | null;
}

export interface TasteState {
  readonly liked: boolean;
  readonly pending: boolean;
  readonly available: boolean;
  toggleLike(): void;
}

/**
 * Like/unlike bound to the track that was current at click time. The answer
 * updates the mark of that track only, so a skip during the request cannot
 * light the next song's button; a failed request leaves the mark unchanged.
 */
export function useTaste(target: TasteTarget, setStatus: (message: string) => void): TasteState {
  const [marks, setMarks] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const toggleLike = useCallback(() => {
    const id = target.legacyId;
    if (!id) return;
    const next = !marks.has(id);
    setPendingId(id);
    setTaste(id, "like", next)
      .then(() => {
        if (!mounted.current) return;
        setMarks((current) => {
          const copy = new Set(current);
          if (next) copy.add(id);
          else copy.delete(id);
          return copy;
        });
        setStatus(next ? "已标记为喜欢。" : "已取消喜欢。");
      })
      .catch((error: unknown) => {
        if (mounted.current) setStatus(error instanceof Error ? error.message : "偏好保存失败。");
      })
      .finally(() => {
        if (mounted.current) setPendingId((current) => (current === id ? null : current));
      });
  }, [marks, setStatus, target.legacyId]);

  return {
    liked: target.legacyId !== null && marks.has(target.legacyId),
    pending: target.legacyId !== null && pendingId === target.legacyId,
    available: target.legacyId !== null,
    toggleLike
  };
}
