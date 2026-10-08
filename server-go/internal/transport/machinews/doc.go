// Package machinews implements the legacy Daemon machine connection
// transport: the raw WebSocket endpoint POSTed at /daemon/connect by the
// original raft daemon (packages/daemon) and managed Computers.
//
// The protocol is ported from the TypeScript server:
//
//   - packages/server/src/routes/daemon.ts        (handshake auth + upgrade)
//   - packages/server/src/services/machineContext.ts (first machine:context frame)
//   - packages/server/src/services/agentOrchestrator.ts (registerMachine,
//     handleMachineMessage, handleMachineDisconnect, heartbeat, ready)
//   - packages/shared/src/index.ts                (MachineToServerMessage /
//     ServerToMachineMessage unions)
//
// Scope boundary: this package owns the TRANSPORT lifecycle only —
// authentication, registration, generation-fenced callbacks, heartbeat,
// replacement, revocation and delayed disconnect projection. Message
// semantics above the transport (agent start/delivery, migration, briefings)
// are delegated to the injected Agent-store callbacks and are never
// fake-acked here.
package machinews
