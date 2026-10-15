import type { FoliaMount, FoliaPin } from "./folia-types";

export type FoliaLoadResult = { readonly ok: true; readonly mount: FoliaMount } | { readonly ok: false; readonly reason: string };

export interface FoliaLoaderDeps {
  readonly fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  /** Dynamic import of a same-origin URL; injected so tests can fake the module. */
  readonly importModule: (url: string) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Loads the exported stage only if it is exactly the pinned build: the
 * served BUILD_INFO must match the pin (name, contract, source hash, entry
 * hash), and the module's embedded build info must match too, so a half
 * updated export (new manifest, old entry or the reverse) is refused. Every
 * failure returns a reason; the caller keeps its own lyrics renderer.
 */
export async function loadFoliaStage(pin: FoliaPin, deps: FoliaLoaderDeps): Promise<FoliaLoadResult> {
  let info: unknown;
  try {
    const response = await deps.fetchFn(`${pin.base}BUILD_INFO.json`, { cache: "no-store" });
    if (!response.ok) return { ok: false, reason: `manifest HTTP ${response.status}` };
    info = await response.json();
  } catch (error) {
    return { ok: false, reason: `manifest unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(info)) return { ok: false, reason: "manifest unreadable" };
  if (info.name !== pin.name) return { ok: false, reason: "manifest name mismatch" };
  if (info.contractVersion !== pin.contractVersion) return { ok: false, reason: `contract ${String(info.contractVersion)} ≠ pinned ${pin.contractVersion}` };
  if (info.sourceSha256 !== pin.sourceSha256) return { ok: false, reason: "source hash mismatch" };
  if (info.entry !== pin.entry) return { ok: false, reason: "entry name mismatch" };
  const files = Array.isArray(info.files) ? info.files : [];
  const entryFile = files.find((file): file is Record<string, unknown> => isRecord(file) && file.path === pin.entry);
  if (!entryFile || entryFile.sha256 !== pin.entrySha256) return { ok: false, reason: "entry hash mismatch" };

  let module: unknown;
  try {
    // Absolute URL: a bare "/vendor/..." specifier would be rewritten by the dev server's import analysis.
    const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
    module = await deps.importModule(new URL(`${pin.base}${pin.entry}`, origin).href);
  } catch (error) {
    return { ok: false, reason: `module failed to load: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(module) || typeof module.mountFoliaStage !== "function") return { ok: false, reason: "module has no mountFoliaStage" };
  const embedded = module.FOLIA_STAGE_BUILD_INFO;
  if (!isRecord(embedded) || embedded.sourceSha256 !== pin.sourceSha256 || embedded.contractVersion !== pin.contractVersion) {
    return { ok: false, reason: "loaded module is not the pinned build" };
  }
  return { ok: true, mount: module.mountFoliaStage as FoliaMount };
}
