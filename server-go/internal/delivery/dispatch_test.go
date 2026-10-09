package delivery

import (
	"testing"
	"time"
)

func TestPrepareLeasesManagedAttemptWithFullIdentity(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, seq := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	deps := DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll}
	plans := f.prepare(deps)
	if len(plans) != 1 {
		t.Fatalf("want 1 plan, got %d", len(plans))
	}
	p := plans[0]
	if p.Attempt.TransportKind != TransportManagedWire {
		t.Fatal("plan must carry a managed attempt")
	}
	if p.Attempt.MachineSnapshot.String != txMachine1 ||
		p.Attempt.LaunchSnapshot.String != "launch-1" ||
		p.Attempt.SessionSnapshot.String != "session-1" {
		t.Fatalf("identity snapshot wrong: %+v", p.Attempt)
	}
	if p.MessageSeq != seq {
		t.Fatalf("wire seq = %d; want messages.seq %d", p.MessageSeq, seq)
	}
	d := f.deliveryByID(p.Delivery.ID)
	if d.SchedulingState != StateLeased || d.RetryCount != 1 {
		t.Fatalf("delivery after lease: state=%s retry=%d", d.SchedulingState, d.RetryCount)
	}
	if i64(d.LeaseExpiresAt) <= d.UpdatedAt {
		t.Fatal("lease must be finite and in the future")
	}
}

func TestPrepareWaitingStatesNeverBurnBudget(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		facts DispatchFacts
		state string
		code  string
	}{
		{"stopped", DispatchFacts{SupportsManagedWire: true, Reachable: true, MachineID: txMachine1, Stopped: true}, StateWaitingMachine, "agent_stopped"},
		{"offline", DispatchFacts{SupportsManagedWire: true, MachineID: txMachine1}, StateWaitingMachine, "machine_offline"},
		{"no-identity", DispatchFacts{SupportsManagedWire: true, Reachable: true, MachineID: txMachine1, LaunchID: "launch-1"}, StateWaitingIdentity, "identity_incomplete"},
	}
	for _, tc := range cases {
		f2 := newFixture(t)
		f2.seed()
		msg, _ := f2.seedMessage("m1")
		if err := f2.planMessage(msg, txAgentM); err != nil {
			t.Fatal(err)
		}
		deps := DispatchDeps{Facts: factsFor(tc.facts), Authorize: allowAll}
		if plans := f2.prepare(deps); len(plans) != 0 {
			t.Fatalf("%s: no plan expected, got %d", tc.name, len(plans))
		}
		d := f2.singleDeliveryForAgent(txAgentM)
		if d.SchedulingState != tc.state {
			t.Fatalf("%s: state = %s; want %s", tc.name, d.SchedulingState, tc.state)
		}
		if str(d.LastErrorCode) != tc.code {
			t.Fatalf("%s: code = %s; want %s", tc.name, str(d.LastErrorCode), tc.code)
		}
		if d.RetryCount != 0 {
			t.Fatalf("%s: waiting must not consume budget (retry=%d)", tc.name, d.RetryCount)
		}
		if f2.openAttempt(d.ID) != nil {
			t.Fatalf("%s: waiting must not create an attempt", tc.name)
		}
		_ = f
		_ = msgID
		_ = time.Now
	}
}

func TestPrepareExternalAgentIsClaimOnly(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentE); err != nil {
		t.Fatal(err)
	}
	before := f.singleDeliveryForAgent(txAgentE)
	deps := DispatchDeps{Facts: factsPerAgent(map[string]DispatchFacts{
		txAgentE: externalFacts(),
	}), Authorize: allowAll}
	if plans := f.prepare(deps); len(plans) != 0 {
		t.Fatalf("managed scan must skip external agents, got %d plans", len(plans))
	}
	d := f.singleDeliveryForAgent(txAgentE)
	if d.SchedulingState != StatePending {
		t.Fatalf("external intent must stay pending, got %s", d.SchedulingState)
	}
	if d.NextAttemptAt != before.NextAttemptAt || d.Revision != before.Revision || d.RetryCount != before.RetryCount {
		t.Fatalf("managed scan mutated external pull eligibility: before=%+v after=%+v", before, d)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), deps, validateOK, ClaimInput{Principal: principalE(), Limit: 1})
	if err != nil || len(claim.Events) != 1 {
		t.Fatalf("external input must remain immediately claimable: claim=%+v error=%v", claim, err)
	}
}

func TestPrepareUnauthorizedCancelsIntent(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	deps := DispatchDeps{
		Facts:     factsFor(fullFacts(txMachine1, "launch-1", "session-1")),
		Authorize: denyWith("membership_removed"),
	}
	f.prepare(deps)
	d := f.singleDeliveryForAgent(txAgentM)
	if d.SchedulingState != StateCancelled {
		t.Fatalf("state = %s; want cancelled", d.SchedulingState)
	}
	if str(d.LastErrorCode) != "membership_removed" {
		t.Fatalf("reason = %s", str(d.LastErrorCode))
	}
	if f.openAttempt(d.ID) != nil {
		t.Fatal("no attempt may exist for a cancelled intent")
	}
}

func TestPrepareSingleOutstandingPerAgent(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, _ := f.seedMessage("m1")
	m2, _ := f.seedMessage("m2")
	if err := f.planMessage(m1, txAgentM); err != nil {
		t.Fatal(err)
	}
	if err := f.planMessage(m2, txAgentM); err != nil {
		t.Fatal(err)
	}
	deps := DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll}
	plans := f.prepare(deps)
	if len(plans) != 1 {
		t.Fatalf("fairness: want exactly 1 outstanding attempt, got %d", len(plans))
	}
	if plans[0].Delivery.MessageID.String != m1 {
		t.Fatalf("delivery_order must win: got %s", plans[0].Delivery.MessageID.String)
	}
}

// TestOccurrenceReuseSameIdentity: after the ACK lease expires, a resend with
// the SAME identity reuses the SAME occurrence so the daemon can dedup.
func TestOccurrenceReuseSameIdentity(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	deps := DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll}
	first := f.prepare(deps)
	if len(first) != 1 {
		t.Fatal("first prepare must lease")
	}
	occurrence := first[0].Attempt.OccurrenceID
	attemptNumber := first[0].Attempt.AttemptNumber

	// Expire the lease on the clock, then re-prepare with the same identity.
	f.clock.Advance(time.Duration(i64(f.deliveryByID(first[0].Delivery.ID).LeaseExpiresAt)-f.clock.Now().UnixMilli())*time.Millisecond + time.Second)
	second := f.prepare(deps)
	if len(second) != 1 {
		t.Fatalf("resend must re-lease, got %d plans", len(second))
	}
	if second[0].Attempt.OccurrenceID != occurrence {
		t.Fatalf("same identity must reuse the occurrence: %s vs %s", second[0].Attempt.OccurrenceID, occurrence)
	}
	if second[0].Attempt.AttemptNumber != attemptNumber {
		t.Fatalf("same identity must not mint a new attempt number: %d vs %d", second[0].Attempt.AttemptNumber, attemptNumber)
	}
	d := f.deliveryByID(second[0].Delivery.ID)
	if d.RetryCount != 2 {
		t.Fatalf("resend must charge the persistent budget once more: retry=%d", d.RetryCount)
	}
	var open int
	if err := f.db.QueryRow(
		`SELECT COUNT(*) FROM agent_delivery_attempts WHERE delivery_id = ?`, d.ID).Scan(&open); err != nil {
		t.Fatal(err)
	}
	if open != 1 {
		t.Fatalf("occurrence reuse must not stack attempts: %d rows", open)
	}
}

// TestIdentityDriftSupersedesOldOccurrence: a launch/session change NEVER
// rewrites the old snapshot in place; the old attempt is terminal-closed and
// a NEW occurrence is minted.
func TestIdentityDriftSupersedesOldOccurrence(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	first := f.prepare(DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll})
	old := first[0].Attempt
	f.clock.Advance(time.Duration(i64(f.deliveryByID(old.DeliveryID).LeaseExpiresAt)-f.clock.Now().UnixMilli())*time.Millisecond + time.Second)
	second := f.prepare(DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-2", "session-2")), Authorize: allowAll})
	if len(second) != 1 {
		t.Fatal("drift re-prepare must lease a new attempt")
	}
	fresh := second[0].Attempt
	if fresh.OccurrenceID == old.OccurrenceID {
		t.Fatal("identity drift must mint a NEW occurrence")
	}
	if fresh.AttemptNumber != old.AttemptNumber+1 {
		t.Fatalf("attempt number must advance: %d -> %d", old.AttemptNumber, fresh.AttemptNumber)
	}
	if fresh.SessionSnapshot.String != "session-2" || fresh.LaunchSnapshot.String != "launch-2" {
		t.Fatalf("new attempt must carry the new identity: %+v", fresh)
	}
	oldRow, err := f.store.AttemptByOccurrence(t.Context(), old.OccurrenceID)
	if err != nil {
		t.Fatal(err)
	}
	if oldRow.State != AttemptTerminal || str(oldRow.TerminalCode) != TerminalSuperseded {
		t.Fatalf("old attempt must be SUPERSEDED, got state=%s code=%s", oldRow.State, str(oldRow.TerminalCode))
	}
	if oldRow.SessionSnapshot.String != "session-1" {
		t.Fatal("the old snapshot must remain immutable")
	}
}

func TestBudgetExhaustionBlocksInsteadOfSending(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	d := f.singleDeliveryForAgent(txAgentM)
	// Burn the whole persistent budget minus one, lease once, let it expire,
	// then verify the next prepare blocks at the 24th charge.
	f.mustExec(`UPDATE agent_deliveries SET retry_count = ? WHERE id = ?`, int64(RetryBudget)-1, d.ID)
	deps := DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll}
	first := f.prepare(deps)
	if len(first) != 1 {
		t.Fatal("the 24th dispatch preparation must still lease")
	}
	d = f.deliveryByID(d.ID)
	if d.RetryCount != RetryBudget {
		t.Fatalf("budget after lease = %d", d.RetryCount)
	}
	f.clock.Advance(time.Duration(i64(d.LeaseExpiresAt)-f.clock.Now().UnixMilli())*time.Millisecond + time.Second)
	if plans := f.prepare(deps); len(plans) != 0 {
		t.Fatal("exhausted budget must not lease again")
	}
	d = f.deliveryByID(d.ID)
	if d.SchedulingState != StateBlocked || str(d.LastErrorCode) != TerminalRetryExhausted {
		t.Fatalf("state=%s code=%s; want blocked/RETRY_EXHAUSTED", d.SchedulingState, str(d.LastErrorCode))
	}
	if a := f.openAttempt(d.ID); a != nil {
		t.Fatalf("open attempt must be terminal after exhaustion, got %+v", a)
	}
}

func TestRecordSendResultObservations(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	plans := f.prepare(DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll})
	occ := plans[0].Attempt.OccurrenceID
	deliveryID := plans[0].Delivery.ID

	// Accepted: dispatched_at observation only.
	if err := f.store.RecordManagedSendResult(t.Context(), SendOutcome{OccurrenceID: occ, Accepted: true}); err != nil {
		t.Fatal(err)
	}
	a, _ := f.store.AttemptByOccurrence(t.Context(), occ)
	if !a.DispatchedAt.Valid {
		t.Fatal("accepted send must record dispatched_at")
	}

	// Recoverable failure: back to pending with persistent backoff.
	if err := f.store.RecordManagedSendResult(t.Context(), SendOutcome{
		OccurrenceID: occ, ErrorCode: "gateway_unavailable", Recoverable: true,
	}); err != nil {
		t.Fatal(err)
	}
	d := f.deliveryByID(deliveryID)
	if d.SchedulingState != StatePending {
		t.Fatalf("recoverable failure must re-pend, got %s", d.SchedulingState)
	}
	if str(d.LastErrorCode) != "gateway_unavailable" {
		t.Fatalf("code = %s", str(d.LastErrorCode))
	}
	if d.NextAttemptAt <= d.UpdatedAt {
		t.Fatal("backoff must schedule a future attempt")
	}
	if f.openAttempt(deliveryID) == nil {
		t.Fatal("occurrence must stay open for same-identity reuse")
	}
}

func TestRecordSendResultUnrecoverableCancels(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	plans := f.prepare(DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll})
	occ := plans[0].Attempt.OccurrenceID
	if err := f.store.RecordManagedSendResult(t.Context(), SendOutcome{
		OccurrenceID: occ, ErrorCode: "machine_gone", Recoverable: false,
	}); err != nil {
		t.Fatal(err)
	}
	d := f.deliveryByID(plans[0].Delivery.ID)
	if d.SchedulingState != StateCancelled {
		t.Fatalf("unrecoverable failure must cancel, got %s", d.SchedulingState)
	}
	a, _ := f.store.AttemptByOccurrence(t.Context(), occ)
	if a.State != AttemptTerminal || str(a.TerminalCode) != TerminalSendFailed {
		t.Fatalf("attempt verdict = %s/%s", a.State, str(a.TerminalCode))
	}
}

// TestSendResultNeverOverwritesRacingACK: an ACK that landed before the Send
// call returned is the stronger fact.
func TestSendResultNeverOverwritesRacingACK(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	plans := f.prepare(DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll})
	a := plans[0].Attempt
	snap := snapshotOf(&a)
	if _, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: principalOf(&a), AgentID: a.AgentID, Seq: plans[0].MessageSeq, Snapshot: &snap,
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.store.RecordManagedSendResult(t.Context(), SendOutcome{
		OccurrenceID: a.OccurrenceID, ErrorCode: "late_failure", Recoverable: true,
	}); err != nil {
		t.Fatal(err)
	}
	d := f.deliveryByID(a.DeliveryID)
	if d.SchedulingState != StateAcknowledged {
		t.Fatalf("racing ACK must win over the late failure observation, state=%s", d.SchedulingState)
	}
}

func TestRecoverExpiredLeasesNormalizesToPending(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	plans := f.prepare(DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll})
	d := f.deliveryByID(plans[0].Delivery.ID)
	f.clock.Advance(time.Duration(i64(d.LeaseExpiresAt)-f.clock.Now().UnixMilli())*time.Millisecond + time.Second)
	recovered, err := f.store.RecoverExpiredLeases(t.Context(), f.clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Managed != 1 {
		t.Fatalf("managed recoveries = %d", recovered.Managed)
	}
	d = f.deliveryByID(d.ID)
	if d.SchedulingState != StatePending {
		t.Fatalf("expired lease must normalize to pending, got %s", d.SchedulingState)
	}
	if d.RetryCount != 1 {
		t.Fatalf("recovery must not reset or burn budget: retry=%d", d.RetryCount)
	}
	if f.openAttempt(d.ID) == nil {
		t.Fatal("occurrence stays open for same-identity reuse")
	}
}

// TestUncertainDriftBlocksInsteadOfImplicitRedelivery (integration request
// §5.3): a daemon-OBSERVED attempt whose identity then drifted is an
// uncertain outcome — blocked for explicit diagnosis, never implicitly
// re-delivered; a genuine five-tuple ACK still resolves it.
func TestUncertainDriftBlocksInsteadOfImplicitRedelivery(t *testing.T) {
	f := newFixture(t)
	f.seed()
	a := leaseOne(t, f, fullFacts(txMachine1, "launch-1", "session-1"))
	// The daemon reported an observation.
	if _, err := f.store.RecordTransition(t.Context(), TransitionInput{
		Principal: a.princ, AgentID: txAgentM, Stage: TransitionReceived, Snapshot: a.snap,
	}); err != nil {
		t.Fatal(err)
	}
	d := f.deliveryByID(a.plan.Delivery.ID)
	f.clock.Advance(time.Duration(i64(d.LeaseExpiresAt)-f.clock.Now().UnixMilli())*time.Millisecond + time.Second)
	plans := f.prepare(DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-2", "session-2")), Authorize: allowAll})
	if len(plans) != 0 {
		t.Fatal("observed drift must NOT implicitly re-deliver")
	}
	d = f.deliveryByID(d.ID)
	if d.SchedulingState != StateBlocked || str(d.LastErrorCode) != "uncertain_delivery" {
		t.Fatalf("state=%s code=%s; want blocked/uncertain_delivery", d.SchedulingState, str(d.LastErrorCode))
	}
	oldAttempt, err := f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	if err != nil {
		t.Fatal(err)
	}
	if oldAttempt.State != AttemptInFlight {
		t.Fatal("the observed attempt stays open: its ACK can still resolve the uncertainty")
	}
	// A genuine receipt resolves the uncertain block.
	if _, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: a.princ, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: &a.snap,
	}); err != nil {
		t.Fatal(err)
	}
	d = f.deliveryByID(d.ID)
	if d.SchedulingState != StateAcknowledged {
		t.Fatalf("a genuine ACK resolves uncertainty: %s", d.SchedulingState)
	}
}
