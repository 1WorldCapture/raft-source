package delivery

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func leaseBriefing(t *testing.T, f *fixture, facts DispatchFacts, purpose string) ackFixture {
	t.Helper()
	f.seed()
	if err := f.planBriefing(txAgentM, purpose); err != nil {
		t.Fatal(err)
	}
	deps := DispatchDeps{
		Facts: factsPerAgent(map[string]DispatchFacts{
			txAgentM: facts,
			txAgentE: externalFacts(),
		}),
		Authorize: allowAll,
	}
	plans := f.prepare(deps)
	if len(plans) != 1 {
		t.Fatalf("want 1 leased briefing, got %d", len(plans))
	}
	p := plans[0]
	if p.MessageSeq != 0 || p.Delivery.SourceKind != SourceBriefing || p.Delivery.MessageID.Valid || p.Attempt.MessageID.Valid {
		t.Fatalf("briefing plan must be a null-message seq 0 intent: %+v seq=%d", p.Delivery, p.MessageSeq)
	}
	return ackFixture{f: f, plan: p, princ: principalOf(&p.Attempt)}
}

func (a ackFixture) controlInput() ControlAckInput {
	return ControlAckInput{
		Principal:    a.princ,
		AgentID:      a.plan.Attempt.AgentID,
		OccurrenceID: a.plan.Attempt.OccurrenceID,
		LaunchID:     a.plan.Attempt.LaunchSnapshot.String,
		SessionID:    a.plan.Attempt.SessionSnapshot.String,
	}
}

func TestAcknowledgeControlReportedReceipt(t *testing.T) {
	a := leaseBriefing(t, newFixture(t), fullFacts(txMachine1, "launch-1", "session-1"), "onboarding")
	res, err := a.f.store.AcknowledgeControl(t.Context(), a.controlInput())
	if err != nil {
		t.Fatal(err)
	}
	if res.AlreadyAcknowledged || res.OccurrenceID != a.plan.Attempt.OccurrenceID {
		t.Fatalf("result: %+v", res)
	}
	d := a.f.deliveryByID(a.plan.Delivery.ID)
	if d.SchedulingState != StateAcknowledged || !d.AcknowledgedAt.Valid {
		t.Fatalf("delivery: %+v", d)
	}
	at, _ := a.f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	if at.State != AttemptTerminal || str(at.TerminalCode) != TerminalAcked || !at.AckedAt.Valid {
		t.Fatalf("attempt: %+v", at)
	}
	// Reported receipt only: the control path does not invent daemon
	// observations and has no model-consumption column to set.
	if at.ReceivedAt.Valid || at.PendingAt.Valid || at.DrainedReportedAt.Valid || at.DispatchedAt.Valid {
		t.Fatalf("ack invented consumption or send observations: %+v", at)
	}
	firstAck := d.AcknowledgedAt.Int64
	firstRevision := at.Revision
	again, err := a.f.store.AcknowledgeControl(t.Context(), a.controlInput())
	if err != nil {
		t.Fatal(err)
	}
	if !again.AlreadyAcknowledged {
		t.Fatal("duplicate control ack must be idempotent")
	}
	d2 := a.f.deliveryByID(a.plan.Delivery.ID)
	at2, _ := a.f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	if d2.AcknowledgedAt.Int64 != firstAck || at2.AckedAt.Int64 != at.AckedAt.Int64 || at2.Revision != firstRevision {
		t.Fatal("duplicate control ack refreshed the receipt")
	}
	if at2.DrainedReportedAt.Valid {
		t.Fatal("replay invented a drained observation")
	}
}

func TestControlAckBeforeMarkSentSurvivesRetryAndRestart(t *testing.T) {
	f := newFixture(t)
	a := leaseBriefing(t, f, fullFacts(txMachine1, "launch-1", "session-1"), "onboarding")
	if _, err := f.store.AcknowledgeControl(t.Context(), a.controlInput()); err != nil {
		t.Fatal(err)
	}
	ackedAt := f.deliveryByID(a.plan.Delivery.ID).AcknowledgedAt.Int64
	// The send observation returns after the ack (MarkSent / recoverable
	// failure). Neither may move the intent back to pending.
	if err := f.store.RecordManagedSendResult(t.Context(), SendOutcome{
		OccurrenceID: a.plan.Attempt.OccurrenceID, Accepted: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.store.RecordManagedSendResult(t.Context(), SendOutcome{
		OccurrenceID: a.plan.Attempt.OccurrenceID, ErrorCode: "late_failure", Recoverable: true,
	}); err != nil {
		t.Fatal(err)
	}
	d := f.deliveryByID(a.plan.Delivery.ID)
	if d.SchedulingState != StateAcknowledged || d.AcknowledgedAt.Int64 != ackedAt {
		t.Fatalf("send observation overwrote the racing ack: %+v", d)
	}
	at, _ := f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	if str(at.TerminalCode) != TerminalAcked || at.DispatchedAt.Valid || at.DrainedReportedAt.Valid {
		t.Fatalf("racing send rewrote the reported receipt: %+v", at)
	}

	// Restart: an expired lease scan and a later prepare must not reissue
	// an acknowledged control intent.
	f.clock.Advance(2 * RetryBackoffCap)
	recovered, err := f.store.RecoverExpiredLeases(t.Context(), f.clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Managed != 0 {
		t.Fatalf("acknowledged briefing was recovered: %+v", recovered)
	}
	plans := f.prepare(DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll})
	if len(plans) != 0 {
		t.Fatalf("restart re-leased an acknowledged briefing: %d", len(plans))
	}
	if f.deliveryByID(a.plan.Delivery.ID).SchedulingState != StateAcknowledged {
		t.Fatal("restart cleared the reported receipt")
	}
}

func TestControlAckRejectsOldLaunchCredentialAndAgent(t *testing.T) {
	f := newFixture(t)
	a := leaseBriefing(t, f, fullFacts(txMachine1, "launch-1", "session-1"), "onboarding")
	before := f.deliveryByID(a.plan.Delivery.ID)
	attemptBefore, _ := f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	base := a.controlInput()
	cases := map[string]ControlAckInput{
		"old launch":               {Principal: base.Principal, AgentID: base.AgentID, OccurrenceID: base.OccurrenceID, LaunchID: "launch-old", SessionID: base.SessionID},
		"old session":              {Principal: base.Principal, AgentID: base.AgentID, OccurrenceID: base.OccurrenceID, LaunchID: base.LaunchID, SessionID: "session-old"},
		"other machine credential": {Principal: MachinePrincipal{ComputerID: "other-computer", MachineID: txMachine2, WorkspaceID: txWS}, AgentID: base.AgentID, OccurrenceID: base.OccurrenceID, LaunchID: base.LaunchID, SessionID: base.SessionID},
		"other workspace":          {Principal: MachinePrincipal{MachineID: txMachine1, WorkspaceID: txWS2}, AgentID: base.AgentID, OccurrenceID: base.OccurrenceID, LaunchID: base.LaunchID, SessionID: base.SessionID},
		"other agent":              {Principal: base.Principal, AgentID: txAgentE, OccurrenceID: base.OccurrenceID, LaunchID: base.LaunchID, SessionID: base.SessionID},
		"unknown occurrence":       {Principal: base.Principal, AgentID: base.AgentID, OccurrenceID: "no-such-occurrence", LaunchID: base.LaunchID, SessionID: base.SessionID},
	}
	for name, input := range cases {
		if _, err := f.store.AcknowledgeControl(t.Context(), input); err == nil {
			t.Fatalf("%s: expected denial", name)
		}
		after := f.deliveryByID(a.plan.Delivery.ID)
		at, _ := f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
		if after.SchedulingState != before.SchedulingState || after.Revision != before.Revision || after.AcknowledgedAt.Valid {
			t.Fatalf("%s: delivery mutated: %+v", name, after)
		}
		if at.Revision != attemptBefore.Revision || at.AckedAt.Valid || at.State != AttemptInFlight {
			t.Fatalf("%s: attempt mutated: %+v", name, at)
		}
	}
}

func TestControlAckDoesNotClearOtherIntentsOrTrackedMessages(t *testing.T) {
	f := newFixture(t)
	f.seed()
	if err := f.planBriefing(txAgentM, "onboarding"); err != nil {
		t.Fatal(err)
	}
	if err := f.planBriefing(txAgentM, "later"); err != nil {
		t.Fatal(err)
	}
	msgID, seq := f.seedMessage("m-tracked")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	facts := fullFacts(txMachine1, "launch-1", "session-1")
	plans := f.prepare(DispatchDeps{Facts: factsFor(facts), Authorize: allowAll})
	if len(plans) != 1 {
		t.Fatalf("single outstanding lease: %d", len(plans))
	}
	leased := plans[0]
	input := ControlAckInput{
		Principal:    principalOf(&leased.Attempt),
		AgentID:      leased.Attempt.AgentID,
		OccurrenceID: leased.Attempt.OccurrenceID,
		LaunchID:     "launch-1",
		SessionID:    "session-1",
	}
	if leased.Delivery.SourceKind != SourceBriefing {
		t.Fatalf("expected the briefing to lease first, got %s", leased.Delivery.SourceKind)
	}
	if _, err := f.store.AcknowledgeControl(t.Context(), input); err != nil {
		t.Fatal(err)
	}
	var pending, acknowledged int
	rows, err := f.db.Query(`SELECT scheduling_state FROM agent_deliveries WHERE agent_id = ?`, txAgentM)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var state string
		if err := rows.Scan(&state); err != nil {
			t.Fatal(err)
		}
		switch state {
		case StateAcknowledged:
			acknowledged++
		case StatePending, StateLeased:
			pending++
		}
	}
	rows.Close()
	if acknowledged != 1 || pending != 2 {
		t.Fatalf("seq 0 ack changed more than one intent: acked=%d open=%d", acknowledged, pending)
	}
	// The tracked message is still unacked. A positive five-tuple is required;
	// seq 0 cannot confirm it.
	snap := MentionSnapshot{
		OccurrenceID: "missing", MessageID: msgID, MachineID: txMachine1,
		LaunchID: "launch-1", SessionID: "session-1",
	}
	if _, err := f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: principalOf(&leased.Attempt), AgentID: txAgentM, Seq: 0, Snapshot: &snap,
	}); err == nil {
		t.Fatal("seq 0 tracked ack was accepted")
	}
	if seq <= 0 {
		t.Fatal("tracked message seq must stay positive")
	}
}

func TestUnackedControlRetryReusesOccurrence(t *testing.T) {
	f := newFixture(t)
	a := leaseBriefing(t, f, fullFacts(txMachine1, "launch-1", "session-1"), "onboarding")
	occ := a.plan.Attempt.OccurrenceID
	d := f.deliveryByID(a.plan.Delivery.ID)
	f.clock.Advance(time.Duration(i64(d.LeaseExpiresAt)-f.clock.Now().UnixMilli())*time.Millisecond + time.Second)
	recovered, err := f.store.RecoverExpiredLeases(t.Context(), f.clock.Now())
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Managed != 1 {
		t.Fatalf("unacked control lease should recover: %+v", recovered)
	}
	plans := f.prepare(DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-1", "session-1")), Authorize: allowAll})
	if len(plans) != 1 || plans[0].Attempt.OccurrenceID != occ {
		t.Fatalf("same launch/session retry must reuse the occurrence: %+v", plans)
	}
	if plans[0].Delivery.RetryCount < 2 {
		t.Fatalf("retry must keep the budget: %+v", plans[0].Delivery.RetryCount)
	}
	if _, err := f.store.AcknowledgeControl(t.Context(), ControlAckInput{
		Principal: principalOf(&plans[0].Attempt), AgentID: txAgentM,
		OccurrenceID: occ, LaunchID: "launch-1", SessionID: "session-1",
	}); err != nil {
		t.Fatal(err)
	}
	if f.deliveryByID(a.plan.Delivery.ID).SchedulingState != StateAcknowledged {
		t.Fatal("reused occurrence ack did not confirm the intent")
	}
}

func TestManagedAckDoesNotConfirmBriefing(t *testing.T) {
	a := leaseBriefing(t, newFixture(t), fullFacts(txMachine1, "launch-1", "session-1"), "onboarding")
	snap := MentionSnapshot{
		OccurrenceID: a.plan.Attempt.OccurrenceID,
		MessageID:    "forged-message",
		MachineID:    a.plan.Attempt.MachineSnapshot.String,
		LaunchID:     a.plan.Attempt.LaunchSnapshot.String,
		SessionID:    a.plan.Attempt.SessionSnapshot.String,
	}
	_, err := a.f.store.AcknowledgeManaged(t.Context(), AckInput{
		Principal: a.princ, AgentID: txAgentM, Seq: 1, Snapshot: &snap,
	})
	if !errors.Is(err, ErrControlPathMismatch) {
		t.Fatalf("managed ack of briefing: %v", err)
	}
	d := a.f.deliveryByID(a.plan.Delivery.ID)
	if d.SchedulingState != StateLeased || d.AcknowledgedAt.Valid {
		t.Fatalf("managed ack mutated the briefing: %+v", d)
	}
}

func TestOldLaunchControlReceiptDoesNotMutateSupersededAttempt(t *testing.T) {
	f := newFixture(t)
	a := leaseBriefing(t, f, fullFacts(txMachine1, "launch-1", "session-1"), "onboarding")
	oldOcc := a.plan.Attempt.OccurrenceID
	d := f.deliveryByID(a.plan.Delivery.ID)
	f.clock.Advance(time.Duration(i64(d.LeaseExpiresAt)-f.clock.Now().UnixMilli())*time.Millisecond + time.Second)
	plans := f.prepare(DispatchDeps{Facts: factsFor(fullFacts(txMachine1, "launch-2", "session-2")), Authorize: allowAll})
	if len(plans) != 1 || plans[0].Attempt.OccurrenceID == oldOcc {
		t.Fatalf("restart with a new launch must mint an occurrence: %+v", plans)
	}
	old, _ := f.store.AttemptByOccurrence(t.Context(), oldOcc)
	if old.State != AttemptTerminal || str(old.TerminalCode) != TerminalSuperseded || old.AckedAt.Valid {
		t.Fatalf("old attempt: %+v", old)
	}
	// Current launch/session against the old occurrence: denial, no audit write.
	_, err := f.store.AcknowledgeControl(t.Context(), ControlAckInput{
		Principal: a.princ, AgentID: txAgentM, OccurrenceID: oldOcc,
		LaunchID: "launch-2", SessionID: "session-2",
	})
	if err == nil {
		t.Fatal("old occurrence accepted under the new launch")
	}
	// A caller that still presents the old launch is also a zero-change denial.
	_, err = f.store.AcknowledgeControl(t.Context(), ControlAckInput{
		Principal: a.princ, AgentID: txAgentM, OccurrenceID: oldOcc,
		LaunchID: "launch-1", SessionID: "session-1",
	})
	if err == nil {
		t.Fatal("superseded control receipt mutated state")
	}
	old, _ = f.store.AttemptByOccurrence(t.Context(), oldOcc)
	if old.AckedAt.Valid || str(old.TerminalCode) != TerminalSuperseded {
		t.Fatalf("old receipt mutated the superseded attempt: %+v", old)
	}
	current := f.deliveryByID(a.plan.Delivery.ID)
	if current.SchedulingState != StateLeased || current.AcknowledgedAt.Valid {
		t.Fatalf("old receipt confirmed the new attempt: %+v", current)
	}
	fresh := plans[0]
	if _, err := f.store.AcknowledgeControl(t.Context(), ControlAckInput{
		Principal: principalOf(&fresh.Attempt), AgentID: txAgentM,
		OccurrenceID: fresh.Attempt.OccurrenceID, LaunchID: "launch-2", SessionID: "session-2",
	}); err != nil {
		t.Fatal(err)
	}
	if f.deliveryByID(a.plan.Delivery.ID).SchedulingState != StateAcknowledged {
		t.Fatal("current launch ack did not confirm the new occurrence")
	}
	old, _ = f.store.AttemptByOccurrence(t.Context(), oldOcc)
	if old.AckedAt.Valid {
		t.Fatal("new ack wrote the old occurrence")
	}
}

func TestControlAckRacesSendObservation(t *testing.T) {
	f := newFixture(t)
	a := leaseBriefing(t, f, fullFacts(txMachine1, "launch-1", "session-1"), "onboarding")
	input := a.controlInput()
	start := make(chan struct{})
	errc := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		errc <- retryBusy(func() error {
			_, err := f.store.AcknowledgeControl(t.Context(), input)
			return err
		})
	}()
	go func() {
		defer wg.Done()
		<-start
		errc <- retryBusy(func() error {
			return f.store.RecordManagedSendResult(t.Context(), SendOutcome{
				OccurrenceID: a.plan.Attempt.OccurrenceID,
				ErrorCode:    "late_failure",
				Recoverable:  true,
			})
		})
	}()
	close(start)
	wg.Wait()
	close(errc)
	for err := range errc {
		if err != nil {
			t.Fatal(err)
		}
	}
	d := f.deliveryByID(a.plan.Delivery.ID)
	at, _ := f.store.AttemptByOccurrence(t.Context(), a.plan.Attempt.OccurrenceID)
	if d.SchedulingState != StateAcknowledged || !d.AcknowledgedAt.Valid {
		t.Fatalf("racing send must not outrank the control receipt: %+v", d)
	}
	if str(at.TerminalCode) != TerminalAcked || at.DrainedReportedAt.Valid {
		t.Fatalf("race left a consumption-shaped attempt: %+v", at)
	}
}

func retryBusy(fn func() error) error {
	var err error
	for i := 0; i < 30; i++ {
		err = fn()
		if err == nil || !isBusy(err) {
			return err
		}
		time.Sleep(time.Millisecond)
	}
	return err
}

func isBusy(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "locked") || strings.Contains(msg, "busy") || strings.Contains(msg, "SQLITE_BUSY")
}
