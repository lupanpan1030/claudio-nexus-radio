import type { ProviderId, TrackRef } from "@claudio/contracts";
import type { CatalogEntry, CatalogPort } from "./catalog.js";
import type { LyricsSourcePort } from "./lyrics.js";
import type { MediaSourcePort } from "./media-source.js";

/**
 * One music provider as assembled by the composition root. Capabilities are
 * separate: a provider without lyrics simply has no `lyrics` port.
 */
export interface ProviderModule {
  readonly providerId: ProviderId;
  readonly catalog: CatalogPort;
  readonly source: MediaSourcePort;
  readonly lyrics?: LyricsSourcePort;
}

/** Lookup by opaque provider id; application code never branches on the id's value. */
export class ProviderRegistry {
  private readonly modules = new Map<string, ProviderModule>();

  constructor(modules: readonly ProviderModule[]) {
    for (const module of modules) {
      if (this.modules.has(module.providerId)) throw new Error(`duplicate provider ${module.providerId}`);
      this.modules.set(module.providerId, module);
    }
  }

  get(providerId: ProviderId): ProviderModule | undefined {
    return this.modules.get(providerId);
  }

  list(): readonly ProviderModule[] {
    return [...this.modules.values()];
  }

  describe(ref: TrackRef): CatalogEntry | null {
    const entry = this.get(ref.providerId)?.catalog.describe(ref) ?? null;
    // A catalog may only describe its own refs.
    return entry && entry.ref.providerId === ref.providerId && entry.ref.mediaId === ref.mediaId ? entry : null;
  }
}
