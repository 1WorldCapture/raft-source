package delivery

import (
	"testing"
	"time"
)

type ackFixture struct {
	f     *fixture
	plan  DispatchPlan
	snap  MentionSnapshot
	princ MachinePrincipal
}

func leaseOne(t *testing.T, f *fixture, facts DispatchFacts) ackFixture {
	t.Helper()
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	// Other agents in the fixture resolve as external so only the managed
	// agent under test leases.
	deps := DispatchDeps{
		Facts: factsPerAgent(map[string]DispatchFacts{
			txAgentM: facts,
			txAgentE: externalFacts(),
		}),
		Authorize: allowAll,
	}
	plans := f.prepare(deps)
	if len(plans) != 1 {
		t.Fatalf("want 1 leased plan, got %d", len(plans))
	}
	p := plans[0]
	return ackFixture{f: f, plan: p, snap: snapshotOf(&p.Attempt), princ: principalOf(&p.Attempt)}
}

func TestAcknowledgeManagedHappyPath(t *testing.T) {
	a := leaseOne(t, newFixture(t), fullFacts(txMachine1, "launch-1", "session-1"))
	res, err := a.f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: a.princ, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: &a.snap,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.AlreadyAcknowledged {
		t.Fatal("first ack is not a replay")
	}
	d := a.f.deliveryByID(a.plan.Delivery.ID)
	if d.SchedulingState != StateAcknowledged || !d.AcknowledgedAt.Valid {
		t.Fatalf("delivery must be acknowledged: %+v", d)
	}
	at, _ := a.f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	if at.State != AttemptTerminal || str(at.TerminalCode) != TerminalAcked || !at.AckedAt.Valid {
		t.Fatalf("attempt must carry the ACK verdict: %+v", at)
	}
}

func TestAcknowledgeManagedIdempotentReplay(t *testing.T) {
	a := leaseOne(t, newFixture(t), fullFacts(txMachine1, "launch-1", "session-1"))
	input := AckInput{Principal: a.princ, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: &a.snap}
	if _, err := a.f.store.AcknowledgeManaged(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	d1 := a.f.deliveryByID(a.plan.Delivery.ID)
	at1, _ := a.f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	res, err := a.f.store.AcknowledgeManaged(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	if !res.AlreadyAcknowledged {
		t.Fatal("replay must report AlreadyAcknowledged")
	}
	d2 := a.f.deliveryByID(a.plan.Delivery.ID)
	at2, _ := a.f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	if d2.AcknowledgedAt.Int64 != d1.AcknowledgedAt.Int64 {
		t.Fatal("replay must not refresh the first confirmation time")
	}
	if at2.AckedAt.Int64 != at1.AckedAt.Int64 || at2.Revision != at1.Revision {
		t.Fatal("replay must not touch the attempt again")
	}
}

// TestAckForeignPrincipalZeroChange: another machine, another workspace and
// another agent can never confirm someone else's occurrence.
func TestAckForeignPrincipalZeroChange(t *testing.T) {
	a := leaseOne(t, newFixture(t), fullFacts(txMachine1, "launch-1", "session-1"))
	before := a.f.deliveryByID(a.plan.Delivery.ID)
	cases := map[string]AckInput{
		"foreign machine":   {Principal: MachinePrincipal{MachineID: txMachine2, WorkspaceID: txWS}, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: &a.snap},
		"foreign workspace": {Principal: MachinePrincipal{MachineID: txMachine1, WorkspaceID: txWS2}, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: &a.snap},
		"foreign agent":     {Principal: a.princ, AgentID: txAgentE, Seq: a.plan.MessageSeq, Snapshot: &a.snap},
		"payload machine forged": {Principal: a.princ, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: &MentionSnapshot{
			OccurrenceID: a.snap.OccurrenceID, MessageID: a.snap.MessageID,
			MachineID: txMachine2, LaunchID: a.snap.LaunchID, SessionID: a.snap.SessionID,
		}},
		"unknown occurrence": {Principal: a.princ, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: &MentionSnapshot{
			OccurrenceID: "nope", MessageID: a.snap.MessageID, MachineID: a.snap.MachineID,
			LaunchID: a.snap.LaunchID, SessionID: a.snap.SessionID,
		}},
		"wrong seq": {Principal: a.princ, AgentID: txAgentM, Seq: a.plan.MessageSeq + 999, Snapshot: &a.snap},
		"session drift": {Principal: a.princ, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: &MentionSnapshot{
			OccurrenceID: a.snap.OccurrenceID, MessageID: a.snap.MessageID, MachineID: a.snap.MachineID,
			LaunchID: a.snap.LaunchID, SessionID: "other-session",
		}},
	}
	for name, input := range cases {
		if _, err := a.f.store.AcknowledgeManaged(t.Context(), input); err == nil {
			t.Fatalf("%s: expected denial", name)
		}
		after := a.f.deliveryByID(a.plan.Delivery.ID)
		if after.SchedulingState != before.SchedulingState || after.Revision != before.Revision {
			t.Fatalf("%s: denial must be zero-change (state=%s rev=%d)", name, after.SchedulingState, after.Revision)
		}
	}
}

// TestLegacyAckRejectedForTrackedAttempt: a tracked attempt is NEVER
// confirmed by a legacy ACK without the five-tuple — no max(seq) guessing.
func TestLegacyAckRejectedForTrackedAttempt(t *testing.T) {
	a := leaseOne(t, newFixture(t), fullFacts(txMachine1, "launch-1", "session-1"))
	_, err := a.f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: a.princ, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: nil,
	})
	if err == nil {
		t.Fatal("legacy ack must be rejected")
	}
	d := a.f.deliveryByID(a.plan.Delivery.ID)
	if d.SchedulingState != StateLeased {
		t.Fatalf("legacy ack must leave the delivery leased, got %s", d.SchedulingState)
	}
}

// TestLateAckOnSupersededAttemptRecordsAuditOnly: the old generation's ACK
// is an audit fact; it can never confirm the new attempt.
func TestLateAckOnSupersededAttemptRecordsAuditOnly(t *testing.T) {
	f := newFixture(t)
	a := leaseOne(t, f, fullFacts(txMachine1, "launch-1", "session-1"))
	d := f.deliveryByID(a.plan.Delivery.ID)
	f.clock.Advance(time.Duration(i64(d.LeaseExpiresAt)-f.clock.Now().UnixMilli())*time.Millisecond + time.Second)
	// Identity drift mints a new occurrence.
	if _, err := f.store.RecordTerminalError(t.Context(), TerminalErrorInput{
		Principal: a.princ, AgentID: txAgentM, Code: TerminalIdentityDrift, Snapshot: a.snap,
	}); err != nil {
		t.Fatal(err)
	}
	// Re-prepare with new identity once the recoverable backoff is due.
	f.clock.Advance(2 * RetryBackoffCap)
	f.prepare(DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-2", "session-2")), Authorize: allowAll})
	newAttempt := f.openAttempt(a.plan.Delivery.ID)
	if newAttempt == nil || newAttempt.OccurrenceID == a.plan.Attempt.OccurrenceID {
		t.Fatal("drift must have minted a new occurrence")
	}
	// The OLD generation's late ACK: audit only.
	res, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: a.princ, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: &a.snap,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.AlreadyAcknowledged {
		t.Fatal("the delivery was never acknowledged")
	}
	oldRow, _ := f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	if !oldRow.AckedAt.Valid {
		t.Fatal("the late receipt is still an audit fact on the old attempt")
	}
	if str(oldRow.TerminalCode) != TerminalIdentityDrift {
		t.Fatalf("old attempt keeps its own terminal verdict, got %s", str(oldRow.TerminalCode))
	}
	after := f.deliveryByID(a.plan.Delivery.ID)
	if after.SchedulingState != StateLeased || after.AcknowledgedAt.Valid {
		t.Fatalf("late old-generation ACK must NOT confirm the new attempt: %+v", after)
	}
	if f.openAttempt(a.plan.Delivery.ID).OccurrenceID != newAttempt.OccurrenceID {
		t.Fatal("the new attempt stays the owner")
	}
}

func TestTransitionsRecordFirstObservationOnly(t *testing.T) {
	a := leaseOne(t, newFixture(t), fullFacts(txMachine1, "launch-1", "session-1"))
	input := TransitionInput{Principal: a.princ, AgentID: txAgentM, Stage: TransitionReceived, Snapshot: a.snap}
	if res, err := a.f.store.RecordTransition(t.Context(), input); err != nil || !res.Recorded {
		t.Fatalf("first observation must record: %v %+v", err, res)
	}
	if res, err := a.f.store.RecordTransition(t.Context(), input); err != nil || res.Recorded {
		t.Fatalf("duplicate observation must be a no-op: %v %+v", err, res)
	}
	at, _ := a.f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	first := at.ReceivedAt.Int64

	// Drained may arrive AFTER the ACK and is still recorded as a real
	// observation — but it must never fabricate the pending timestamp.
	if _, err := a.f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: a.princ, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: &a.snap,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.f.store.RecordTransition(t.Context(), TransitionInput{
		Principal: a.princ, AgentID: txAgentM, Stage: TransitionDrained, Snapshot: a.snap,
	}); err != nil {
		t.Fatal(err)
	}
	at, _ = a.f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	if !at.DrainedReportedAt.Valid {
		t.Fatal("late drained is a real observation on an ACKED attempt")
	}
	if at.PendingAt.Valid {
		t.Fatal("an unobserved timestamp must never be fabricated")
	}
	if at.ReceivedAt.Int64 != first {
		t.Fatal("timestamps never move")
	}
	if at.TerminalCode.String != TerminalAcked {
		t.Fatal("transition must not change the ACK verdict")
	}
}

func TestTerminalErrorCategories(t *testing.T) {
	cases := []struct {
		code  string
		state string
	}{
		{TerminalIdentityUnknown, StatePending},
		{TerminalInstrumentFailed, StatePending},
		{TerminalQuotaLimited, StateBlocked},
		{TerminalUnsupportedPath, StateBlocked},
		{TerminalDeliveryRejected, StateCancelled},
	}
	for _, tc := range cases {
		a := leaseOne(t, newFixture(t), fullFacts(txMachine1, "launch-1", "session-1"))
		res, err := a.f.store.RecordTerminalError(t.Context(), TerminalErrorInput{
			Principal: a.princ, AgentID: txAgentM, Code: tc.code, Snapshot: a.snap,
		})
		if err != nil {
			t.Fatalf("%s: %v", tc.code, err)
		}
		if res.DeliveryState != tc.state {
			t.Fatalf("%s: delivery state = %s; want %s", tc.code, res.DeliveryState, tc.state)
		}
		at, _ := a.f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
		if at.State != AttemptTerminal || str(at.TerminalCode) != tc.code {
			t.Fatalf("%s: attempt verdict = %s/%s", tc.code, at.State, str(at.TerminalCode))
		}
		// The pending retry from a recoverable code must not be a hot loop.
		if tc.state == StatePending {
			d := a.f.deliveryByID(a.plan.Delivery.ID)
			if d.NextAttemptAt <= d.UpdatedAt {
				t.Fatalf("%s: recoverable retry must back off", tc.code)
			}
		}
	}
}

// TestTerminalErrorGenerationMatch: an error from another machine or another
// generation is a zero-change denial.
func TestTerminalErrorGenerationMatch(t *testing.T) {
	a := leaseOne(t, newFixture(t), fullFacts(txMachine1, "launch-1", "session-1"))
	before := a.f.deliveryByID(a.plan.Delivery.ID)
	bad := []TerminalErrorInput{
		{Principal: MachinePrincipal{MachineID: txMachine2, WorkspaceID: txWS}, AgentID: txAgentM, Code: TerminalQuotaLimited, Snapshot: a.snap},
		{Principal: a.princ, AgentID: txAgentM, Code: TerminalQuotaLimited, Snapshot: MentionSnapshot{
			OccurrenceID: a.snap.OccurrenceID, MessageID: a.snap.MessageID, MachineID: a.snap.MachineID,
			LaunchID: "old-launch", SessionID: a.snap.SessionID,
		}},
	}
	for _, input := range bad {
		if _, err := a.f.store.RecordTerminalError(t.Context(), input); err == nil {
			t.Fatal("foreign terminal error must be denied")
		}
	}
	after := a.f.deliveryByID(a.plan.Delivery.ID)
	if after.Revision != before.Revision || after.SchedulingState != before.SchedulingState {
		t.Fatal("denial must be zero-change")
	}
	if f := a.f.openAttempt(a.plan.Delivery.ID); f == nil {
		t.Fatal("attempt stays open")
	}
}
