package delivery

import "errors"

// Typed failures. Every receipt-side denial leaves ZERO state change; the
// caller surfaces the error class, never a fabricated success.
var (
	// ErrInvalidInput marks malformed inputs before any write.
	ErrInvalidInput = errors.New("delivery: invalid input")

	// ErrMessageUnknown marks a plan whose message row does not exist in the
	// claimed workspace/channel (fact read, not authorization).
	ErrMessageUnknown = errors.New("delivery: message not found in workspace")

	// ErrOccurrenceUnknown marks an ACK/transition/error naming an occurrence
	// this store never dispatched. Zero state change.
	ErrOccurrenceUnknown = errors.New("delivery: occurrence not found")

	// ErrLegacyAckAmbiguous: a legacy ACK without deliveryId/mentionDelivery
	// arrived for a tracked attempt. It is rejected outright — this store
	// never guesses by max(seq).
	ErrLegacyAckAmbiguous = errors.New("delivery: legacy ack cannot confirm a tracked attempt")

	// ErrIdentityMismatch: the authenticated machine principal, the payload
	// snapshot and the attempt identity snapshot do not agree.
	ErrIdentityMismatch = errors.New("delivery: receipt identity mismatch")

	// ErrControlPathMismatch: AcknowledgeControl was aimed at a tracked
	// message attempt, or AcknowledgeManaged was aimed at a null-message
	// briefing attempt. The two receipts do not cross, and seq 0 is never a
	// watermark.
	ErrControlPathMismatch = errors.New("delivery: receipt path does not match the attempt")

	// ErrAttemptTerminal: the receipt targets an attempt already closed by a
	// different verdict; a receipt cannot overwrite it.
	ErrAttemptTerminal = errors.New("delivery: attempt already terminal")

	// ErrConcurrentModification: a CAS update lost the revision race.
	ErrConcurrentModification = errors.New("delivery: concurrent modification")

	// ErrClaimUnknown remains exported for callers that already branch on it.
	// AckAgentClaim does not return it for a foreign, unclaimed, expired or
	// duplicate batch: those ids remove nothing and leave the queue unchanged.
	ErrClaimUnknown = errors.New("delivery: claim not found for agent")

	// ErrClaimExpired remains exported for callers that already branch on it.
	// An expired lease is not an authenticated claimed row, so AckAgentClaim
	// returns removed_count 0 instead of this error.
	ErrClaimExpired = errors.New("delivery: claim lease expired")

	// ErrClaimInconsistent: a submitted message id is a real positive-seq
	// message whose seq is absent from the submitted seqs. The ack is
	// rejected with zero writes. Seq-less notice ids are not messages and
	// are not subject to this check.
	ErrClaimInconsistent = errors.New("delivery: ack seq and message id disagree")

	// ErrNotBlocked: RequeueBlocked targeted a delivery that is not blocked.
	ErrNotBlocked = errors.New("delivery: delivery is not blocked")

	// ErrNotFound marks a missing delivery in read queries.
	ErrNotFound = errors.New("delivery: not found")
)
