package delivery

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// AgentPrincipal is the authenticated sk_agent_* runner identity handed over
// by the agent API after credential binding. It is typed evidence, never a
// bare principal string: the live revalidation is the injected validator that
// runs INSIDE the claiming transaction.
type AgentPrincipal struct {
	AgentID      string
	WorkspaceID  string
	CredentialID string
}

// AgentPrincipalValidator revalidates the credential, the agent binding and
// the workspace inside the same transaction (agent-owned facts). A revoked
// credential or deleted agent denies the whole operation.
type AgentPrincipalValidator func(ctx context.Context, ex Executor, p AgentPrincipal) error

// ClaimInput bounds one claim batch.
//
// SinceSeq nil is the original "latest" queue: every due claim-path intent,
// including notice-only briefings. A non-nil value is the original
// /events?since=N filter and is applied inside the claim transaction before
// any row is leased or acknowledged: only message seqs strictly greater than
// N are eligible. Notice-only rows have no positive seq, so a set SinceSeq
// omits them and does not acknowledge them. SinceSeq is not a watermark and
// does not acknowledge the rows it skips. A negative value is rejected.
type ClaimInput struct {
	Principal AgentPrincipal
	Limit     int           // <=0 defaults to 50, hard cap 500
	LeaseTTL  time.Duration // <=0 defaults to 10 minutes
	SinceSeq  *int64
	// Project renders the visible page on this claim's executor before the
	// transaction commits. Nil preserves the historical claim path for
	// callers that project after commit. A non-nil error aborts the write.
	Project ClaimProjector
}

// ClaimProjector renders one visible claim page on the same executor that
// leased it, before any acknowledgement. It must not call WithWriteTx or
// WithReadSnapshot: those open a different connection and cannot see this
// transaction. A failure rejects the whole claim, so unseen input is not
// consumed.
type ClaimProjector func(ctx context.Context, ex Executor, page *ClaimResult) error

// ClaimReceipt is the ORIGINAL claim-token shape: the ack batch the caller
// passes back to /events/ack. It contains only seqs/message ids, no secrets.
type ClaimReceipt struct {
	Seqs       []int64
	MessageIDs []string
}

// ClaimedEvent is one claimed delivery projected for the agent API envelope
// (the transport builds the actual message envelope; this is the reference).
type ClaimedEvent struct {
	DeliveryID     string
	MessageID      string
	ConversationID string
	SourceKind     string
	Seq            int64
	CreatedAt      int64
}

// ClaimResult is the claim response.
type ClaimResult struct {
	ClaimID        string
	Claim          ClaimReceipt
	Events         []ClaimedEvent
	LeaseExpiresAt int64
	Reissued       bool
	// HasMore is true only when another authorized eligible row exists beyond
	// this page. An exactly full final page is false. The extra row is not
	// leased or acknowledged by this call.
	HasMore bool
}

// ClaimAgentEvents issues one bounded claim batch for the authenticated
// external runner: revalidate the principal, then lease due claim-path
// intents. The persisted claim digest is an internal receipt of what was
// issued, bound to the (workspace, agent) principal. It is not a secret the
// client must echo. A claim response lost in transit is recovered by
// re-claiming: the same open claim is re-issued (no second budget charge,
// unchanged lease) after a fresh authorization check. SinceSeq filters that
// selection inside the transaction. Rows the filter omits stay claimable and
// are not acknowledged.
func (s *Store) ClaimAgentEvents(ctx context.Context, deps DispatchDeps, validate AgentPrincipalValidator, input ClaimInput) (*ClaimResult, error) {
	if err := deps.validate(); err != nil {
		return nil, err
	}
	if validate == nil {
		return nil, fmt.Errorf("%w: principal validator is required", ErrInvalidInput)
	}
	if err := validateSince(input.SinceSeq); err != nil {
		return nil, err
	}
	limit, leaseTTL := normalizeClaimBounds(input.Limit, input.LeaseTTL)
	nowMs := s.nowMs()

	var result *ClaimResult
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		if err := validate(ctx, tx, input.Principal); err != nil {
			return err
		}
		claimed, err := s.claimTx(ctx, tx, deps, input.Principal, limit, leaseTTL, nowMs, input.SinceSeq, input.Project)
		if err != nil {
			return err
		}
		result = claimed
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func normalizeClaimBounds(limit int, leaseTTL time.Duration) (int, time.Duration) {
	if limit <= 0 {
		limit = claimBatchLimit
	}
	if limit > claimBatchMax {
		limit = claimBatchMax
	}
	if leaseTTL <= 0 {
		leaseTTL = DefaultClaimLeaseTTL
	}
	return limit, leaseTTL
}

func validateSince(since *int64) error {
	if since != nil && *since < 0 {
		return fmt.Errorf("%w: since must be a non-negative integer", ErrInvalidInput)
	}
	return nil
}

func emptyClaimResult() *ClaimResult {
	return &ClaimResult{Events: []ClaimedEvent{}, Claim: ClaimReceipt{Seqs: []int64{}, MessageIDs: []string{}}}
}

// claimTx is the transaction-bound claim core shared by ClaimAgentEvents and
// the legacy drain. since is applied to selection and to an open-claim
// reissue before anything is leased or acknowledged. Omitted rows are not
// acked. When an open claim's visible page is empty, later rows that pass
// since are leased so a low-seq head cannot starve them. project, when set,
// runs after the page is leased and before this function returns, which is
// before a legacy drain acknowledges the page.
func (s *Store) claimTx(ctx context.Context, tx *sql.Tx, deps DispatchDeps, principal AgentPrincipal, limit int, leaseTTL time.Duration, nowMs int64, since *int64, project ClaimProjector) (*ClaimResult, error) {
	result, err := s.assembleClaimTx(ctx, tx, deps, principal, limit, leaseTTL, nowMs, since)
	if err != nil {
		return nil, err
	}
	if project != nil && result != nil && len(result.Events) > 0 {
		if err := project(ctx, tx, result); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (s *Store) assembleClaimTx(ctx context.Context, tx *sql.Tx, deps DispatchDeps, principal AgentPrincipal, limit int, leaseTTL time.Duration, nowMs int64, since *int64) (*ClaimResult, error) {
	if err := validateSince(since); err != nil {
		return nil, err
	}
	if principal.AgentID == "" || principal.WorkspaceID == "" {
		return nil, fmt.Errorf("%w: agent principal is required", ErrInvalidInput)
	}
	if _, err := recoverExpiredLeasesTx(ctx, tx, nowMs); err != nil {
		return nil, err
	}
	// An unexpired open claim is re-issued after a fresh authorization check
	// (idempotent reclaim after a lost response). The lease is NOT extended:
	// re-issuing must not stack a longer finite leasing window. Rows the
	// agent can no longer read are cancelled and omitted from the projection.
	var carry *claimRow
	open, err := openClaimTx(ctx, tx, principal.WorkspaceID, principal.AgentID, nowMs)
	if err != nil {
		return nil, err
	}
	if open != nil {
		// A lost-response reclaim must not replay message ids the agent can
		// no longer read. Unauthorized rows are cancelled and dropped from
		// the projection; an authorize failure aborts the transaction.
		if err := s.reauthorizeOpenClaimTx(ctx, tx, deps, open.ID, nowMs); err != nil {
			return nil, err
		}
		bound, err := projectClaimTx(ctx, tx, open)
		if err != nil {
			return nil, err
		}
		if len(bound.Events) == 0 {
			// Keep the cumulative ACKED count. A claim whose remainder was
			// cancelled still records how many rows this claim did confirm.
			if err := refreshClaimAuditTx(ctx, tx, open.ID, nowMs); err != nil {
				return nil, err
			}
		} else {
			visible, err := pageClaimResult(bound, since, limit)
			if err != nil {
				return nil, err
			}
			if len(visible.Events) > 0 {
				// The internal digest tracks every still-leased row, including
				// rows this since/limit page does not return. The returned
				// receipt is only the page, so a drain cannot ack the rest.
				if err := syncReissuedDigestTx(ctx, tx, principal, open, bound); err != nil {
					return nil, err
				}
				visible.Reissued = true
				more, err := s.claimHasMoreTx(ctx, tx, deps, principal, since, nowMs, bound.Events, visible.Events)
				if err != nil {
					return nil, err
				}
				visible.HasMore = more
				return visible, nil
			}
			// Every leased row was filtered by since. Keep them leased and
			// unacknowledged, and continue so a newer seq can still be claimed.
			carry = open
		}
	}

	due, err := loadClaimableTx(ctx, tx, principal.WorkspaceID, principal.AgentID, nowMs, since, 0, claimBatchMax)
	if err != nil {
		return nil, err
	}
	var claimed []Delivery
	events := []ClaimedEvent{}
	hasMore := false
	pageFull := false
	for i := range due {
		if len(claimed) >= limit {
			pageFull = true
			more, err := s.remainderEligible(ctx, tx, deps, due[i:], nowMs)
			if err != nil {
				return nil, err
			}
			hasMore = more
			if !hasMore && len(due) == claimBatchMax {
				more, err = s.furtherEligibleAfter(ctx, tx, deps, principal.WorkspaceID, principal.AgentID, since, nowMs, due[len(due)-1].DeliveryOrder)
				if err != nil {
					return nil, err
				}
				hasMore = more
			}
			break
		}
		take, err := s.classifyClaimCandidate(ctx, tx, deps, &due[i], nowMs)
		if err != nil {
			return nil, err
		}
		if !take {
			continue
		}
		event, err := eventFromDeliveryTx(ctx, tx, due[i])
		if err != nil {
			return nil, err
		}
		claimed = append(claimed, due[i])
		events = append(events, event)
	}
	if !pageFull && len(due) == claimBatchMax && len(due) > 0 {
		more, err := s.furtherEligibleAfter(ctx, tx, deps, principal.WorkspaceID, principal.AgentID, since, nowMs, due[len(due)-1].DeliveryOrder)
		if err != nil {
			return nil, err
		}
		hasMore = more
	}
	if len(claimed) == 0 {
		if carry != nil {
			out := emptyClaimResult()
			out.ClaimID = carry.ID
			out.LeaseExpiresAt = carry.LeaseExpiresAt
			return out, nil
		}
		return emptyClaimResult(), nil
	}
	bound, err := s.bindClaimTx(ctx, tx, principal, events, claimed, leaseTTL, nowMs, carry)
	if err != nil {
		return nil, err
	}
	bound.HasMore = hasMore
	return bound, nil
}

// classifyClaimCandidate applies the claim-path filters. take reports that
// the row would be leased. Unauthorized and budget-exhausted rows are
// closed the same way the selector always has. A taken row is not modified,
// so a has_more peek can observe it without leasing or acknowledging it.
func (s *Store) classifyClaimCandidate(ctx context.Context, tx *sql.Tx, deps DispatchDeps, d *Delivery, nowMs int64) (bool, error) {
	authorized, reason, err := deps.Authorize(ctx, tx, *d)
	if err != nil {
		return false, err
	}
	if !authorized {
		if err := cancelDeliveryTx(ctx, tx, d, reason, nowMs); err != nil {
			return false, err
		}
		return false, nil
	}
	facts, err := deps.Facts(ctx, tx, d.WorkspaceID, d.AgentID)
	if err != nil {
		return false, err
	}
	if facts.SupportsManagedWire {
		// Managed agents do not drain tracked mentions through the claim
		// inbox; their strong recovery is lease-expiry resend.
		return false, nil
	}
	if BudgetExhausted(d.RetryCount) {
		if err := blockDeliveryTx(ctx, tx, d, TerminalRetryExhausted, nowMs); err != nil {
			return false, err
		}
		return false, nil
	}
	return true, nil
}

// remainderEligible reports whether any not-yet-selected candidate would be
// claimed. The first such row is left pending.
func (s *Store) remainderEligible(ctx context.Context, tx *sql.Tx, deps DispatchDeps, rows []Delivery, nowMs int64) (bool, error) {
	for i := range rows {
		take, err := s.classifyClaimCandidate(ctx, tx, deps, &rows[i], nowMs)
		if err != nil {
			return false, err
		}
		if take {
			return true, nil
		}
	}
	return false, nil
}

// furtherEligibleAfter scans due rows after delivery_order for one claimable
// candidate. It does not lease or acknowledge that candidate.
func (s *Store) furtherEligibleAfter(ctx context.Context, tx *sql.Tx, deps DispatchDeps, workspaceID, agentID string, since *int64, nowMs, afterOrder int64) (bool, error) {
	for {
		rows, err := loadClaimableTx(ctx, tx, workspaceID, agentID, nowMs, since, afterOrder, claimBatchMax)
		if err != nil {
			return false, err
		}
		if len(rows) == 0 {
			return false, nil
		}
		more, err := s.remainderEligible(ctx, tx, deps, rows, nowMs)
		if err != nil || more || len(rows) < claimBatchMax {
			return more, err
		}
		afterOrder = rows[len(rows)-1].DeliveryOrder
	}
}

// claimHasMoreTx is the reissue page's has_more: leased rows the page did
// not return count, and so does one later authorized eligible row that this
// call does not lease.
func (s *Store) claimHasMoreTx(ctx context.Context, tx *sql.Tx, deps DispatchDeps, principal AgentPrincipal, since *int64, nowMs int64, bound, page []ClaimedEvent) (bool, error) {
	if visibleCount(bound, since) > len(page) {
		return true, nil
	}
	return s.furtherEligibleAfter(ctx, tx, deps, principal.WorkspaceID, principal.AgentID, since, nowMs, 0)
}

func visibleCount(events []ClaimedEvent, since *int64) int {
	n := 0
	for _, event := range events {
		if claimEventVisible(event, since) {
			n++
		}
	}
	return n
}

// bindClaimTx leases the selected deliveries onto a claim. carry, when set,
// is the open claim whose visible page was empty; new rows join it without
// extending its lease and without acknowledging the rows since omitted.
// The returned receipt lists only events, never the omitted prefix.
func (s *Store) bindClaimTx(ctx context.Context, tx *sql.Tx, principal AgentPrincipal, events []ClaimedEvent, claimed []Delivery, leaseTTL time.Duration, nowMs int64, carry *claimRow) (*ClaimResult, error) {
	receipt, err := receiptFromEvents(events)
	if err != nil {
		return nil, err
	}
	leaseMs := nowMs + leaseTTL.Milliseconds()
	claimID := ""
	if carry != nil {
		claimID = carry.ID
		leaseMs = carry.LeaseExpiresAt
	} else {
		digest := digestClaimBatch(principal.WorkspaceID, principal.AgentID, receipt.Seqs, receipt.MessageIDs)
		// The same batch digest may already have an UNACKNOWLEDGED row: unexpired
		// means a lost-response reclaim (handled above via openClaimTx), expired
		// means the claimant died and the same batch is re-leased as a fresh
		// finite claim on the existing row.
		if stale, err := claimByDigestTx(ctx, tx, principal.WorkspaceID, principal.AgentID, digest); err != nil {
			return nil, err
		} else if stale != nil {
			claimID = stale.ID
			if _, err := tx.ExecContext(ctx,
				`UPDATE agent_delivery_claims SET lease_expires_at = ?, event_count = ?, created_at = ? WHERE id = ?`,
				leaseMs, len(events), nowMs, claimID); err != nil {
				return nil, fmt.Errorf("revive claim: %w", err)
			}
		} else {
			id, err := newTokenID()
			if err != nil {
				return nil, fmt.Errorf("mint claim id: %w", err)
			}
			claimID = id
			if _, err := tx.ExecContext(ctx, `INSERT INTO agent_delivery_claims
				(id, workspace_id, agent_id, claim_digest, event_count, lease_expires_at, created_at)
				VALUES (?,?,?,?,?,?,?)`,
				claimID, principal.WorkspaceID, principal.AgentID,
				digest, len(events), leaseMs, nowMs); err != nil {
				return nil, fmt.Errorf("insert claim: %w", err)
			}
		}
	}
	for i := range claimed {
		d := claimed[i]
		if err := s.leaseClaimAttemptTx(ctx, tx, &d, claimID, leaseMs, nowMs); err != nil {
			return nil, err
		}
	}
	if carry != nil {
		full, err := projectClaimTx(ctx, tx, &claimRow{ID: claimID, LeaseExpiresAt: leaseMs, Digest: carry.Digest})
		if err != nil {
			return nil, err
		}
		if err := syncReissuedDigestTx(ctx, tx, principal, carry, full); err != nil {
			return nil, err
		}
	}
	return &ClaimResult{
		ClaimID:        claimID,
		Claim:          receipt,
		Events:         events,
		LeaseExpiresAt: leaseMs,
	}, nil
}

// leaseClaimAttemptTx supersedes any stale open attempt of the delivery and
// binds a fresh external_claim occurrence to the new claim. The budget is
// charged exactly once per fresh claim issue (in the delivery transition
// below); an idempotent re-issue never reaches this function.
func (s *Store) leaseClaimAttemptTx(ctx context.Context, ex Executor, d *Delivery, claimID string, leaseMs, nowMs int64) error {
	open, err := openAttemptForDeliveryTx(ctx, ex, d.ID)
	if err != nil {
		return err
	}
	if open != nil {
		ok, err := terminateAttemptTx(ctx, ex, open.OccurrenceID, TerminalLeaseExpired, open.Revision, nowMs)
		if err != nil {
			return err
		}
		if !ok {
			return ErrConcurrentModification
		}
	}
	occurrence, err := newTokenID()
	if err != nil {
		return fmt.Errorf("mint occurrence: %w", err)
	}
	var nextNumber int64 = 1
	if err := ex.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM agent_delivery_attempts WHERE delivery_id = ?`,
		d.ID).Scan(&nextNumber); err != nil {
		return err
	}
	if _, err := ex.ExecContext(ctx, `INSERT INTO agent_delivery_attempts
		(occurrence_id, delivery_id, attempt_number, workspace_id, agent_id, message_id,
		 machine_id_snapshot, launch_id_snapshot, session_id_snapshot, transport_kind,
		 claim_id, lease_expires_at, retry_count, state, terminal_code, revision, created_at, updated_at)
		VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,0,'in_flight',NULL,1,?,?)`,
		occurrence, d.ID, nextNumber, d.WorkspaceID, d.AgentID, d.MessageID,
		TransportExternalClaim, claimID, leaseMs, nowMs, nowMs); err != nil {
		return fmt.Errorf("insert claim attempt: %w", err)
	}
	newRetry := d.RetryCount + 1
	return transitionDeliveryTx(ctx, ex, d, DeliveryTransition{
		State:          StateLeased,
		RetryCount:     &newRetry,
		LeaseExpiresAt: sql.NullInt64{Int64: leaseMs, Valid: true},
		ErrorCode:      sql.NullString{},
	}, nowMs)
}

// ClaimAckInput acknowledges one previously claimed batch.
type ClaimAckInput struct {
	Principal AgentPrincipal
	Claim     ClaimReceipt
}

// ClaimAckResult is the idempotent ack outcome.
type ClaimAckResult struct {
	RemovedCount int64
}

// AckAgentClaim acknowledges the authenticated intersection of the submitted
// seqs and notice ids with this agent's currently leased claim rows. It does
// not require the exact issued-batch digest and it does not treat the max
// seq as a watermark. Foreign, unclaimed, expired and duplicate ids remove
// nothing. A public message id whose positive seq is absent from seqs fails
// the transaction closed (ErrClaimInconsistent) with zero writes. The
// injected authorization callback revalidates every matched delivery's
// current conversation read right inside the same transaction; revoked
// intents are cancelled instead of acknowledged and are not counted.
// Unmatched leased rows stay claimable.
//
// Lease-generation boundary: the wire has no claim id, generation or
// signature. The same agent acknowledging the same message seq after the
// lease was renewed confirms the current leased row. A superseded or
// cancelled attempt is not rewritten to ACKED.
func (s *Store) AckAgentClaim(ctx context.Context, deps DispatchDeps, validate AgentPrincipalValidator, input ClaimAckInput) (*ClaimAckResult, error) {
	if err := deps.validate(); err != nil {
		return nil, err
	}
	if validate == nil {
		return nil, fmt.Errorf("%w: principal validator is required", ErrInvalidInput)
	}
	nowMs := s.nowMs()
	var result *ClaimAckResult
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		if err := validate(ctx, tx, input.Principal); err != nil {
			return err
		}
		acked, err := s.ackClaimTx(ctx, tx, deps, input.Principal, input.Claim, nowMs)
		if err != nil {
			return err
		}
		result = acked
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// ackClaimTx is the transaction-bound ack core shared with the legacy drain.
// It confirms only leased external-claim rows the submitted keys name.
// Everything else removes 0. Seq/message disagreement fails closed before
// any update.
func (s *Store) ackClaimTx(ctx context.Context, ex Executor, deps DispatchDeps, principal AgentPrincipal, receipt ClaimReceipt, nowMs int64) (*ClaimAckResult, error) {
	if principal.AgentID == "" || principal.WorkspaceID == "" {
		return nil, fmt.Errorf("%w: agent principal is required", ErrInvalidInput)
	}
	if len(receipt.Seqs) > claimBatchMax || len(receipt.MessageIDs) > claimBatchMax {
		return nil, fmt.Errorf("%w: ack batch exceeds %d", ErrInvalidInput, claimBatchMax)
	}
	if err := ackListsConsistentTx(ctx, ex, principal.WorkspaceID, receipt.Seqs, receipt.MessageIDs); err != nil {
		return nil, err
	}
	seqSet := positiveSeqSet(receipt.Seqs)
	idSet := noticeIDSet(receipt.MessageIDs)
	if len(seqSet) == 0 && len(idSet) == 0 {
		return &ClaimAckResult{RemovedCount: 0}, nil
	}
	leased, err := loadLeasedClaimsTx(ctx, ex, principal.WorkspaceID, principal.AgentID, nowMs)
	if err != nil {
		return nil, err
	}
	var count int64
	touched := map[string]struct{}{}
	for i := range leased {
		row := leased[i]
		if !row.selectedBy(seqSet, idSet) {
			continue
		}
		authorized, reason, err := deps.Authorize(ctx, ex, row.Delivery)
		if err != nil {
			return nil, err
		}
		if !authorized {
			if reason == "" {
				reason = "authorization_revoked"
			}
			ok, err := terminateAttemptTx(ctx, ex, row.OccurrenceID, TerminalCancelled, row.AttemptRev, nowMs)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, ErrConcurrentModification
			}
			if err := cancelDeliveryTx(ctx, ex, &row.Delivery, reason, nowMs); err != nil {
				return nil, err
			}
			touched[row.ClaimID] = struct{}{}
			continue
		}
		if err := ackExternalAttemptTx(ctx, ex, row.OccurrenceID, row.AttemptRev, nowMs); err != nil {
			return nil, err
		}
		if err := ackLeasedDeliveryTx(ctx, ex, &row.Delivery, nowMs); err != nil {
			return nil, err
		}
		touched[row.ClaimID] = struct{}{}
		count++
	}
	for claimID := range touched {
		if err := refreshClaimAuditTx(ctx, ex, claimID, nowMs); err != nil {
			return nil, err
		}
	}
	return &ClaimAckResult{RemovedCount: count}, nil
}

// LegacyDrainQuery is the explicit since/limit selector for the legacy
// destructive drain. SinceSeq nil is "latest" and preserves DrainLegacyEvents.
// A non-nil SinceSeq is applied inside the same transaction before the
// automatic ack, so omitted deliveries are not confirmed and do not block
// later seqs.
type LegacyDrainQuery struct {
	Principal AgentPrincipal
	Limit     int
	SinceSeq  *int64
	// Project renders the page before the automatic acknowledgement. Nil
	// keeps the historical drain, which returns events and lets the caller
	// project after commit. Production passes a projector so a render
	// failure rolls the acknowledgement back.
	Project ClaimProjector
}

// DrainLegacyEvents is the legacy GET /events semantic with no since filter:
// claim and IMMEDIATELY acknowledge in ONE transaction (destructive drain —
// returning the batch means it is confirmed). A lost HTTP response after
// commit keeps the claim acknowledged: that inherent response-loss window is
// the original protocol's documented weak semantics, kept separate from
// claim/ack. Callers that must honor since use DrainLegacyEventsQuery.
func (s *Store) DrainLegacyEvents(ctx context.Context, deps DispatchDeps, validate AgentPrincipalValidator, principal AgentPrincipal, limit int) ([]ClaimedEvent, int64, error) {
	return s.DrainLegacyEventsQuery(ctx, deps, validate, LegacyDrainQuery{Principal: principal, Limit: limit})
}

// DrainLegacyEventsQuery is DrainLegacyEvents with an explicit since filter.
// Only the events returned by this call are acknowledged.
func (s *Store) DrainLegacyEventsQuery(ctx context.Context, deps DispatchDeps, validate AgentPrincipalValidator, query LegacyDrainQuery) ([]ClaimedEvent, int64, error) {
	if err := deps.validate(); err != nil {
		return nil, 0, err
	}
	if validate == nil {
		return nil, 0, fmt.Errorf("%w: principal validator is required", ErrInvalidInput)
	}
	if err := validateSince(query.SinceSeq); err != nil {
		return nil, 0, err
	}
	bounds, _ := normalizeClaimBounds(query.Limit, 0)
	nowMs := s.nowMs()
	var events []ClaimedEvent
	var removed int64
	err := s.withWriteTx(ctx, func(tx *sql.Tx) error {
		if err := validate(ctx, tx, query.Principal); err != nil {
			return err
		}
		claim, err := s.claimTx(ctx, tx, deps, query.Principal, bounds, DefaultClaimLeaseTTL, nowMs, query.SinceSeq, query.Project)
		if err != nil {
			return err
		}
		if len(claim.Events) == 0 {
			events = claim.Events
			return nil
		}
		acked, err := s.ackClaimTx(ctx, tx, deps, query.Principal, claim.Claim, nowMs)
		if err != nil {
			return err
		}
		events = claim.Events
		removed = acked.RemovedCount
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	if events == nil {
		events = []ClaimedEvent{}
	}
	return events, removed, nil
}

// claimDeliveriesTx loads the deliveries bound to one claim's in-flight
// attempts (already de-duplicated by delivery_id).
func claimDeliveriesTx(ctx context.Context, ex Executor, claimID string) ([]Delivery, error) {
	rows, err := ex.QueryContext(ctx, `SELECT DISTINCT `+deliveryColumns+`
		FROM agent_deliveries d
		WHERE d.id IN (
			SELECT delivery_id FROM agent_delivery_attempts WHERE claim_id = ? AND state = 'in_flight'
		)
		ORDER BY d.delivery_order`, claimID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Delivery
	for rows.Next() {
		d, err := scanDelivery(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// ---- claim row helpers ----

type claimRow struct {
	ID             string
	WorkspaceID    string
	AgentID        string
	Digest         string
	EventCount     int64
	LeaseExpiresAt int64
}

// reauthorizeOpenClaimTx re-checks every delivery still bound to an open
// claim. Unauthorized deliveries are cancelled and their attempt is closed
// so projectClaimTx cannot return them. An authorize error is returned as-is.
func (s *Store) reauthorizeOpenClaimTx(ctx context.Context, ex Executor, deps DispatchDeps, claimID string, nowMs int64) error {
	bound, err := claimDeliveriesTx(ctx, ex, claimID)
	if err != nil {
		return err
	}
	for i := range bound {
		d := bound[i]
		authorized, reason, err := deps.Authorize(ctx, ex, d)
		if err != nil {
			return err
		}
		if authorized {
			continue
		}
		if reason == "" {
			reason = "authorization_revoked"
		}
		open, err := openAttemptForDeliveryTx(ctx, ex, d.ID)
		if err != nil {
			return err
		}
		if open != nil && open.ClaimID.Valid && open.ClaimID.String == claimID {
			ok, err := terminateAttemptTx(ctx, ex, open.OccurrenceID, TerminalCancelled, open.Revision, nowMs)
			if err != nil {
				return err
			}
			if !ok {
				return ErrConcurrentModification
			}
		}
		if err := cancelDeliveryTx(ctx, ex, &d, reason, nowMs); err != nil {
			return err
		}
	}
	return nil
}

// syncReissuedDigestTx keeps the persisted digest equal to the batch that
// was actually projected. Unchanged authorizations leave the digest alone so
// a lost-response reclaim stays idempotent.
func syncReissuedDigestTx(ctx context.Context, ex Executor, principal AgentPrincipal, open *claimRow, projected *ClaimResult) error {
	digest := digestClaimBatch(principal.WorkspaceID, principal.AgentID, projected.Claim.Seqs, projected.Claim.MessageIDs)
	if digest == open.Digest {
		return nil
	}
	res, err := ex.ExecContext(ctx,
		`UPDATE agent_delivery_claims SET claim_digest = ?, event_count = ?
		 WHERE id = ? AND acked_at IS NULL`,
		digest, len(projected.Events), open.ID)
	if err != nil {
		return fmt.Errorf("refresh claim digest: %w", err)
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrConcurrentModification
	}
	return nil
}

// openClaimTx returns the agent's unexpired, unacknowledged claim, if any.
func openClaimTx(ctx context.Context, ex Executor, workspaceID, agentID string, nowMs int64) (*claimRow, error) {
	var row claimRow
	err := ex.QueryRowContext(ctx, `SELECT id, workspace_id, agent_id, claim_digest, event_count, lease_expires_at
		FROM agent_delivery_claims
		WHERE workspace_id = ? AND agent_id = ? AND acked_at IS NULL AND lease_expires_at > ?
		ORDER BY created_at DESC LIMIT 1`, workspaceID, agentID, nowMs).
		Scan(&row.ID, &row.WorkspaceID, &row.AgentID, &row.Digest, &row.EventCount, &row.LeaseExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// claimByDigestTx finds the agent's UNACKNOWLEDGED row for one digest,
// regardless of lease state (an expired row is revived by a fresh claim of
// the same batch instead of stacking a duplicate digest row).
func claimByDigestTx(ctx context.Context, ex Executor, workspaceID, agentID, digest string) (*claimRow, error) {
	var row claimRow
	err := ex.QueryRowContext(ctx, `SELECT id, workspace_id, agent_id, claim_digest, event_count, lease_expires_at
		FROM agent_delivery_claims
		WHERE workspace_id = ? AND agent_id = ? AND claim_digest = ? AND acked_at IS NULL`,
		workspaceID, agentID, digest).
		Scan(&row.ID, &row.WorkspaceID, &row.AgentID, &row.Digest, &row.EventCount, &row.LeaseExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// DeliveryOnExecutor loads one delivery on the caller's executor. Inbox
// projection uses it inside the claim transaction; it does not open another
// transaction or snapshot.
func DeliveryOnExecutor(ctx context.Context, ex Executor, id string) (*Delivery, error) {
	if ex == nil || strings.TrimSpace(id) == "" {
		return nil, fmt.Errorf("%w: delivery id is required", ErrInvalidInput)
	}
	row, err := deliveryByIDTx(ctx, ex, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, fmt.Errorf("%w: delivery %s not found", ErrInvalidInput, id)
	}
	return row, nil
}

// projectClaimTx rebuilds the claim response from the attempts bound to the
// claim (the persisted digest is never reversible; the batch is recovered
// from the bound rows joined with messages.seq). Positive-seq messages
// contribute only seqs. Notice-only rows contribute their delivery id and
// never seq 0.
func projectClaimTx(ctx context.Context, ex Executor, claim *claimRow) (*ClaimResult, error) {
	rows, err := ex.QueryContext(ctx, `SELECT a.delivery_id, a.message_id, d.conversation_id, d.source_kind,
		d.created_at, m.seq
		FROM agent_delivery_attempts a
		JOIN agent_deliveries d ON d.id = a.delivery_id
		LEFT JOIN messages m ON m.id = a.message_id AND m.workspace_id = a.workspace_id
		WHERE a.claim_id = ? AND a.state = 'in_flight'
		ORDER BY d.delivery_order`, claim.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []ClaimedEvent{}
	for rows.Next() {
		var e ClaimedEvent
		var messageID, conversation sql.NullString
		var seq sql.NullInt64
		if err := rows.Scan(&e.DeliveryID, &messageID, &conversation, &e.SourceKind, &e.CreatedAt, &seq); err != nil {
			return nil, err
		}
		e.ConversationID = conversation.String
		if e.SourceKind == SourceMessage {
			if !messageID.Valid || !seq.Valid || seq.Int64 <= 0 {
				return nil, fmt.Errorf("claim: delivery %s references a missing message", e.DeliveryID)
			}
			e.MessageID = messageID.String
			e.Seq = seq.Int64
		}
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	receipt, err := receiptFromEvents(events)
	if err != nil {
		return nil, err
	}
	return &ClaimResult{
		ClaimID:        claim.ID,
		Claim:          receipt,
		Events:         events,
		LeaseExpiresAt: claim.LeaseExpiresAt,
	}, nil
}

// loadClaimableTx selects the agent's due claim-path candidates. since is
// pushed into the query so a low-seq head does not consume the scan and
// starve a later seq. Notice-only rows have no messages.seq, so they are
// selected only when since is nil.
func loadClaimableTx(ctx context.Context, ex Executor, workspaceID, agentID string, nowMs int64, since *int64, afterOrder int64, limit int) ([]Delivery, error) {
	sinceActive := 0
	sinceSeq := int64(0)
	if since != nil {
		sinceActive = 1
		sinceSeq = *since
	}
	rows, err := ex.QueryContext(ctx, `SELECT `+deliveryColumns+` FROM agent_deliveries
		WHERE workspace_id = ? AND agent_id = ?
		  AND delivery_order > ?
		  AND ((scheduling_state IN ('pending','waiting_machine','waiting_identity') AND next_attempt_at <= ?)
		    OR (scheduling_state = 'leased' AND lease_expires_at <= ?))
		  AND (? = 0 OR EXISTS (
		        SELECT 1 FROM messages m
		        WHERE m.id = agent_deliveries.message_id
		          AND m.workspace_id = agent_deliveries.workspace_id
		          AND m.seq > ?))
		ORDER BY delivery_order LIMIT ?`,
		workspaceID, agentID, afterOrder, nowMs, nowMs, sinceActive, sinceSeq, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Delivery
	for rows.Next() {
		d, err := scanDelivery(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *d)
	}
	return out, rows.Err()
}

// eventFromDeliveryTx projects one delivery into the claim envelope. A
// briefing contributes no public message id and no seq.
func eventFromDeliveryTx(ctx context.Context, ex Executor, d Delivery) (ClaimedEvent, error) {
	event := ClaimedEvent{
		DeliveryID:     d.ID,
		ConversationID: d.ConversationID.String,
		SourceKind:     d.SourceKind,
		CreatedAt:      d.CreatedAt,
	}
	if d.SourceKind != SourceMessage || !d.MessageID.Valid {
		event.SourceKind = d.SourceKind
		return event, nil
	}
	seq, found, err := messageSeqTx(ctx, ex, d.WorkspaceID, d.MessageID.String)
	if err != nil {
		return ClaimedEvent{}, err
	}
	if !found || seq <= 0 {
		return ClaimedEvent{}, fmt.Errorf("claim: delivery %s references a missing message", d.ID)
	}
	event.MessageID = d.MessageID.String
	event.Seq = seq
	return event, nil
}

// receiptFromEvents is the original ack shape: positive seqs only, and
// message ids only for rows that have no positive seq. The notice id of a
// briefing is its delivery id. Seq 0 is never emitted.
func receiptFromEvents(events []ClaimedEvent) (ClaimReceipt, error) {
	seqs := []int64{}
	ids := []string{}
	for _, event := range events {
		if event.SourceKind == SourceBriefing || event.MessageID == "" || event.Seq <= 0 {
			if event.DeliveryID == "" {
				return ClaimReceipt{}, fmt.Errorf("%w: notice delivery id is required", ErrInvalidInput)
			}
			ids = append(ids, event.DeliveryID)
			continue
		}
		seqs = append(seqs, event.Seq)
	}
	return ClaimReceipt{Seqs: seqs, MessageIDs: ids}, nil
}

// pageClaimResult returns at most limit events that pass since, in
// delivery order. The receipt covers only that page.
func pageClaimResult(full *ClaimResult, since *int64, limit int) (*ClaimResult, error) {
	events := []ClaimedEvent{}
	for _, event := range full.Events {
		if !claimEventVisible(event, since) {
			continue
		}
		events = append(events, event)
		if len(events) >= limit {
			break
		}
	}
	receipt, err := receiptFromEvents(events)
	if err != nil {
		return nil, err
	}
	return &ClaimResult{
		ClaimID:        full.ClaimID,
		Claim:          receipt,
		Events:         events,
		LeaseExpiresAt: full.LeaseExpiresAt,
	}, nil
}

func claimEventVisible(event ClaimedEvent, since *int64) bool {
	if since == nil {
		return true
	}
	return event.SourceKind == SourceMessage && event.MessageID != "" && event.Seq > *since
}

func positiveSeqSet(seqs []int64) map[int64]struct{} {
	out := make(map[int64]struct{}, len(seqs))
	for _, seq := range seqs {
		if seq > 0 {
			out[seq] = struct{}{}
		}
	}
	return out
}

func noticeIDSet(ids []string) map[string]struct{} {
	out := make(map[string]struct{}, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id != "" {
			out[id] = struct{}{}
		}
	}
	return out
}

// ackListsConsistentTx rejects a public message id whose positive seq is
// not also submitted. Notice ids that are not message rows are left for the
// intersection. The check is read-only.
func ackListsConsistentTx(ctx context.Context, ex Executor, workspaceID string, seqs []int64, messageIDs []string) error {
	seqSet := positiveSeqSet(seqs)
	ids := make([]string, 0, len(messageIDs))
	seen := map[string]struct{}{}
	for _, raw := range messageIDs {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil
	}
	found, err := messageSeqsByIDTx(ctx, ex, workspaceID, ids)
	if err != nil {
		return err
	}
	for _, id := range ids {
		seq, ok := found[id]
		if !ok {
			continue
		}
		if _, listed := seqSet[seq]; !listed || seq <= 0 {
			return fmt.Errorf("%w: message %s seq %d is not in ack seqs", ErrClaimInconsistent, id, seq)
		}
	}
	return nil
}

func messageSeqsByIDTx(ctx context.Context, ex Executor, workspaceID string, ids []string) (map[string]int64, error) {
	placeholders := make([]string, len(ids))
	args := make([]any, 0, len(ids)+1)
	args = append(args, workspaceID)
	for i, id := range ids {
		placeholders[i] = "?"
		args = append(args, id)
	}
	rows, err := ex.QueryContext(ctx, `SELECT id, seq FROM messages WHERE workspace_id = ? AND id IN (`+strings.Join(placeholders, ",")+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var id string
		var seq int64
		if err := rows.Scan(&id, &seq); err != nil {
			return nil, err
		}
		out[id] = seq
	}
	return out, rows.Err()
}

// leasedClaim is one unexpired in-flight external claim row. Superseded,
// cancelled and already-acknowledged attempts are not loaded.
type leasedClaim struct {
	Delivery      Delivery
	OccurrenceID  string
	AttemptNumber int64
	AttemptRev    int64
	ClaimID       string
	Seq           int64
}

func (c leasedClaim) selectedBy(seqSet map[int64]struct{}, idSet map[string]struct{}) bool {
	if c.Delivery.SourceKind == SourceBriefing || !c.Delivery.MessageID.Valid {
		_, ok := idSet[c.Delivery.ID]
		return ok
	}
	if c.Seq <= 0 {
		return false
	}
	_, ok := seqSet[c.Seq]
	return ok
}

func loadLeasedClaimsTx(ctx context.Context, ex Executor, workspaceID, agentID string, nowMs int64) ([]leasedClaim, error) {
	rows, err := ex.QueryContext(ctx, `SELECT
		d.id, d.delivery_order, d.workspace_id, d.agent_id, d.source_kind, d.source_id,
		d.message_id, d.conversation_id, d.scheduling_state, d.retry_count, d.next_attempt_at,
		d.lease_expires_at, d.last_error_code, d.acknowledged_at, d.revision, d.created_at, d.updated_at,
		a.occurrence_id, a.attempt_number, a.revision, a.claim_id, m.seq
		FROM agent_delivery_attempts a
		JOIN agent_deliveries d ON d.id = a.delivery_id
		LEFT JOIN messages m ON m.id = d.message_id AND m.workspace_id = d.workspace_id
		WHERE a.workspace_id = ? AND a.agent_id = ?
		  AND a.state = 'in_flight' AND a.transport_kind = ?
		  AND a.lease_expires_at > ?
		  AND d.scheduling_state = 'leased'
		ORDER BY d.delivery_order, a.attempt_number`,
		workspaceID, agentID, TransportExternalClaim, nowMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	best := map[string]leasedClaim{}
	order := []string{}
	for rows.Next() {
		var item leasedClaim
		var seq sql.NullInt64
		if err := rows.Scan(
			&item.Delivery.ID, &item.Delivery.DeliveryOrder, &item.Delivery.WorkspaceID, &item.Delivery.AgentID,
			&item.Delivery.SourceKind, &item.Delivery.SourceID, &item.Delivery.MessageID, &item.Delivery.ConversationID,
			&item.Delivery.SchedulingState, &item.Delivery.RetryCount, &item.Delivery.NextAttemptAt, &item.Delivery.LeaseExpiresAt,
			&item.Delivery.LastErrorCode, &item.Delivery.AcknowledgedAt, &item.Delivery.Revision, &item.Delivery.CreatedAt, &item.Delivery.UpdatedAt,
			&item.OccurrenceID, &item.AttemptNumber, &item.AttemptRev, &item.ClaimID, &seq,
		); err != nil {
			return nil, err
		}
		item.Seq = seq.Int64
		if prev, ok := best[item.Delivery.ID]; ok && item.AttemptNumber <= prev.AttemptNumber {
			continue
		}
		if _, ok := best[item.Delivery.ID]; !ok {
			order = append(order, item.Delivery.ID)
		}
		best[item.Delivery.ID] = item
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]leasedClaim, 0, len(order))
	for _, id := range order {
		out = append(out, best[id])
	}
	return out, nil
}

func ackExternalAttemptTx(ctx context.Context, ex Executor, occurrenceID string, revision, nowMs int64) error {
	res, err := ex.ExecContext(ctx, `UPDATE agent_delivery_attempts
		SET state = 'terminal', terminal_code = 'ACKED', acked_at = ?, revision = revision + 1, updated_at = ?
		WHERE occurrence_id = ? AND state = 'in_flight' AND revision = ?`,
		nowMs, nowMs, occurrenceID, revision)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConcurrentModification
	}
	return nil
}

func ackLeasedDeliveryTx(ctx context.Context, ex Executor, d *Delivery, nowMs int64) error {
	res, err := ex.ExecContext(ctx, `UPDATE agent_deliveries
		SET scheduling_state = 'acknowledged', acknowledged_at = ?, revision = revision + 1,
		    updated_at = ?, lease_expires_at = NULL, last_error_code = NULL
		WHERE id = ? AND revision = ? AND scheduling_state = 'leased'`,
		nowMs, nowMs, d.ID, d.Revision)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConcurrentModification
	}
	return nil
}

// refreshClaimAuditTx records how many attempts of this claim are still
// leased versus already acknowledged. acked_at is set only when nothing
// in-flight remains, so a partial ack stays reissuable.
func refreshClaimAuditTx(ctx context.Context, ex Executor, claimID string, nowMs int64) error {
	var inflight, acked int64
	if err := ex.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_delivery_attempts
		WHERE claim_id = ? AND state = 'in_flight'`, claimID).Scan(&inflight); err != nil {
		return err
	}
	if err := ex.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_delivery_attempts
		WHERE claim_id = ? AND terminal_code = 'ACKED'`, claimID).Scan(&acked); err != nil {
		return err
	}
	if inflight == 0 {
		_, err := ex.ExecContext(ctx, `UPDATE agent_delivery_claims
			SET acked_at = ?, event_count = 0, removed_count = ?
			WHERE id = ? AND acked_at IS NULL`, nowMs, acked, claimID)
		return err
	}
	_, err := ex.ExecContext(ctx, `UPDATE agent_delivery_claims
		SET event_count = ?, removed_count = ?
		WHERE id = ? AND acked_at IS NULL`, inflight, acked, claimID)
	return err
}
