package delivery

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func TestClaimProjectionFailureAckIsNotDurable(t *testing.T) {
	f := newFixture(t)
	f.seed()
	messageID, seq := f.seedMessage("proj-fail")
	if err := f.planMessage(messageID, txAgentE); err != nil {
		t.Fatal(err)
	}
	boom := errors.New("projection rejected")
	var sawLeased bool
	_, removed, err := f.store.DrainLegacyEventsQuery(t.Context(), claimDeps(), validateOK, LegacyDrainQuery{
		Principal: principalE(),
		Project: func(ctx context.Context, ex Executor, page *ClaimResult) error {
			if len(page.Events) != 1 || page.Events[0].Seq != seq {
				t.Fatalf("page = %+v", page.Events)
			}
			var state string
			var acked sql.NullInt64
			if err := ex.QueryRowContext(ctx,
				`SELECT scheduling_state, acknowledged_at FROM agent_deliveries WHERE id = ?`,
				page.Events[0].DeliveryID).Scan(&state, &acked); err != nil {
				return err
			}
			sawLeased = state == StateLeased && !acked.Valid
			return boom
		},
	})
	if !errors.Is(err, boom) || removed != 0 || !sawLeased {
		t.Fatalf("drain err=%v removed=%d sawLeased=%v", err, removed, sawLeased)
	}
	if schedulingByMessage(t, f.db, messageID) != StatePending {
		t.Fatal("failed projection committed a lease or acknowledgement")
	}
	if f.count(`SELECT COUNT(*) FROM agent_deliveries WHERE acknowledged_at IS NOT NULL`) != 0 {
		t.Fatal("failed projection wrote acknowledged_at")
	}
	if f.count(`SELECT COUNT(*) FROM agent_delivery_attempts WHERE terminal_code = 'ACKED'`) != 0 {
		t.Fatal("failed projection wrote an ACKED attempt")
	}
	if f.count(`SELECT COUNT(*) FROM agent_delivery_claims WHERE acked_at IS NOT NULL`) != 0 {
		t.Fatal("failed projection closed a claim")
	}

	var first *ClaimResult
	again, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{
		Principal: principalE(),
		Project: func(_ context.Context, _ Executor, page *ClaimResult) error {
			first = page
			return nil
		},
	})
	if err != nil || again.Reissued || len(again.Events) != 1 || again.Events[0].Seq != seq {
		t.Fatalf("recovery claim = %+v %v", again, err)
	}
	reissued, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{
		Principal: principalE(),
		Project:   func(context.Context, Executor, *ClaimResult) error { return nil },
	})
	if err != nil || !reissued.Reissued || reissued.ClaimID != again.ClaimID || len(reissued.Events) != 1 || reissued.Events[0].DeliveryID != first.Events[0].DeliveryID || reissued.Events[0].Seq != seq {
		t.Fatalf("stable reissue = %+v %v", reissued, err)
	}
	if f.deliveryByID(reissued.Events[0].DeliveryID).RetryCount != 1 {
		t.Fatal("reissue charged the budget again")
	}
	if schedulingByMessage(t, f.db, messageID) != StateLeased {
		t.Fatal("reissue did not keep the unacknowledged lease")
	}

	_, _, err = f.store.DrainLegacyEventsQuery(t.Context(), claimDeps(), validateOK, LegacyDrainQuery{
		Principal: principalE(),
		Project:   func(context.Context, Executor, *ClaimResult) error { return boom },
	})
	if !errors.Is(err, boom) {
		t.Fatal(err)
	}
	if schedulingByMessage(t, f.db, messageID) != StateLeased {
		t.Fatal("failed drain of an open claim acknowledged or dropped it")
	}
	stable, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil || !stable.Reissued || stable.ClaimID != again.ClaimID || len(stable.Events) != 1 || stable.Events[0].Seq != seq {
		t.Fatalf("reissue after failed drain = %+v %v", stable, err)
	}
}

func TestClaimProjectionHasMoreDoesNotLeaseOmittedRows(t *testing.T) {
	f := newFixture(t)
	f.seed()
	_, s1 := f.seedMessage("h1")
	_, s2 := f.seedMessage("h2")
	if err := f.planMessage("h1", txAgentE); err != nil || f.planMessage("h2", txAgentE) != nil {
		t.Fatal(err)
	}
	exact, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{
		Principal: principalE(), Limit: 2,
	})
	if err != nil || exact.HasMore || len(exact.Events) != 2 || exact.Events[0].Seq != s1 || exact.Events[1].Seq != s2 {
		t.Fatalf("exact = %+v %v", exact, err)
	}

	f2 := newFixture(t)
	f2.seed()
	m1, _ := f2.seedMessage("p1")
	m2, _ := f2.seedMessage("p2")
	m3, s3 := f2.seedMessage("p3")
	if err := f2.planMessage(m1, txAgentE); err != nil || f2.planMessage(m2, txAgentE) != nil || f2.planMessage(m3, txAgentE) != nil {
		t.Fatal(err)
	}
	page, err := f2.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{
		Principal: principalE(), Limit: 2,
	})
	if err != nil || !page.HasMore || len(page.Events) != 2 || page.Events[0].Seq == s3 || page.Events[1].Seq == s3 {
		t.Fatalf("partial page = %+v %v", page, err)
	}
	if schedulingByMessage(t, f2.db, m3) != StatePending {
		t.Fatal("has_more leased the omitted row")
	}
	drained, removed, err := f2.store.DrainLegacyEventsQuery(t.Context(), claimDeps(), validateOK, LegacyDrainQuery{
		Principal: principalE(), Limit: 2,
	})
	if err != nil || removed != 2 || len(drained) != 2 {
		t.Fatalf("drain page = %+v removed %d err %v", drained, removed, err)
	}
	if schedulingByMessage(t, f2.db, m3) != StatePending {
		t.Fatal("drain acknowledged the omitted row")
	}
	rest, err := f2.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{
		Principal: principalE(), Limit: 2,
	})
	if err != nil || rest.HasMore || len(rest.Events) != 1 || rest.Events[0].Seq != s3 {
		t.Fatalf("final page = %+v %v", rest, err)
	}
}

func TestClaimProjectionNoticeAndSinceDoNotAckUnseen(t *testing.T) {
	f := newFixture(t)
	f.seed()
	beforeMessages := f.count(`SELECT COUNT(*) FROM messages`)
	if err := f.planBriefing(txAgentE, "onboarding"); err != nil {
		t.Fatal(err)
	}
	if f.count(`SELECT COUNT(*) FROM messages`) != beforeMessages {
		t.Fatal("briefing inserted a messages row")
	}
	only, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil || len(only.Events) != 1 || len(only.Claim.Seqs) != 0 || len(only.Claim.MessageIDs) != 1 {
		t.Fatalf("notice-only = %+v %v", only, err)
	}
	notice := only.Events[0]
	if notice.SourceKind != SourceBriefing || notice.Seq != 0 || notice.MessageID != "" || notice.DeliveryID == "" || only.Claim.MessageIDs[0] != notice.DeliveryID {
		t.Fatalf("notice event = %+v receipt %+v", notice, only.Claim)
	}
	acked, err := f.store.AckAgentClaim(t.Context(), claimDeps(), validateOK, ClaimAckInput{
		Principal: principalE(), Claim: ClaimReceipt{MessageIDs: []string{notice.DeliveryID}},
	})
	if err != nil || acked.RemovedCount != 1 {
		t.Fatalf("notice ack = %+v %v", acked, err)
	}
	if f.count(`SELECT COUNT(*) FROM messages`) != beforeMessages {
		t.Fatal("notice ack inserted a messages row")
	}

	mixed := newFixture(t)
	mixed.seed()
	messageID, seq := mixed.seedMessage("mixed")
	if err := mixed.planMessage(messageID, txAgentE); err != nil || mixed.planBriefing(txAgentE, "handoff") != nil {
		t.Fatal(err)
	}
	both, err := mixed.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil || len(both.Events) != 2 || len(both.Claim.Seqs) != 1 || both.Claim.Seqs[0] != seq || len(both.Claim.MessageIDs) != 1 {
		t.Fatalf("mixed = %+v %v", both, err)
	}
	if containsInt(both.Claim.Seqs, 0) {
		t.Fatal("mixed receipt put seq 0 in seqs")
	}
	var noticeID string
	for _, event := range both.Events {
		if event.SourceKind == SourceBriefing {
			noticeID = event.DeliveryID
			if event.Seq != 0 || event.MessageID != "" {
				t.Fatalf("mixed notice = %+v", event)
			}
		}
	}
	if both.Claim.MessageIDs[0] != noticeID {
		t.Fatalf("mixed message_ids = %v want %s", both.Claim.MessageIDs, noticeID)
	}
	if mixed.count(`SELECT COUNT(*) FROM messages WHERE id = ?`, noticeID) != 0 {
		t.Fatal("mixed notice id is a messages row")
	}

	filtered := newFixture(t)
	filtered.seed()
	lowID, lowSeq := filtered.seedMessage("low")
	highID, highSeq := filtered.seedMessage("high")
	if err := filtered.planMessage(lowID, txAgentE); err != nil || filtered.planMessage(highID, txAgentE) != nil || filtered.planBriefing(txAgentE, "later") != nil {
		t.Fatal(err)
	}
	drained, removed, err := filtered.store.DrainLegacyEventsQuery(t.Context(), claimDeps(), validateOK, LegacyDrainQuery{
		Principal: principalE(), SinceSeq: sinceOf(lowSeq),
		Project: func(_ context.Context, _ Executor, page *ClaimResult) error {
			if len(page.Events) != 1 || page.Events[0].Seq != highSeq || len(page.Claim.MessageIDs) != 0 || len(page.Claim.Seqs) != 1 || page.Claim.Seqs[0] != highSeq {
				t.Fatalf("since page = %+v receipt %+v", page.Events, page.Claim)
			}
			return nil
		},
	})
	if err != nil || removed != 1 || len(drained) != 1 || drained[0].Seq != highSeq {
		t.Fatalf("since drain = %+v removed %d err %v", drained, removed, err)
	}
	if schedulingByMessage(t, filtered.db, lowID) != StatePending {
		t.Fatal("since drain acknowledged or hid the older message")
	}
	var briefingState string
	if err := filtered.db.QueryRow(
		`SELECT scheduling_state FROM agent_deliveries WHERE agent_id = ? AND source_kind = ?`,
		txAgentE, SourceBriefing).Scan(&briefingState); err != nil {
		t.Fatal(err)
	}
	if briefingState != StatePending {
		t.Fatal("since drain acknowledged the seq-0 notice")
	}
	later, err := filtered.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE()})
	if err != nil {
		t.Fatal(err)
	}
	foundLow, foundNotice := false, false
	for _, event := range later.Events {
		if event.Seq == lowSeq {
			foundLow = true
		}
		if event.SourceKind == SourceBriefing && event.Seq == 0 && event.MessageID == "" && !containsInt(later.Claim.Seqs, 0) {
			foundNotice = true
		}
	}
	if !foundLow || !foundNotice {
		t.Fatalf("since hid older input: %+v receipt %+v", later.Events, later.Claim)
	}
}

func (f *fixture) count(query string, args ...any) int {
	f.t.Helper()
	var n int
	if err := f.db.QueryRow(query, args...).Scan(&n); err != nil {
		f.t.Fatal(err)
	}
	return n
}

func containsInt(seq []int64, want int64) bool {
	for _, v := range seq {
		if v == want {
			return true
		}
	}
	return false
}
