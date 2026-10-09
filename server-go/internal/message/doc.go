// Package message owns the M4 human message facts: creation with global seq
// allocation and random-id idempotency, channel history/context reads with
// receiver-visible coverage, the bounded visibility-correct sync scan, human
// structured mentions and human reactions with their shared/private
// projections.
//
// Boundaries frozen in docs/m4-execution-lock.md:
//   - Every mutation runs inside one db.WithWriteTx and revalidates the full
//     auth.AccessTokenClaims through auth.ValidateHumanTx inside that
//     transaction; sender identity never comes from a request body.
//   - Channel visibility/membership authority is delegated to the locked
//     channel.Store transaction APIs (channel_seam.go); this package never
//     writes channel_humans or any other channel-owned table. Thread follow
//     mutations go exclusively through channel.SetThreadFollowTx.
//   - publication.Enqueue is called inside the same transaction as the fact it
//     references; transport (Socket.IO) is a downstream consumer of those
//     publications and is never imported here.
//   - Agent messages, agent/task/attachment effects are explicitly rejected
//     before commit (never silently accepted), per the approved M4 scope.
//
// Wire projections for the legacy HTTP surface live in the message DTO
// (dto.go); the humanapi transport renders them without re-deriving fields.
package message
