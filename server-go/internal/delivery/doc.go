// Package delivery owns the M5 durable delivery facts: logical recipient
// intents (agent_deliveries), protocol occurrences (agent_delivery_attempts)
// and external claim batches (agent_delivery_claims).
//
// Scope boundaries (docs/m5-delivery-worker-contract.md):
//   - The Store owns persistent facts ONLY. It starts no goroutines, performs
//     no network I/O and keeps no cross-transaction in-memory state. The wire
//     send, connection admission and HTTP/WS presentation belong to
//     machinews/machinecontrol/agentapi.
//   - Every multi-statement operation runs in ONE platformdb.WithWriteTx
//     (IMMEDIATE + authority fence). Transaction-bound *Tx steps are called
//     from the caller's own write transaction. No callback in this package
//     may perform network I/O.
//   - Cross-module LIVE facts (agent machine binding, current launch/session,
//     channel authorization, agent-credential validity) are resolved inside
//     the same transaction through injected typed callbacks. This package
//     never imports agent/channel/message and never trusts a principal string.
//
// Honesty contract: an ACK, including a seq-0 control-notice ack, or a
// daemon_drained transition is a REPORTED RECEIPT, not proof of model
// consumption. The original daemon acknowledges
// from its in-memory starting buffer (agentProcessManager.ts:4361-4388) and
// never re-reports such occurrences after a failed start. This package
// persists receipt facts under those exact semantics and promises nothing
// about exactly-once runtime side effects.
package delivery
