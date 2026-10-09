package delivery

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"

	platformdb "raft.local/server-go/internal/platform/db"
)

func TestManagedScanPassesLargeExternalBacklogWithoutChangingPullEligibility(t *testing.T) {
	f := newFixture(t)
	f.seed()
	const externalRows = scanMaxTotal*4 + 1
	// One transaction prepares a backlog larger than the bounded managed
	// scan. Briefings are real durable intents, not fake public message rows.
	if err := platformdb.WithWriteTx(t.Context(), f.db, func(tx *sql.Tx) error {
		for i := 0; i < externalRows; i++ {
			if err := f.store.PlanBriefingTx(t.Context(), tx, BriefingPlanInput{
				WorkspaceID: txWS, AgentID: txAgentE, MemberID: txAlice,
				Purpose: fmt.Sprintf("scan-fairness-%04d", i), Version: "1", ConversationID: txChannel1,
			}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	managedMessage, _ := f.seedMessage("managed-behind-external-page")
	if err := f.planMessage(managedMessage, txAgentM); err != nil {
		t.Fatal(err)
	}
	if first := f.prepare(claimDeps()); len(first) != 0 {
		t.Fatalf("first bounded page contains only external recipients: %d managed plans", len(first))
	}
	if f.store.managedScanAfter == 0 {
		t.Fatal("a full external page must advance the independent scan cursor")
	}
	second := f.prepare(claimDeps())
	if len(second) != 1 || second[0].Delivery.MessageID.String != managedMessage {
		t.Fatalf("a later managed Agent starved behind the same external prefix: %+v", second)
	}
	var changed int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM agent_deliveries WHERE agent_id = ? AND
		(scheduling_state <> 'pending' OR retry_count <> 0 OR revision <> 1 OR next_attempt_at > ?)`, txAgentE, f.clock.Now().UnixMilli()).Scan(&changed); err != nil {
		t.Fatal(err)
	}
	if changed != 0 {
		t.Fatalf("managed scans changed %d external deliveries", changed)
	}
	claim, err := f.store.ClaimAgentEvents(t.Context(), claimDeps(), validateOK, ClaimInput{Principal: principalE(), Limit: 1})
	if err != nil || len(claim.Events) != 1 || len(claim.Claim.MessageIDs) != 1 || len(claim.Claim.Seqs) != 0 {
		t.Fatalf("external notice is not immediately pullable with the original receipt: claim=%+v error=%v", claim, err)
	}
}

func TestManagedScanCursorDoesNotAdvanceOnRolledBackRound(t *testing.T) {
	f := newFixture(t)
	f.seed()
	messageID, _ := f.seedMessage("failed-managed-round")
	if err := f.planMessage(messageID, txAgentM); err != nil {
		t.Fatal(err)
	}
	injected := errors.New("injected fact-read failure")
	deps := claimDeps()
	deps.Facts = func(context.Context, Executor, string, string) (DispatchFacts, error) {
		return DispatchFacts{}, injected
	}
	if _, err := f.store.PrepareManagedDispatches(t.Context(), deps, PrepareInput{}); !errors.Is(err, injected) {
		t.Fatalf("failed scan returned %v", err)
	}
	if f.store.managedScanAfter != 0 {
		t.Fatal("rolled-back scan published its scheduling cursor")
	}
	plans := f.prepare(claimDeps())
	if len(plans) != 1 || plans[0].Delivery.MessageID.String != messageID {
		t.Fatalf("rollback hid a due managed delivery: %+v", plans)
	}
}
