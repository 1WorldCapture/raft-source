import type { AttachmentPreviewResponse } from "@botiverse/raft-shared/src/attachmentPreview.ts";

export interface PreviewGate {
  load(fetchEnabled: () => Promise<unknown>): Promise<boolean>;
}

/** Defaults to on. A failed flag request must not turn preview off. */
export function createPreviewGate(): PreviewGate {
  let loaded = false;
  let enabled = true;
  let inflight: Promise<boolean> | null = null;
  return {
    load(fetchEnabled) {
      if (loaded) return Promise.resolve(enabled);
      if (!inflight) {
        inflight = fetchEnabled()
          .then((data) => {
            const record = data && typeof data === "object" ? data as { enabled?: unknown } : null;
            enabled = record?.enabled === true;
            loaded = true;
            return enabled;
          })
          .catch(() => {
            loaded = true;
            return enabled;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}

export interface PreviewCache {
  load(id: string, fetchPreview: (id: string) => Promise<AttachmentPreviewResponse>): Promise<AttachmentPreviewResponse>;
}

/** One result per attachment for this JS session. Concurrent loads share one request. Failures are not cached. */
export function createPreviewCache(): PreviewCache {
  const cache = new Map<string, Promise<AttachmentPreviewResponse>>();
  return {
    load(id, fetchPreview) {
      const existing = cache.get(id);
      if (existing) return existing;
      const pending = fetchPreview(id).catch((error: unknown) => {
        cache.delete(id);
        throw error;
      });
      cache.set(id, pending);
      return pending;
    },
  };
}

export const attachmentPreviewGate = createPreviewGate();
export const attachmentPreviewCache = createPreviewCache();
