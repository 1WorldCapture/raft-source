package delivery

import (
	"context"
	"errors"
	"testing"
	"time"
)

func claimDeps() DispatchDeps {
	return DispatchDeps{
		Facts: factsPerAgent(map[string]DispatchFacts{
			txAgentE: externalFacts(),
			txAgentM: fullFacts(txMachine1, "launch-1", "session-1"),
		}),
		Authorize: allowAll,
	}
}

func principalE() AgentPrincipal {
	return AgentPrincipal{AgentID: txAgentE, WorkspaceID: txWS, CredentialID: "cred-1"}
}

func TestClaimAndAckHappyPath(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, _ := f.seedMessage("m1")
	msg2, _ := f.seedMessage("m2")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	if err := f.planMessage(msg2, txAgentE); err != nil {
		t.Fatal(err)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	if claim.Reissued {
		t.Fatal("first claim is fresh")
	}
	if len(claim.Events) != 2 || len(claim.Claim.Seqs) != 2 || len(claim.Claim.MessageIDs) != 0 {
		t.Fatalf("positive-seq claim shape wrong: %+v", claim.Claim)
	}
	for _, seq := range claim.Claim.Seqs {
		if seq <= 0 {
			t.Fatalf("ack seq must be positive, got %d", seq)
		}
	}
	for _, e := range claim.Events {
		d := f.deliveryByID(e.DeliveryID)
		if d.SchedulingState != StateLeased || d.RetryCount != 1 {
			t.Fatalf("claimed delivery must be leased with budget 1: %+v", d)
		}
		if f.openAttempt(d.ID) == nil {
			t.Fatal("claim must bind an external attempt")
		}
	}
	var digests int
	if err := f.db.QueryRow(
		`SELECT COUNT(*) FROM agent_delivery_claims WHERE acked_at IS NULL`).Scan(&digests); err != nil {
		t.Fatal(err)
	}
	if digests != 1 {
		t.Fatalf("exactly one open claim digest expected, got %d", digests)
	}
	ack, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{Principal: principalE(), Claim: claim.Claim})
	if err != nil {
		t.Fatal(err)
	}
	if ack.RemovedCount != 2 {
		t.Fatalf("removed = %d; want 2", ack.RemovedCount)
	}
	for _, e := range claim.Events {
		d := f.deliveryByID(e.DeliveryID)
		if d.SchedulingState != StateAcknowledged || !d.AcknowledgedAt.Valid {
			t.Fatalf("acked delivery wrong: %+v", d)
		}
		a := f.openAttempt(d.ID)
		if a != nil {
			t.Fatal("claim attempts must be terminal after ack")
		}
	}
}

func TestClaimReissueIsIdempotentAfterLostResponse(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, _ := f.seedMessage("m1")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	first, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	// The HTTP response was lost; the runner re-claims the same batch.
	second, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	if !second.Reissued || second.ClaimID != first.ClaimID {
		t.Fatalf("reclaim must reissue the same claim: %+v vs %+v", first, second)
	}
	if second.LeaseExpiresAt != first.LeaseExpiresAt {
		t.Fatal("reissue must not extend the finite lease")
	}
	d := f.deliveryByID(first.Events[0].DeliveryID)
	if d.RetryCount != 1 {
		t.Fatalf("reissue must not charge the budget twice: retry=%d", d.RetryCount)
	}
	var attempts int
	if err := f.db.QueryRow(
		`SELECT COUNT(*) FROM agent_delivery_attempts WHERE delivery_id = ?`, d.ID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 {
		t.Fatalf("reissue must not stack attempts: %d", attempts)
	}
}

func TestClaimExpiryAllowsFreshClaimWithNewBudget(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, _ := f.seedMessage("m1")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	first, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	// Claimant crashed after claiming; the lease expires.
	f.clock.Advance(DefaultClaimLeaseTTL + time.Second)
	second, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	if second.Reissued {
		t.Fatal("an expired claim must not be reissued verbatim")
	}
	if second.LeaseExpiresAt <= first.LeaseExpiresAt {
		t.Fatal("the revived claim must carry a fresh finite lease")
	}
	d := f.deliveryByID(second.Events[0].DeliveryID)
	if d.RetryCount != 2 {
		t.Fatalf("fresh claim after expiry charges the budget again: retry=%d", d.RetryCount)
	}
	if a := f.openAttempt(d.ID); a == nil || a.ClaimID.String != second.ClaimID {
		t.Fatal("the revived claim must bind a fresh attempt")
	}
	// The receipt token IS the batch (digest identity): after the same batch
	// was re-leased, the slow original claimant's ack still confirms exactly
	// those events — the authenticated principal durably persisted them. The
	// confirmation is idempotent, never a second removal.
	late, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{Principal: principalE(), Claim: first.Claim})
	if err != nil {
		t.Fatalf("same-batch ack after revival must confirm: %v", err)
	}
	if late.RemovedCount != 1 {
		t.Fatalf("removed = %d; want the single batch event", late.RemovedCount)
	}
	d = f.deliveryByID(second.Events[0].DeliveryID)
	if d.SchedulingState != StateAcknowledged {
		t.Fatalf("same-batch ack must confirm the current claim's events: %s", d.SchedulingState)
	}
}

func TestAckExpiredClaimBeforeReclaimIsDenied(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, _ := f.seedMessage("m1")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	// The claimant vanished; the lease expired and nothing re-claimed yet.
	f.clock.Advance(DefaultClaimLeaseTTL + time.Second)
	ack, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{Principal: principalE(), Claim: claim.Claim})
	if err != nil {
		t.Fatal(err)
	}
	if ack.RemovedCount != 0 {
		t.Fatalf("expired lease removes nothing, got %d", ack.RemovedCount)
	}
	d := f.deliveryByID(claim.Events[0].DeliveryID)
	if d.SchedulingState == StateAcknowledged {
		t.Fatal("an expired lease must never confirm events")
	}
	// Release to pending happens on the next recovery/claim scan (the due
	// predicate also treats expired leases as due); the denial itself is the
	// zero-change guarantee under test here.
}

func TestAckArbitraryBatchIsRejected(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, seq1 := f.seedMessage("m1")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	before := f.deliveryByID(claim.Events[0].DeliveryID)
	// A public message id without its seq disagrees with the ack contract.
	if _, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(), Claim: ClaimReceipt{MessageIDs: []string{msg1}},
	}); !errors.Is(err, ErrClaimInconsistent) {
		t.Fatalf("seq/message mismatch must fail closed, got %v", err)
	}
	// Foreign ids are not an intersection. They remove nothing.
	foreign, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(),
		Claim:     ClaimReceipt{Seqs: []int64{seq1 + 999}, MessageIDs: []string{"never-planned"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if foreign.RemovedCount != 0 {
		t.Fatalf("foreign ack removed %d", foreign.RemovedCount)
	}
	after := f.deliveryByID(claim.Events[0].DeliveryID)
	if after.Revision != before.Revision || after.SchedulingState != before.SchedulingState {
		t.Fatal("non-intersection ack must be zero-change")
	}
	// A batch from ANOTHER agent principal is not this agent's claimed set.
	cross, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: AgentPrincipal{AgentID: txAgentM, WorkspaceID: txWS}, Claim: claim.Claim,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cross.RemovedCount != 0 {
		t.Fatalf("cross-agent ack removed %d", cross.RemovedCount)
	}
	if f.deliveryByID(claim.Events[0].DeliveryID).Revision != before.Revision {
		t.Fatal("cross-agent ack must be zero-change")
	}
}

func TestAckClaimReplayIsIdempotent(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, _ := f.seedMessage("m1")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	first, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{Principal: principalE(), Claim: claim.Claim})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{Principal: principalE(), Claim: claim.Claim})
	if err != nil {
		t.Fatal(err)
	}
	if second.RemovedCount != 0 {
		t.Fatalf("replay removes nothing: got %d; want 0 (docs/m5-claim-wire-correction.md)", second.RemovedCount)
	}
	if first.RemovedCount != 1 {
		t.Fatalf("first ack removed_count = %d; want 1", first.RemovedCount)
	}
	d := f.deliveryByID(claim.Events[0].DeliveryID)
	rev := d.Revision
	third, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{Principal: principalE(), Claim: claim.Claim})
	if err != nil || third.RemovedCount != 0 {
		t.Fatal("replay must stay idempotent at zero")
	}
	if f.deliveryByID(claim.Events[0].DeliveryID).Revision != rev {
		t.Fatal("replay must not write again")
	}
}

func TestManagedAgentIsNotClaimable(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, _ := f.seedMessage("m1")
	if err := f.planMessage(msg1, txAgentM); err != nil {
		t.Fatal(err)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{
		Principal: AgentPrincipal{AgentID: txAgentM, WorkspaceID: txWS},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(claim.Events) != 0 {
		t.Fatal("managed agents must not drain tracked intents through the claim inbox")
	}
	d := f.singleDeliveryForAgent(txAgentM)
	if d.SchedulingState != StatePending || d.RetryCount != 0 {
		t.Fatalf("managed intent untouched by claim: %+v", d)
	}
}

func TestClaimAuthorizationCancels(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, _ := f.seedMessage("m1")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	deps := DispatchDeps{
		Facts:     claimDeps().Facts,
		Authorize: denyWith("agent_deleted"),
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), deps, validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	if len(claim.Events) != 0 {
		t.Fatal("unauthorized intent must not be claimable")
	}
	d := f.singleDeliveryForAgent(txAgentE)
	if d.SchedulingState != StateCancelled || str(d.LastErrorCode) != "agent_deleted" {
		t.Fatalf("claim must cancel revoked intents: %+v", d)
	}
}

func TestDrainLegacyEventsConfirmsImmediately(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, _ := f.seedMessage("m1")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	events, removed, err := f.store.DrainLegacyEvents(t.Context(), claimDeps(), validateOK, principalE(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || removed != 1 {
		t.Fatalf("drain = %d events, %d removed", len(events), removed)
	}
	d := f.deliveryByID(events[0].DeliveryID)
	if d.SchedulingState != StateAcknowledged {
		t.Fatalf("legacy drain confirms on return: %s", d.SchedulingState)
	}
	// A second drain has nothing left.
	events, removed, err = f.store.DrainLegacyEvents(t.Context(), claimDeps(), validateOK, principalE(), 10)
	if err != nil || len(events) != 0 || removed != 0 {
		t.Fatalf("second drain must be empty: %d/%d/%v", len(events), removed, err)
	}
}

func TestClaimBudgetExhaustionBlocks(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, _ := f.seedMessage("m1")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	d := f.singleDeliveryForAgent(txAgentE)
	f.mustExec(`UPDATE agent_deliveries SET retry_count = ? WHERE id = ?`, int64(RetryBudget), d.ID)
	claim, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	if len(claim.Events) != 0 {
		t.Fatal("exhausted budget must not claim")
	}
	d = f.deliveryByID(d.ID)
	if d.SchedulingState != StateBlocked || str(d.LastErrorCode) != TerminalRetryExhausted {
		t.Fatalf("exhausted claim budget must block: %+v", d)
	}
}

// TestAckClaimRevokedDeliveryIsCancelledNotConfirmed (integration request
// §5.2): leaving the channel or invalidating the DM after the claim means
// the stale claim digest can no longer confirm that delivery.
func TestAckClaimRevokedDeliveryIsCancelledNotConfirmed(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, _ := f.seedMessage("m1")
	msg2, _ := f.seedMessage("m2")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	if err := f.planMessage(msg2, txAgentE); err != nil {
		t.Fatal(err)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	denyOne := DeliveryAuthorizationFn(func(_ context.Context, _ Executor, d Delivery) (bool, string, error) {
		if d.MessageID.String == msg1 {
			return false, "membership_removed", nil
		}
		return true, "", nil
	})
	deps := DispatchDeps{Facts: claimDeps().Facts, Authorize: denyOne}
	ack, err := f.store.AckAgentClaim(t.Context(), deps, validateOK, ClaimAckInput{Principal: principalE(), Claim: claim.Claim})
	if err != nil {
		t.Fatal(err)
	}
	if ack.RemovedCount != 1 {
		t.Fatalf("removed = %d; want only the still-authorized event", ack.RemovedCount)
	}
	// The revoked row is whichever message was denied; find by message.
	var revokedState, keptState string
	rows, err := f.db.Query(`SELECT message_id, scheduling_state FROM agent_deliveries WHERE agent_id = ?`, txAgentE)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var msgID, state string
		if err := rows.Scan(&msgID, &state); err != nil {
			t.Fatal(err)
		}
		if msgID == msg1 {
			revokedState = state
		} else {
			keptState = state
		}
	}
	rows.Close()
	if revokedState != StateCancelled {
		t.Fatalf("revoked delivery state = %s; want cancelled", revokedState)
	}
	if keptState != StateAcknowledged {
		t.Fatalf("still-authorized delivery state = %s; want acknowledged", keptState)
	}
}

func TestClaimReissueDropsRevokedDeliveries(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, seq1 := f.seedMessage("m1")
	msg2, seq2 := f.seedMessage("m2")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	if err := f.planMessage(msg2, txAgentE); err != nil {
		t.Fatal(err)
	}
	first, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	denyOne := DeliveryAuthorizationFn(func(_ context.Context, _ Executor, d Delivery) (bool, string, error) {
		if d.MessageID.String == msg1 {
			return false, "membership_removed", nil
		}
		return true, "", nil
	})
	deps := DispatchDeps{Facts: claimDeps().Facts, Authorize: denyOne}
	second, err := f.store.ClaimAgentEvents(t.Context(), deps, validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	if !second.Reissued || second.ClaimID != first.ClaimID {
		t.Fatalf("partial revoke must reissue the same claim: %+v", second)
	}
	if len(second.Events) != 1 || second.Events[0].MessageID != msg2 {
		t.Fatalf("revoked message was projected: %+v", second.Events)
	}
	for _, seq := range second.Claim.Seqs {
		if seq == seq1 {
			t.Fatal("revoked message seq remained in the ack batch")
		}
	}
	if len(second.Claim.Seqs) != 1 || second.Claim.Seqs[0] != seq2 {
		t.Fatalf("reissue receipt = %+v", second.Claim)
	}
	var revokedState string
	if err := f.db.QueryRow(`SELECT scheduling_state FROM agent_deliveries WHERE message_id = ?`, msg1).Scan(&revokedState); err != nil {
		t.Fatal(err)
	}
	if revokedState != StateCancelled {
		t.Fatalf("revoked delivery state = %s", revokedState)
	}
	ack, err := f.store.AckAgentClaim(t.Context(), deps, validateOK, ClaimAckInput{Principal: principalE(), Claim: second.Claim})
	if err != nil {
		t.Fatal(err)
	}
	if ack.RemovedCount != 1 {
		t.Fatalf("removed = %d; want the still-authorized event", ack.RemovedCount)
	}
	// The original seq list still names the cancelled row. That id removes
	// nothing and must not revive it; the already-acked row removes nothing
	// a second time.
	replay, err := f.store.AckAgentClaim(t.Context(), deps, validateOK, ClaimAckInput{Principal: principalE(), Claim: first.Claim})
	if err != nil {
		t.Fatal(err)
	}
	if replay.RemovedCount != 0 {
		t.Fatalf("replay of the original batch removed %d", replay.RemovedCount)
	}
	if err := f.db.QueryRow(`SELECT scheduling_state FROM agent_deliveries WHERE message_id = ?`, msg1).Scan(&revokedState); err != nil {
		t.Fatal(err)
	}
	if revokedState != StateCancelled {
		t.Fatalf("original batch revived the revoked delivery: %s", revokedState)
	}
}

func TestClaimReissueAuthorizeErrorIsNotEmptySuccess(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msg1, _ := f.seedMessage("m1")
	if err := f.planMessage(msg1, txAgentE); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()}); err != nil {
		t.Fatal(err)
	}
	boom := errors.New("authorize failed")
	deps := DispatchDeps{
		Facts: claimDeps().Facts,
		Authorize: func(context.Context, Executor, Delivery) (bool, string, error) {
			return false, "", boom
		},
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), deps, validateOK, ClaimInput{Principal: principalE()})
	if !errors.Is(err, boom) {
		t.Fatalf("authorize error swallowed: claim=%+v err=%v", claim, err)
	}
	d := f.singleDeliveryForAgent(txAgentE)
	if d.SchedulingState != StateLeased {
		t.Fatalf("failed reauthorize mutated the delivery: %+v", d)
	}
}
