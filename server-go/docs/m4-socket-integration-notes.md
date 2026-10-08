# M4 Socket integration notes

Live implementation coordination, not an acceptance result. Parent helpers and schema0010/0011 now exist. Please read m4-execution-lock.md.

Parent is implementing a per-database commit/authorization fence and durable scope generations. The final sender must support a short injected guard around current eligibility checking and NONBLOCKING queue/library admission, so a permission-changing commit cannot interleave between the check and admission. This guard must never cover a blocking network write or wait for a consumer. The parent adapter will use db.WithAuthorityReadContext. A generation comparison without this guard has a check/use race.

The immutable connection identity needs the verified JWT IssuedAt and ExpiresAt (or equivalent proof) copied from admission. Parent callbacks must revalidate that exact proof, not look up the newest token for the same user/family. Each socket must expire at its own access-token expiry. A newer token may not extend an older connection.

Please expose iteration or predicate-based publish so parent can authorize recipients from current facts. Room membership is a subscription index, not authority; private data uses the user/workspace intersection. Generation lookups can remain memory-only, with parent updating them before releasing the write fence and notifying the gateway to close affected transports afterward.

Bounds must accommodate valid content: 32000 UTF-16 units may encode to 96000 UTF-8 bytes. Incoming control-event limits and outgoing message bounds are different. A 500-message resume page can exceed the one-MiB queue budget; use a bounded size-aware page with truthful currentSeq/hasMore, or an explicitly bounded replay path with the same final authorization guard. A valid long message must not cause an endless reconnect loop.

Main go.mod and app integration remain parent-owned. Report verified candidate tag/checksum and runnable spike results before dependency integration. Browser/UI tests and live4301/5175 remain excluded.
