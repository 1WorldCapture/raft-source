package delivery

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"testing"
)

func sinceOf(v int64) *int64 { return &v }

func schedulingByMessage(t *testing.T, db *sql.DB, messageID string) string {
	t.Helper()
	var state string
	if err := db.QueryRow(
		`SELECT scheduling_state FROM agent_deliveries WHERE agent_id = ? AND message_id = ?`,
		txAgentE, messageID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestAckPartialSubsetLeavesRemainderClaimable(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, s1 := f.seedMessage("m1")
	m2, s2 := f.seedMessage("m2")
	if err := f.planMessage(m1, txAgentE); err != nil || f.planMessage(m2, txAgentE) != nil {
		t.Fatal(err)
	}
	var authCalls int
	deps := DispatchDeps{
		Facts: claimDeps().Facts,
		Authorize: func(context.Context, Executor, Delivery) (bool, string, error) {
			authCalls++
			return true, "", nil
		},
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), deps, validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	if authCalls != 2 {
		t.Fatalf("claim auth calls = %d", authCalls)
	}
	ack, err := f.store.AckAgentClaim(t.Context(), deps, validateOK, ClaimAckInput{
		Principal: principalE(),
		Claim:     ClaimReceipt{Seqs: []int64{s1, s1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ack.RemovedCount != 1 {
		t.Fatalf("duplicate seq removed %d; want 1", ack.RemovedCount)
	}
	if schedulingByMessage(t, f.db, m1) != StateAcknowledged || schedulingByMessage(t, f.db, m2) != StateLeased {
		t.Fatal("partial ack must leave the unnamed row leased")
	}
	var eventCount, removed int64
	var ackedAt sql.NullInt64
	if err := f.db.QueryRow(
		`SELECT event_count, removed_count, acked_at FROM agent_delivery_claims WHERE id = ?`,
		claim.ClaimID).Scan(&eventCount, &removed, &ackedAt); err != nil {
		t.Fatal(err)
	}
	if eventCount != 1 || removed != 1 || ackedAt.Valid {
		t.Fatalf("partial audit = count %d removed %d acked %v", eventCount, removed, ackedAt.Valid)
	}
	callsBeforeReissue := authCalls
	again, err := f.store.ClaimAgentEvents(t.Context(), deps, validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	if !again.Reissued || again.ClaimID != claim.ClaimID || len(again.Events) != 1 || again.Events[0].Seq != s2 {
		t.Fatalf("remainder reissue = %+v", again)
	}
	if authCalls <= callsBeforeReissue {
		t.Fatal("reissue must recheck current authority")
	}
	if f.deliveryByID(again.Events[0].DeliveryID).RetryCount != 1 {
		t.Fatal("reissue charged the remainder a second time")
	}
	rest, err := f.store.AckAgentClaim(t.Context(), deps, validateOK, ClaimAckInput{
		Principal: principalE(), Claim: ClaimReceipt{Seqs: []int64{s2}},
	})
	if err != nil || rest.RemovedCount != 1 {
		t.Fatalf("remainder ack = %+v %v", rest, err)
	}
	if err := f.db.QueryRow(
		`SELECT event_count, removed_count, acked_at FROM agent_delivery_claims WHERE id = ?`,
		claim.ClaimID).Scan(&eventCount, &removed, &ackedAt); err != nil {
		t.Fatal(err)
	}
	if eventCount != 0 || removed != 2 || !ackedAt.Valid {
		t.Fatalf("closed audit = count %d removed %d acked %v", eventCount, removed, ackedAt.Valid)
	}
	rev := f.deliveryByID(again.Events[0].DeliveryID).Revision
	replay, err := f.store.AckAgentClaim(t.Context(), deps, validateOK, ClaimAckInput{
		Principal: principalE(), Claim: ClaimReceipt{Seqs: []int64{s1, s2, s2}},
	})
	if err != nil || replay.RemovedCount != 0 {
		t.Fatalf("duplicate replay = %+v %v", replay, err)
	}
	if f.deliveryByID(again.Events[0].DeliveryID).Revision != rev {
		t.Fatal("replay wrote again")
	}
}

func TestAckDuplicateForeignAndWatermark(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, _ := f.seedMessage("m1")
	m2, _ := f.seedMessage("m2")
	m3, s3 := f.seedMessage("m3")
	orphan, orphanSeq := f.seedMessage("orphan")
	if err := f.planMessage(m1, txAgentE); err != nil || f.planMessage(m2, txAgentE) != nil || f.planMessage(m3, txAgentE) != nil {
		t.Fatal(err)
	}
	if err := f.planBriefing(txAgentE, "onboarding"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()}); err != nil {
		t.Fatal(err)
	}
	// Consistent but never claimed: the orphan seq/id pair removes nothing.
	miss, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(),
		Claim:     ClaimReceipt{Seqs: []int64{orphanSeq}, MessageIDs: []string{orphan}},
	})
	if err != nil || miss.RemovedCount != 0 {
		t.Fatalf("unclaimed pair = %+v %v", miss, err)
	}
	if schedulingByMessage(t, f.db, m1) != StateLeased {
		t.Fatal("unclaimed ack touched a leased row")
	}
	ack, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(),
		Claim: ClaimReceipt{
			Seqs:       []int64{s3, s3, 0, s3 + 1000},
			MessageIDs: []string{"foreign-id", "foreign-id"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ack.RemovedCount != 1 {
		t.Fatalf("removed = %d; want only the one claimed seq", ack.RemovedCount)
	}
	if schedulingByMessage(t, f.db, m3) != StateAcknowledged {
		t.Fatal("exact seq was not acknowledged")
	}
	if schedulingByMessage(t, f.db, m1) != StateLeased || schedulingByMessage(t, f.db, m2) != StateLeased {
		t.Fatal("max seq acknowledged lower rows")
	}
	var briefingState string
	if err := f.db.QueryRow(
		`SELECT scheduling_state FROM agent_deliveries WHERE agent_id = ? AND source_kind = ?`,
		txAgentE, SourceBriefing).Scan(&briefingState); err != nil {
		t.Fatal(err)
	}
	if briefingState != StateLeased {
		t.Fatalf("seq 0 acknowledged the briefing: %s", briefingState)
	}
}

func TestAckSeqMessageMismatchIsFailClosed(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, s1 := f.seedMessage("m1")
	m2, _ := f.seedMessage("m2")
	if err := f.planMessage(m1, txAgentE); err != nil || f.planMessage(m2, txAgentE) != nil {
		t.Fatal(err)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	before1 := f.deliveryByID(claim.Events[0].DeliveryID).Revision
	before2 := f.deliveryByID(claim.Events[1].DeliveryID).Revision
	_, err = f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(),
		Claim:     ClaimReceipt{Seqs: []int64{s1}, MessageIDs: []string{m2}},
	})
	if !errors.Is(err, ErrClaimInconsistent) {
		t.Fatalf("mismatched seq and message id: %v", err)
	}
	if f.deliveryByID(claim.Events[0].DeliveryID).Revision != before1 || f.deliveryByID(claim.Events[1].DeliveryID).Revision != before2 {
		t.Fatal("inconsistent ack wrote")
	}
	if schedulingByMessage(t, f.db, m1) != StateLeased || schedulingByMessage(t, f.db, m2) != StateLeased {
		t.Fatal("inconsistent ack changed lease state")
	}
	// The same message's seq and id together are one row, not two removals.
	ack, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(),
		Claim:     ClaimReceipt{Seqs: []int64{s1}, MessageIDs: []string{m1}},
	})
	if err != nil || ack.RemovedCount != 1 {
		t.Fatalf("consistent alias = %+v %v", ack, err)
	}
	if schedulingByMessage(t, f.db, m1) != StateAcknowledged || schedulingByMessage(t, f.db, m2) != StateLeased {
		t.Fatal("alias ack did not stop at the one message")
	}
}

func TestClaimBriefingNoticeOmitsSeqZero(t *testing.T) {
	f := newFixture(t)
	f.seed()
	if err := f.planBriefing(txAgentE, "onboarding"); err != nil || f.planBriefing(txAgentE, "welcome") != nil {
		t.Fatal(err)
	}
	m1, s1 := f.seedMessage("m1")
	if err := f.planMessage(m1, txAgentE); err != nil {
		t.Fatal(err)
	}
	var messagesBefore int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&messagesBefore); err != nil {
		t.Fatal(err)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	var messagesAfter int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&messagesAfter); err != nil {
		t.Fatal(err)
	}
	if messagesAfter != messagesBefore {
		t.Fatal("claim inserted a message row")
	}
	if len(claim.Claim.Seqs) != 1 || claim.Claim.Seqs[0] != s1 {
		t.Fatalf("message seqs = %v", claim.Claim.Seqs)
	}
	for _, seq := range claim.Claim.Seqs {
		if seq <= 0 {
			t.Fatalf("seq 0 leaked into ack seqs: %v", claim.Claim.Seqs)
		}
	}
	var notices []ClaimedEvent
	for _, event := range claim.Events {
		if event.SourceKind != SourceBriefing {
			continue
		}
		notices = append(notices, event)
		if event.MessageID != "" || event.Seq != 0 {
			t.Fatalf("briefing projected as a public message: %+v", event)
		}
		var fake int
		if err := f.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE id = ?`, event.DeliveryID).Scan(&fake); err != nil {
			t.Fatal(err)
		}
		if fake != 0 {
			t.Fatal("notice id is a messages row")
		}
	}
	if len(notices) != 2 || len(claim.Claim.MessageIDs) != 2 {
		t.Fatalf("notice receipt = %+v events %+v", claim.Claim, claim.Events)
	}
	for _, id := range claim.Claim.MessageIDs {
		found := false
		for _, event := range notices {
			if event.DeliveryID == id {
				found = true
			}
		}
		if !found {
			t.Fatalf("message id %s is not a briefing delivery id", id)
		}
	}
	zero, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(), Claim: ClaimReceipt{Seqs: []int64{0}},
	})
	if err != nil || zero.RemovedCount != 0 {
		t.Fatalf("seq 0 ack = %+v %v", zero, err)
	}
	for _, event := range notices {
		if f.deliveryByID(event.DeliveryID).SchedulingState != StateLeased {
			t.Fatal("seq 0 acknowledged a briefing")
		}
	}
	one, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(), Claim: ClaimReceipt{MessageIDs: []string{notices[0].DeliveryID}},
	})
	if err != nil || one.RemovedCount != 1 {
		t.Fatalf("notice ack = %+v %v", one, err)
	}
	if f.deliveryByID(notices[0].DeliveryID).SchedulingState != StateAcknowledged {
		t.Fatal("notice id did not acknowledge its briefing")
	}
	if f.deliveryByID(notices[1].DeliveryID).SchedulingState != StateLeased {
		t.Fatal("sibling briefing was acknowledged")
	}
	if schedulingByMessage(t, f.db, m1) != StateLeased {
		t.Fatal("notice ack acknowledged the message")
	}
}

func TestClaimSinceReissueAndCancel(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, s1 := f.seedMessage("m1")
	m2, s2 := f.seedMessage("m2")
	m3, s3 := f.seedMessage("m3")
	if err := f.planMessage(m1, txAgentE); err != nil || f.planMessage(m2, txAgentE) != nil || f.planMessage(m3, txAgentE) != nil {
		t.Fatal(err)
	}
	if err := f.planBriefing(txAgentE, "onboarding"); err != nil {
		t.Fatal(err)
	}
	neg := int64(-1)
	if _, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{
		Principal: principalE(), SinceSeq: &neg,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("negative since: %v", err)
	}
	if schedulingByMessage(t, f.db, m1) != StatePending {
		t.Fatal("rejected since leased a row")
	}

	head, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{
		Principal: principalE(), Limit: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(head.Events) != 1 || head.Events[0].Seq != s1 {
		t.Fatalf("head = %+v", head.Events)
	}
	next, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{
		Principal: principalE(), Limit: 1, SinceSeq: sinceOf(s1),
	})
	if err != nil {
		t.Fatal(err)
	}
	if next.Reissued || next.ClaimID != head.ClaimID || len(next.Events) != 1 || next.Events[0].Seq != s2 {
		t.Fatalf("since continuation = %+v", next)
	}
	if schedulingByMessage(t, f.db, m1) != StateLeased || schedulingByMessage(t, f.db, m2) != StateLeased || schedulingByMessage(t, f.db, m3) != StatePending {
		t.Fatal("since continuation leased or skipped the wrong rows")
	}
	var eventCount int64
	var ackedAt sql.NullInt64
	if err := f.db.QueryRow(
		`SELECT event_count, acked_at FROM agent_delivery_claims WHERE id = ?`, head.ClaimID).Scan(&eventCount, &ackedAt); err != nil {
		t.Fatal(err)
	}
	if eventCount != 2 || ackedAt.Valid {
		t.Fatalf("hidden head fell out of the claim: count %d acked %v", eventCount, ackedAt.Valid)
	}
	acked, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(), Claim: next.Claim,
	})
	if err != nil || acked.RemovedCount != 1 {
		t.Fatalf("page ack = %+v %v", acked, err)
	}
	if schedulingByMessage(t, f.db, m2) != StateAcknowledged || schedulingByMessage(t, f.db, m1) != StateLeased {
		t.Fatal("page ack confirmed a row the since page did not return")
	}

	drained, removed, err := f.store.DrainLegacyEventsQuery(t.Context(), claimDeps(), validateOK, LegacyDrainQuery{
		Principal: principalE(), Limit: 1, SinceSeq: sinceOf(s1),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(drained) != 1 || drained[0].Seq != s3 || removed != 1 {
		t.Fatalf("drain since = %+v removed %d", drained, removed)
	}
	if schedulingByMessage(t, f.db, m1) != StateLeased || schedulingByMessage(t, f.db, m3) != StateAcknowledged {
		t.Fatal("legacy drain acknowledged a filtered row")
	}

	again, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	if !again.Reissued || len(again.Events) != 1 || again.Events[0].Seq != s1 {
		t.Fatalf("latest reclaim must reissue only the still-leased head: %+v", again.Events)
	}
	var briefingState string
	if err := f.db.QueryRow(
		`SELECT scheduling_state FROM agent_deliveries WHERE agent_id = ? AND source_kind = ?`,
		txAgentE, SourceBriefing).Scan(&briefingState); err != nil {
		t.Fatal(err)
	}
	if briefingState != StatePending {
		t.Fatalf("unleased briefing state = %s", briefingState)
	}
	if _, err := f.store.CancelDeliveries(t.Context(), CancelInput{
		WorkspaceID: txWS, AgentID: txAgentE, MessageID: m1, Reason: "membership_removed",
	}); err != nil {
		t.Fatal(err)
	}
	afterCancel, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range afterCancel.Events {
		if event.Seq == s1 || event.MessageID == m1 {
			t.Fatalf("cancelled message was reissued: %+v", event)
		}
	}
	if schedulingByMessage(t, f.db, m1) != StateCancelled {
		t.Fatal("cancel did not stick across reissue")
	}
	if len(afterCancel.Events) != 1 || afterCancel.Events[0].SourceKind != SourceBriefing || afterCancel.Events[0].MessageID != "" {
		t.Fatalf("briefing reissue = %+v", afterCancel.Events)
	}
	if len(afterCancel.Claim.Seqs) != 0 || len(afterCancel.Claim.MessageIDs) != 1 || afterCancel.Claim.MessageIDs[0] != afterCancel.Events[0].DeliveryID {
		t.Fatalf("briefing receipt = %+v", afterCancel.Claim)
	}
}

func TestAckSkipsCancelledAndSuperseded(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, s1 := f.seedMessage("m1")
	m2, s2 := f.seedMessage("m2")
	if err := f.planMessage(m1, txAgentE); err != nil || f.planMessage(m2, txAgentE) != nil {
		t.Fatal(err)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	superseded := f.openAttempt(claim.Events[0].DeliveryID)
	f.mustExec(`UPDATE agent_delivery_attempts
		SET state = 'terminal', terminal_code = 'SUPERSEDED'
		WHERE occurrence_id = ?`, superseded.OccurrenceID)
	skipped, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(), Claim: ClaimReceipt{Seqs: []int64{claim.Events[0].Seq}},
	})
	if err != nil || skipped.RemovedCount != 0 {
		t.Fatalf("superseded ack = %+v %v", skipped, err)
	}
	if schedulingByMessage(t, f.db, claim.Events[0].MessageID) == StateAcknowledged {
		t.Fatal("superseded attempt was acknowledged")
	}
	at, err := f.store.AttemptByOccurrence(t.Context(), superseded.OccurrenceID)
	if err != nil {
		t.Fatal(err)
	}
	if str(at.TerminalCode) != TerminalSuperseded || at.AckedAt.Valid {
		t.Fatalf("superseded attempt rewritten: %+v", at)
	}
	if _, err := f.store.CancelDeliveries(t.Context(), CancelInput{
		WorkspaceID: txWS, MessageID: m2, Reason: "agent_deleted",
	}); err != nil {
		t.Fatal(err)
	}
	cancelled, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(), Claim: ClaimReceipt{Seqs: []int64{s2, s1}},
	})
	if err != nil || cancelled.RemovedCount != 0 {
		t.Fatalf("cancelled ack = %+v %v", cancelled, err)
	}
	if schedulingByMessage(t, f.db, m2) != StateCancelled {
		t.Fatal("cancelled delivery changed")
	}
	var code sql.NullString
	if err := f.db.QueryRow(
		`SELECT terminal_code FROM agent_delivery_attempts WHERE delivery_id = (
			SELECT id FROM agent_deliveries WHERE message_id = ? AND agent_id = ?)`,
		m2, txAgentE).Scan(&code); err != nil {
		t.Fatal(err)
	}
	if str(code) == TerminalAcked {
		t.Fatal("cancelled attempt was marked ACKED")
	}
	revoked := errors.New("credential revoked")
	if _, err := f.store.AckAgentClaim(t.Context(), claimDeps(), func(context.Context, Executor, AgentPrincipal) error {
		return revoked
	}, ClaimAckInput{Principal: principalE(), Claim: ClaimReceipt{Seqs: []int64{s1}}}); !errors.Is(err, revoked) {
		t.Fatalf("revoked credential: %v", err)
	}
}

func TestAckSubsetRacesSiblingAndCancel(t *testing.T) {
	f := newFixture(t)
	f.seed()
	m1, _ := f.seedMessage("m1")
	m2, s2 := f.seedMessage("m2")
	if err := f.planMessage(m1, txAgentE); err != nil || f.planMessage(m2, txAgentE) != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()}); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	errc := make(chan error, 3)
	wg.Add(3)
	go func() {
		defer wg.Done()
		<-start
		errc <- retryBusy(func() error {
			_, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
				Principal: principalE(), Claim: ClaimReceipt{Seqs: []int64{s2}},
			})
			return err
		})
	}()
	go func() {
		defer wg.Done()
		<-start
		errc <- retryBusy(func() error {
			_, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
			return err
		})
	}()
	go func() {
		defer wg.Done()
		<-start
		errc <- retryBusy(func() error {
			_, err := f.store.CancelDeliveries(t.Context(), CancelInput{
				WorkspaceID: txWS, AgentID: txAgentE, MessageID: m1, Reason: "membership_removed",
			})
			return err
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
	if schedulingByMessage(t, f.db, m2) != StateAcknowledged {
		t.Fatalf("sibling ack lost: %s", schedulingByMessage(t, f.db, m2))
	}
	if schedulingByMessage(t, f.db, m1) != StateCancelled {
		t.Fatalf("cancel lost: %s", schedulingByMessage(t, f.db, m1))
	}
	var code sql.NullString
	if err := f.db.QueryRow(
		`SELECT a.terminal_code
		 FROM agent_deliveries d
		 JOIN agent_delivery_attempts a ON a.delivery_id = d.id
		 WHERE d.message_id = ? AND d.agent_id = ?
		 ORDER BY a.attempt_number DESC LIMIT 1`, m1, txAgentE).Scan(&code); err != nil {
		t.Fatal(err)
	}
	if str(code) == TerminalAcked {
		t.Fatal("cancelled delivery was acknowledged")
	}
	if f.deliveryByID(mustDeliveryID(t, f.db, m2)).RetryCount != 1 {
		t.Fatal("racing reissue charged a second budget")
	}
}

func mustDeliveryID(t *testing.T, db *sql.DB, messageID string) string {
	t.Helper()
	var id string
	if err := db.QueryRow(
		`SELECT id FROM agent_deliveries WHERE agent_id = ? AND message_id = ?`, txAgentE, messageID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
