package delivery

import (
	"testing"
)

func TestCancelDeliveriesFiltersAndPreservesReceipts(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, _ := f.seedMessage("m1")
	m2, _ := f.seedMessage("m2")
	if err := f.planMessage(m1, txAgentM, txAgentE); err != nil {
		t.Fatal(err)
	}
	if err := f.planMessage(m2, txAgentM); err != nil {
		t.Fatal(err)
	}
	// Acknowledge one intent first: receipts survive every later revocation.
	a := leaseOne(t, f, fullFacts(txMachine1, "launch-1", "session-1"))
	if _, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: a.princ, AgentID: txAgentM, Seq: a.plan.MessageSeq, Snapshot: &a.snap,
	}); err != nil {
		t.Fatal(err)
	}

	// Cancel by agent: only the open intents of that agent change.
	n, err := f.store.CancelDeliveries(t.Context(), CancelInput{
		WorkspaceID: txWS, AgentID: txAgentM, Reason: "membership_removed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("cancelled = %d; want exactly the open agent intent", n)
	}
	acked := f.deliveryByID(a.plan.Delivery.ID)
	if acked.SchedulingState != StateAcknowledged {
		t.Fatal("an acknowledged receipt is never cancelled")
	}
	external := f.singleDeliveryForAgent(txAgentE)
	if external.SchedulingState != StatePending {
		t.Fatal("other agents are untouched by the agent filter")
	}

	// Cancel by conversation.
	n, err = f.store.CancelDeliveries(t.Context(), CancelInput{
		WorkspaceID: txWS, ConversationID: txChannel1, Reason: "channel_hidden",
	})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("conversation cancel = %d; want the remaining external intent", n)
	}
	if f.singleDeliveryForAgent(txAgentE).SchedulingState != StateCancelled {
		t.Fatal("conversation cancel must close the external intent")
	}

	// Idempotent: nothing left to cancel.
	n, err = f.store.CancelDeliveries(t.Context(), CancelInput{WorkspaceID: txWS, Reason: "noop"})
	if err != nil || n != 0 {
		t.Fatalf("repeat cancel = %d/%v; want 0", n, err)
	}
}

func TestCancelClosesOpenAttempts(t *testing.T) {
	f := newFixture(t)
	f.seed()
	a := leaseOne(t, f, fullFacts(txMachine1, "launch-1", "session-1"))
	if _, err := f.store.CancelDeliveries(t.Context(), CancelInput{
		WorkspaceID: txWS, DeliveryID: a.plan.Delivery.ID, Reason: "agent_deleted",
	}); err != nil {
		t.Fatal(err)
	}
	at, err := f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	if err != nil {
		t.Fatal(err)
	}
	if at.State != AttemptTerminal || str(at.TerminalCode) != TerminalCancelled {
		t.Fatalf("open attempt must close with the cancel verdict: %+v", at)
	}
}

func TestRequeueBlockedResetsBudgetExplicitly(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	d := f.singleDeliveryForAgent(txAgentM)
	f.mustExec(`UPDATE agent_deliveries SET scheduling_state = 'blocked',
		last_error_code = 'RETRY_EXHAUSTED', retry_count = ? WHERE id = ?`, int64(RetryBudget), d.ID)

	// Only blocked rows requeue.
	if _, err := f.store.RequeueBlocked(t.Context(), txWS2, d.ID, "operator"); err == nil {
		t.Fatal("cross-workspace requeue must fail")
	}
	ok, err := f.store.RequeueBlocked(t.Context(), txWS, d.ID, "operator")
	if err != nil || !ok {
		t.Fatalf("requeue failed: %v", err)
	}
	d = f.deliveryByID(d.ID)
	if d.SchedulingState != StatePending || d.RetryCount != 0 {
		t.Fatalf("explicit requeue must reset the budget: %+v", d)
	}
	if str(d.LastErrorCode) != "redriven:operator" {
		t.Fatalf("operator reason must be recorded: %s", str(d.LastErrorCode))
	}
	// A non-blocked row refuses.
	if _, err := f.store.RequeueBlocked(t.Context(), txWS, d.ID, "again"); err == nil {
		t.Fatal("requeue only applies to blocked rows")
	}
}

func TestQueueStatsProjection(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, _ := f.seedMessage("m1")
	if err := f.planMessage(m1, txAgentM, txAgentE); err != nil {
		t.Fatal(err)
	}
	f.prepare(DispatchDeps{Facts: factsPerAgent(map[string]DispatchFacts{
		txAgentM: fullFacts(txMachine1, "launch-1", "session-1"),
		txAgentE: externalFacts(),
	}), Authorize: allowAll})
	stats, err := f.store.QueueStats(t.Context(), txWS)
	if err != nil {
		t.Fatal(err)
	}
	if stats.PerState[StatePending] != 1 || stats.PerState[StateLeased] != 1 {
		t.Fatalf("per-state counts wrong: %+v", stats.PerState)
	}
	if stats.InFlightAttempts != 1 {
		t.Fatalf("in-flight attempts = %d", stats.InFlightAttempts)
	}
	// Another workspace sees nothing.
	other, err := f.store.QueueStats(t.Context(), txWS2)
	if err != nil {
		t.Fatal(err)
	}
	if len(other.PerState) != 0 || other.OpenClaims != 0 {
		t.Fatalf("cross-workspace stats must be empty: %+v", other)
	}
}

func TestGetAndListQueries(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, _ := f.seedMessage("m1")
	if err := f.planMessage(m1, txAgentM, txAgentE); err != nil {
		t.Fatal(err)
	}
	rows, err := f.store.ListMessageDeliveries(t.Context(), txWS, m1)
	if err != nil || len(rows) != 2 {
		t.Fatalf("list = %d/%v; want 2", len(rows), err)
	}
	got, err := f.store.GetDelivery(t.Context(), rows[0].ID)
	if err != nil || got == nil {
		t.Fatal(err)
	}
	if _, err := f.store.GetDelivery(t.Context(), "missing"); err == nil {
		t.Fatal("missing delivery must 404")
	}
}

// TestPrepareRequiresCallbacks pins the no-blind-trust rule: dispatching
// without the injected typed fact/authorization callbacks is refused.
func TestPrepareRequiresCallbacks(t *testing.T) {
	f := newFixture(t)
	f.seed()
	if _, err := f.store.PrepareManagedDispatches(t.Context(), DispatchDeps{}, PrepareInput{}); err == nil {
		t.Fatal("missing callbacks must fail closed")
	}
	if _, err := f.store.ClaimAgentEvents(t.Context(), DispatchDeps{Facts: factsFor(externalFacts()), Authorize: allowAll}, nil, ClaimInput{}); err == nil {
		t.Fatal("missing principal validator must fail closed")
	}
}
