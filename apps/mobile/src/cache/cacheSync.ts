// Incremental sync + realtime write-through scheduler — moved to
// packages/shared (desktop-data-cache task #6); repo now satisfies the
// shared CacheRepo contract. This file remains as the mobile-side import
// anchor; behavior identical.
export * from "@botiverse/raft-shared/src/cacheSync.ts";
