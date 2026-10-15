import type { QueueItem, QueueItemId, ResolvedMedia } from "@claudio/contracts";
import type { StepContext } from "./context.js";

/** Lyrics partition: assets are bound to (item, sourceRevision). */

export function requestLyrics(ctx: StepContext, item: QueueItem, media: ResolvedMedia): void {
  const existing = ctx.s.lyrics[item.itemId];
  if (existing && existing.sourceRevision === media.sourceRevision) return;
  dropLyrics(ctx, item.itemId);
  const opId = ctx.openOperation("lyrics");
  ctx.s.lyrics[item.itemId] = { sourceRevision: media.sourceRevision, opId, view: { status: "loading" } };
  ctx.emit({
    type: "lyrics.request",
    opId,
    itemId: item.itemId,
    track: item.track,
    recordingId: media.recording.recordingId,
    sourceRevision: media.sourceRevision
  });
}

export function dropLyrics(ctx: StepContext, itemId: QueueItemId): void {
  const existing = ctx.s.lyrics[itemId];
  if (!existing) return;
  ctx.cancelOperation(existing.opId);
  delete ctx.s.lyrics[itemId];
}
