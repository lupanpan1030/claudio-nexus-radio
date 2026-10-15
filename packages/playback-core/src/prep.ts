import type { PreparePurpose, QueueItem, QueueItemId, ResolvedMedia } from "@claudio/contracts";
import type { StepContext } from "./context.js";
import type { ItemPrep } from "./state.js";

/** Source resolution partition: one bounded prepare operation per item. */

export function prepOf(ctx: StepContext, itemId: QueueItemId): ItemPrep {
  const existing = ctx.s.prep[itemId];
  if (existing) return existing;
  const created: ItemPrep = { opId: null, media: null, refreshAttempts: 0 };
  ctx.s.prep[itemId] = created;
  return created;
}

export function isMediaExpired(ctx: StepContext, media: ResolvedMedia): boolean {
  return media.stream.expiresAt !== null && media.stream.expiresAt <= ctx.now;
}

/**
 * Usable media for a new load, or null after making sure exactly one
 * prepare operation is in flight. Expired handles are never used for a new load.
 */
export function ensureResolved(ctx: StepContext, item: QueueItem, purpose: PreparePurpose): ResolvedMedia | null {
  const prep = prepOf(ctx, item.itemId);
  if (prep.media && !isMediaExpired(ctx, prep.media)) return prep.media;
  if (prep.opId !== null && ctx.s.pending[prep.opId]) return null;
  const previousRevision = prep.media?.sourceRevision ?? null;
  const opId = ctx.openOperation("prepare");
  prep.opId = opId;
  ctx.emit({
    type: "prepare.start",
    opId,
    itemId: item.itemId,
    track: item.track,
    purpose: prep.media ? "refresh" : purpose,
    previousRevision
  });
  return null;
}

/** Force a refresh (expired/retryable media error). */
export function refreshSource(ctx: StepContext, item: QueueItem): void {
  const prep = prepOf(ctx, item.itemId);
  ctx.cancelOperation(prep.opId);
  prep.refreshAttempts += 1;
  const opId = ctx.openOperation("prepare");
  prep.opId = opId;
  ctx.emit({
    type: "prepare.start",
    opId,
    itemId: item.itemId,
    track: item.track,
    purpose: "refresh",
    previousRevision: prep.media?.sourceRevision ?? null
  });
}

/** Cancel in-flight preparation for an item that is no longer wanted. */
export function cancelPrep(ctx: StepContext, itemId: QueueItemId): void {
  const prep = ctx.s.prep[itemId];
  if (!prep) return;
  ctx.cancelOperation(prep.opId);
  prep.opId = null;
}

/** Forget an item entirely (left the queue and the program). */
export function dropPrep(ctx: StepContext, itemId: QueueItemId): void {
  cancelPrep(ctx, itemId);
  delete ctx.s.prep[itemId];
}
