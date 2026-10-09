package delivery

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Second managed agent, same workspace. Used to prove one agent's blocked
// occurrence does not occupy another agent's slot.
const txAgentM2 = "88888888-8888-4888-8888-888888888883"

func deliveryForMessage(t *testing.T, f *fixture, agentID, messageID string) *Delivery {
	t.Helper()
	var id string
	if err := f.db.QueryRow(
		`SELECT id FROM agent_deliveries WHERE workspace_id = ? AND agent_id = ? AND message_id = ?`,
		txWS, agentID, messageID).Scan(&id); err != nil {
		t.Fatalf("delivery for %s/%s: %v", agentID, messageID, err)
	}
	return f.deliveryByID(id)
}

func advancePastLease(f *fixture, d *Delivery) {
	f.t.Helper()
	remain := i64(d.LeaseExpiresAt) - f.clock.Now().UnixMilli()
	f.clock.Advance(time.Duration(remain)*time.Millisecond + time.Second)
}

func TestObservedDriftBlocksWithoutStarvingSameAgent(t *testing.T) {
	f := newFixture(t)
	f.seed()
	now := f.clock.Now().UnixMilli()
	f.mustExec(`INSERT INTO agents (id, workspace_id, name, status, runtime, machine_id, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?)`, txAgentM2, txWS, "agent-other", "active", "claude", txMachine1, now, now)

	m1, _ := f.seedMessage("m1")
	mExt, extSeq := f.seedMessage("m-ext")
	m2, _ := f.seedMessage("m2")
	mOther, _ := f.seedMessage("m-other")
	if err := f.planMessage(m1, txAgentM); err != nil {
		t.Fatal(err)
	}
	if err := f.planMessage(mExt, txAgentE); err != nil {
		t.Fatal(err)
	}
	if err := f.planMessage(m2, txAgentM); err != nil {
		t.Fatal(err)
	}

	identity := fullFacts(txMachine1, "launch-1", "session-1")
	deps := DispatchDeps{
		Facts: factsPerAgent(map[string]DispatchFacts{
			txAgentM:  identity,
			txAgentM2: identity,
			txAgentE:  externalFacts(),
		}),
		Authorize: allowAll,
	}
	first := f.prepare(deps)
	if len(first) != 1 || first[0].Delivery.MessageID.String != m1 {
		t.Fatalf("first lease = %+v", first)
	}
	if _, err := f.store.RecordTransition(t.Context(), TransitionInput{
		Principal: principalOf(&first[0].Attempt), AgentID: txAgentM,
		Stage: TransitionReceived, Snapshot: snapshotOf(&first[0].Attempt),
	}); err != nil {
		t.Fatal(err)
	}
	receivedAt := f.openAttempt(first[0].Delivery.ID).ReceivedAt
	if !receivedAt.Valid {
		t.Fatal("received observation must be recorded before drift")
	}
	extBefore := deliveryForMessage(t, f, txAgentE, mExt)
	advancePastLease(f, f.deliveryByID(first[0].Delivery.ID))
	if err := f.planMessage(mOther, txAgentM2); err != nil {
		t.Fatal(err)
	}

	drifted := identity
	drifted.LaunchID = "launch-2"
	drifted.SessionID = "session-2"
	deps.Facts = factsPerAgent(map[string]DispatchFacts{
		txAgentM:  drifted,
		txAgentM2: identity,
		txAgentE:  externalFacts(),
	})
	second := f.prepare(deps)
	if len(second) != 2 {
		t.Fatalf("sibling and other agent must lease, got %d", len(second))
	}
	if second[0].Delivery.MessageID.String != m2 || second[1].Delivery.MessageID.String != mOther {
		t.Fatalf("lease order = %s, %s", second[0].Delivery.MessageID.String, second[1].Delivery.MessageID.String)
	}

	blocked := deliveryForMessage(t, f, txAgentM, m1)
	if blocked.SchedulingState != StateBlocked || str(blocked.LastErrorCode) != "uncertain_delivery" {
		t.Fatalf("first intent = %s/%s", blocked.SchedulingState, str(blocked.LastErrorCode))
	}
	if blocked.AcknowledgedAt.Valid {
		t.Fatal("uncertainty must not acknowledge the intent")
	}
	old, err := f.store.AttemptByOccurrence(t.Context(), first[0].Attempt.OccurrenceID)
	if err != nil {
		t.Fatal(err)
	}
	if old.State != AttemptInFlight || old.TerminalCode.Valid || old.AckedAt.Valid {
		t.Fatalf("observed attempt stays open without an ACK verdict: %+v", old)
	}
	if old.ReceivedAt != receivedAt || old.LaunchSnapshot.String != "launch-1" || old.SessionSnapshot.String != "session-1" {
		t.Fatal("recorded receipt and identity snapshot must stay put")
	}
	sibling := deliveryForMessage(t, f, txAgentM, m2)
	if sibling.SchedulingState != StateLeased || f.openAttempt(sibling.ID) == nil {
		t.Fatalf("same-agent sibling must lease, state=%s", sibling.SchedulingState)
	}
	other := deliveryForMessage(t, f, txAgentM2, mOther)
	if other.SchedulingState != StateLeased {
		t.Fatalf("other agent must lease despite the blocked sibling, state=%s", other.SchedulingState)
	}
	extAfter := deliveryForMessage(t, f, txAgentE, mExt)
	if extAfter.SchedulingState != extBefore.SchedulingState || extAfter.Revision != extBefore.Revision ||
		extAfter.RetryCount != extBefore.RetryCount || extAfter.NextAttemptAt != extBefore.NextAttemptAt {
		t.Fatalf("managed scan changed the external intent: before=%+v after=%+v", extBefore, extAfter)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), deps, validateOK, ClaimInput{Principal: principalE(), Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(claim.Claim.Seqs) != 1 || claim.Claim.Seqs[0] != extSeq || len(claim.Claim.MessageIDs) != 0 {
		t.Fatalf("external claim must stay the original seq array: %+v", claim.Claim)
	}

	// A genuine five-tuple of the blocked occurrence resolves that intent
	// only. It must not complete the sibling lease.
	snap := snapshotOf(old)
	if _, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: principalOf(old), AgentID: txAgentM, Seq: first[0].MessageSeq, Snapshot: &snap,
	}); err != nil {
		t.Fatal(err)
	}
	if deliveryForMessage(t, f, txAgentM, m1).SchedulingState != StateAcknowledged {
		t.Fatal("genuine ACK resolves the uncertain intent")
	}
	siblingAttempt := f.openAttempt(sibling.ID)
	if deliveryForMessage(t, f, txAgentM, m2).SchedulingState != StateLeased ||
		siblingAttempt == nil || siblingAttempt.AckedAt.Valid || siblingAttempt.State != AttemptInFlight {
		t.Fatal("the sibling lease must survive the blocked intent's ACK")
	}
}

func TestUnauthorizedAfterLeaseExpiryReleasesSlot(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, _ := f.seedMessage("m1")
	mExt, _ := f.seedMessage("m-ext")
	m2, _ := f.seedMessage("m2")
	if err := f.planMessage(m1, txAgentM); err != nil || f.planMessage(mExt, txAgentE) != nil || f.planMessage(m2, txAgentM) != nil {
		t.Fatal("plan")
	}
	deps := DispatchDeps{Facts: factsPerAgent(map[string]DispatchFacts{
		txAgentM: fullFacts(txMachine1, "launch-1", "session-1"),
		txAgentE: externalFacts(),
	}), Authorize: allowAll}
	first := f.prepare(deps)
	if len(first) != 1 || first[0].Delivery.MessageID.String != m1 {
		t.Fatalf("first lease = %+v", first)
	}
	if _, err := f.store.RecordTransition(t.Context(), TransitionInput{
		Principal: principalOf(&first[0].Attempt), AgentID: txAgentM,
		Stage: TransitionReceived, Snapshot: snapshotOf(&first[0].Attempt),
	}); err != nil {
		t.Fatal(err)
	}
	extBefore := deliveryForMessage(t, f, txAgentE, mExt)
	advancePastLease(f, f.deliveryByID(first[0].Delivery.ID))
	deps.Authorize = func(_ context.Context, _ Executor, d Delivery) (bool, string, error) {
		if d.MessageID.Valid && d.MessageID.String == m1 {
			return false, "membership_removed", nil
		}
		return true, "", nil
	}
	second := f.prepare(deps)
	if len(second) != 1 || second[0].Delivery.MessageID.String != m2 {
		t.Fatalf("sibling lease = %+v", second)
	}
	cancelled := deliveryForMessage(t, f, txAgentM, m1)
	if cancelled.SchedulingState != StateCancelled || str(cancelled.LastErrorCode) != "membership_removed" {
		t.Fatalf("cancelled = %s/%s", cancelled.SchedulingState, str(cancelled.LastErrorCode))
	}
	if cancelled.AcknowledgedAt.Valid {
		t.Fatal("cancel must not acknowledge")
	}
	old, err := f.store.AttemptByOccurrence(t.Context(), first[0].Attempt.OccurrenceID)
	if err != nil {
		t.Fatal(err)
	}
	if old.State != AttemptTerminal || str(old.TerminalCode) != TerminalCancelled || old.AckedAt.Valid || !old.ReceivedAt.Valid {
		t.Fatalf("cancelled attempt must keep the observation and not ACK: %+v", old)
	}
	if old.LaunchSnapshot.String != "launch-1" {
		t.Fatal("cancel must not rewrite the identity snapshot")
	}
	extAfter := deliveryForMessage(t, f, txAgentE, mExt)
	if extAfter.Revision != extBefore.Revision || extAfter.SchedulingState != StatePending || extAfter.RetryCount != 0 {
		t.Fatalf("external intent changed: %+v", extAfter)
	}

	snap := snapshotOf(old)
	res, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: principalOf(old), AgentID: txAgentM, Seq: first[0].MessageSeq, Snapshot: &snap,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.AlreadyAcknowledged {
		t.Fatal("a cancelled attempt was never acknowledged")
	}
	old, _ = f.store.AttemptByOccurrence(t.Context(), old.OccurrenceID)
	if str(old.TerminalCode) != TerminalCancelled || !old.AckedAt.Valid || !old.ReceivedAt.Valid {
		t.Fatalf("late ACK is audit-only on the cancelled attempt: %+v", old)
	}
	if deliveryForMessage(t, f, txAgentM, m1).SchedulingState != StateCancelled {
		t.Fatal("late ACK must not resurrect the cancelled intent")
	}
	siblingAttempt := f.openAttempt(second[0].Delivery.ID)
	if deliveryForMessage(t, f, txAgentM, m2).SchedulingState != StateLeased ||
		siblingAttempt == nil || siblingAttempt.OccurrenceID != second[0].Attempt.OccurrenceID ||
		siblingAttempt.State != AttemptInFlight || siblingAttempt.AckedAt.Valid {
		t.Fatal("late ACK of the cancelled attempt must not complete the sibling")
	}
}

func TestRequeueBlockedMintsOccurrenceAndRefusesStaleAck(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, _ := f.seedMessage("m1")
	m2, _ := f.seedMessage("m2")
	if err := f.planMessage(m1, txAgentM); err != nil || f.planMessage(m2, txAgentM) != nil {
		t.Fatal("plan")
	}
	deps := DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll}
	first := f.prepare(deps)
	if len(first) != 1 {
		t.Fatal("first prepare must lease one")
	}
	if _, err := f.store.RecordTransition(t.Context(), TransitionInput{
		Principal: principalOf(&first[0].Attempt), AgentID: txAgentM,
		Stage: TransitionPending, Snapshot: snapshotOf(&first[0].Attempt),
	}); err != nil {
		t.Fatal(err)
	}
	advancePastLease(f, f.deliveryByID(first[0].Delivery.ID))
	deps.Facts = factsFor(fullFacts(txMachine1, "launch-2", "session-2"))
	released := f.prepare(deps)
	if len(released) != 1 || released[0].Delivery.MessageID.String != m2 {
		t.Fatalf("sibling should lease once the first is blocked, got %+v", released)
	}
	blocked := deliveryForMessage(t, f, txAgentM, m1)
	if blocked.SchedulingState != StateBlocked || str(blocked.LastErrorCode) != "uncertain_delivery" {
		t.Fatalf("blocked = %s/%s", blocked.SchedulingState, str(blocked.LastErrorCode))
	}

	// Free the slot with a real receipt for the sibling, then redrive the
	// blocked intent. Requeue must not disturb that receipt.
	sibSnap := snapshotOf(&released[0].Attempt)
	if _, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: principalOf(&released[0].Attempt), AgentID: txAgentM,
		Seq: released[0].MessageSeq, Snapshot: &sibSnap,
	}); err != nil {
		t.Fatal(err)
	}
	ok, err := f.store.RequeueBlocked(t.Context(), txWS, blocked.ID, "operator")
	if err != nil || !ok {
		t.Fatalf("requeue: %v ok=%v", err, ok)
	}
	old, err := f.store.AttemptByOccurrence(t.Context(), first[0].Attempt.OccurrenceID)
	if err != nil {
		t.Fatal(err)
	}
	if old.State != AttemptTerminal || str(old.TerminalCode) != TerminalSuperseded || old.AckedAt.Valid || !old.PendingAt.Valid {
		t.Fatalf("requeue must supersede the observed attempt without an ACK: %+v", old)
	}
	if old.LaunchSnapshot.String != "launch-1" || old.SessionSnapshot.String != "session-1" {
		t.Fatal("requeue must not rewrite the old snapshot")
	}
	redriven := f.deliveryByID(blocked.ID)
	if redriven.SchedulingState != StatePending || redriven.RetryCount != 0 || str(redriven.LastErrorCode) != "redriven:operator" {
		t.Fatalf("requeue state: %+v", redriven)
	}
	if deliveryForMessage(t, f, txAgentM, m2).SchedulingState != StateAcknowledged {
		t.Fatal("requeue must not touch the sibling receipt")
	}

	plans := f.prepare(deps)
	if len(plans) != 1 || plans[0].Delivery.ID != blocked.ID {
		t.Fatalf("requeue must make progress, got %+v", plans)
	}
	fresh := plans[0].Attempt
	if fresh.OccurrenceID == old.OccurrenceID || fresh.AttemptNumber != old.AttemptNumber+1 {
		t.Fatalf("replacement occurrence = %+v", fresh)
	}
	if fresh.LaunchSnapshot.String != "launch-2" || fresh.SessionSnapshot.String != "session-2" || fresh.State != AttemptInFlight {
		t.Fatalf("replacement identity = %+v", fresh)
	}
	if f.deliveryByID(blocked.ID).SchedulingState != StateLeased || f.deliveryByID(blocked.ID).RetryCount != 1 {
		t.Fatal("the replacement must be a normal leased attempt")
	}

	freshBefore, _ := f.store.AttemptByOccurrence(t.Context(), fresh.OccurrenceID)
	foreignSnap := snapshotOf(&fresh)
	foreignSnap.MachineID = txMachine2
	if _, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: MachinePrincipal{ComputerID: "c2", MachineID: txMachine2, WorkspaceID: txWS},
		AgentID:   txAgentM, Seq: plans[0].MessageSeq, Snapshot: &foreignSnap,
	}); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("foreign machine ACK = %v", err)
	}
	if _, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: principalOf(&fresh), AgentID: txAgentE, Seq: plans[0].MessageSeq, Snapshot: snapshotPtr(&fresh),
	}); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("foreign agent ACK = %v", err)
	}
	if _, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: MachinePrincipal{ComputerID: "c", MachineID: txMachine1, WorkspaceID: txWS2},
		AgentID:   txAgentM, Seq: plans[0].MessageSeq, Snapshot: snapshotPtr(&fresh),
	}); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("foreign workspace ACK = %v", err)
	}
	freshAfter, _ := f.store.AttemptByOccurrence(t.Context(), fresh.OccurrenceID)
	if freshAfter.Revision != freshBefore.Revision || freshAfter.State != AttemptInFlight || freshAfter.AckedAt.Valid {
		t.Fatalf("rejected ACKs must leave the replacement untouched: %+v", freshAfter)
	}

	stale := snapshotOf(old)
	res, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: principalOf(old), AgentID: txAgentM, Seq: plans[0].MessageSeq, Snapshot: &stale,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.AlreadyAcknowledged || res.OccurrenceID != old.OccurrenceID {
		t.Fatalf("stale ACK result = %+v", res)
	}
	old, _ = f.store.AttemptByOccurrence(t.Context(), old.OccurrenceID)
	if str(old.TerminalCode) != TerminalSuperseded || !old.AckedAt.Valid || !old.PendingAt.Valid {
		t.Fatalf("stale ACK may only audit the old occurrence: %+v", old)
	}
	current := f.deliveryByID(blocked.ID)
	open := f.openAttempt(blocked.ID)
	if current.SchedulingState != StateLeased || current.AcknowledgedAt.Valid ||
		open == nil || open.OccurrenceID != fresh.OccurrenceID || open.State != AttemptInFlight || open.AckedAt.Valid {
		t.Fatalf("stale ACK completed the replacement: delivery=%+v attempt=%+v", current, open)
	}

	match := snapshotOf(open)
	if _, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: principalOf(open), AgentID: txAgentM, Seq: plans[0].MessageSeq, Snapshot: &match,
	}); err != nil {
		t.Fatal(err)
	}
	if f.deliveryByID(blocked.ID).SchedulingState != StateAcknowledged {
		t.Fatal("the replacement's own five-tuple still acknowledges it")
	}
	if deliveryForMessage(t, f, txAgentM, m2).SchedulingState != StateAcknowledged {
		t.Fatal("sibling receipt must remain")
	}
}

func TestExpiredSameIdentityAttemptStillOccupiesSlot(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, _ := f.seedMessage("m1")
	m2, _ := f.seedMessage("m2")
	if err := f.planMessage(m1, txAgentM); err != nil || f.planMessage(m2, txAgentM) != nil {
		t.Fatal("plan")
	}
	deps := DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll}
	first := f.prepare(deps)
	if len(first) != 1 {
		t.Fatal(len(first))
	}
	advancePastLease(f, f.deliveryByID(first[0].Delivery.ID))
	second := f.prepare(deps)
	if len(second) != 1 || second[0].Delivery.MessageID.String != m1 {
		t.Fatalf("same identity must keep the slot on the original intent, got %+v", second)
	}
	if second[0].Attempt.OccurrenceID != first[0].Attempt.OccurrenceID {
		t.Fatal("same identity must reuse the occurrence")
	}
	if deliveryForMessage(t, f, txAgentM, m2).SchedulingState != StatePending || f.openAttempt(deliveryForMessage(t, f, txAgentM, m2).ID) != nil {
		t.Fatal("the sibling must wait while the original occurrence is still live")
	}
}

func snapshotPtr(a *Attempt) *MentionSnapshot {
	snap := snapshotOf(a)
	return &snap
}
