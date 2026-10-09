package delivery

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	platformdb "raft.local/server-go/internal/platform/db"
)

func TestPlanMessageCreatesPendingIntentsPerAgent(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM, txAgentE); err != nil {
		t.Fatal(err)
	}
	for _, agent := range []string{txAgentM, txAgentE} {
		d := f.singleDeliveryForAgent(agent)
		if d.SchedulingState != StatePending {
			t.Fatalf("agent %s: state = %s; want pending", agent, d.SchedulingState)
		}
		if d.SourceKind != SourceMessage || d.SourceID != msgID || d.MessageID.String != msgID {
			t.Fatalf("agent %s: wrong source %s/%s/%s", agent, d.SourceKind, d.SourceID, d.MessageID.String)
		}
		if d.ConversationID.String != txChannel1 {
			t.Fatalf("agent %s: conversation = %s", agent, d.ConversationID.String)
		}
		if d.RetryCount != 0 || d.Revision != 1 {
			t.Fatalf("agent %s: fresh row must have zero retry and revision 1", agent)
		}
	}
	if f.singleDeliveryForAgent(txAgentM).DeliveryOrder == f.singleDeliveryForAgent(txAgentE).DeliveryOrder {
		t.Fatal("delivery_order must be distinct per row")
	}
}

func TestPlanMessageIsIdempotentPerRecipient(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM agent_deliveries WHERE agent_id = ?`, txAgentM).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("(message, recipient) must be unique: got %d rows", count)
	}
}

func TestPlanMessageDedupesAgentList(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM, txAgentM, "  ", txAgentM); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM agent_deliveries WHERE message_id = ?`, msgID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("dedup failed: %d rows", count)
	}
}

func TestPlanMessageRejectsBadFacts(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	// Missing message.
	if err := f.planMessage("missing-msg", txAgentM); !errors.Is(err, ErrMessageUnknown) {
		t.Fatalf("missing message: got %v", err)
	}
	// Cross-workspace agent.
	f.mustExec(`INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES ('99999999-9999-4999-8999-999999999999', ?, 'foreign', 'active', 'claude', 1, 1)`, txWS2)
	if err := f.planMessage(msgID, "99999999-9999-4999-8999-999999999999"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("cross-workspace agent: got %v", err)
	}
	// Deleted agent.
	f.mustExec(`UPDATE agents SET deleted_at = 1 WHERE id = ?`, txAgentE)
	if err := f.planMessage(msgID, txAgentE); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("deleted agent: got %v", err)
	}
	// Empty recipients.
	if err := f.planMessage(msgID); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty recipients: got %v", err)
	}
	// Wrong channel.
	err := platformdb.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		return f.store.PlanMessageTx(context.Background(), tx, PlanInput{
			WorkspaceID: txWS, MessageID: msgID, ChannelID: "elsewhere", AgentIDs: []string{txAgentM},
		})
	})
	if !errors.Is(err, ErrMessageUnknown) {
		t.Fatalf("channel mismatch: got %v", err)
	}
}

// TestPlanMessageRollsBackWithCallerTx proves the atomicity contract: a
// later failure in the caller's transaction leaves no ghost intents.
func TestPlanMessageRollsBackWithCallerTx(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	boom := errors.New("caller failure")
	err := platformdb.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		if err := f.store.PlanMessageTx(context.Background(), tx, PlanInput{
			WorkspaceID: txWS, MessageID: msgID, ChannelID: txChannel1, AgentIDs: []string{txAgentM, txAgentE},
		}); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("expected caller error, got %v", err)
	}
	var count int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM agent_deliveries`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rollback left %d ghost intents", count)
	}
}

func TestPlanBriefingIdempotencyKey(t *testing.T) {
	f := newFixture(t)
	f.seed()
	plan := func() error {
		return platformdb.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
			return f.store.PlanBriefingTx(context.Background(), tx, BriefingPlanInput{
				WorkspaceID: txWS, AgentID: txAgentM, MemberID: txAlice,
				Purpose: "onboarding", Version: "v1", ConversationID: txChannel1,
			})
		})
	}
	if err := plan(); err != nil {
		t.Fatal(err)
	}
	if err := plan(); err != nil { // repeated click / reconnect
		t.Fatal(err)
	}
	var count int
	if err := f.db.QueryRow(
		`SELECT COUNT(*) FROM agent_deliveries WHERE source_kind = 'briefing'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("briefing key must collapse retries: %d rows", count)
	}
	// A new contract version is a NEW intent.
	if err := platformdb.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		return f.store.PlanBriefingTx(context.Background(), tx, BriefingPlanInput{
			WorkspaceID: txWS, AgentID: txAgentM, MemberID: txAlice,
			Purpose: "onboarding", Version: "v2", ConversationID: txChannel1,
		})
	}); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow(
		`SELECT COUNT(*) FROM agent_deliveries WHERE source_kind = 'briefing'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("new version must create a new intent: %d rows", count)
	}
}

// TestSchemaManagedAttemptRequiresFullSnapshot pins the migration CHECK:
// managed_wire attempts cannot exist without the full identity snapshot and
// external_claim attempts cannot carry fabricated machine identity.
func TestSchemaTransportSnapshotsAreConditionallyChecked(t *testing.T) {
	f := newFixture(t)
	f.seed()
	msgID, _ := f.seedMessage("m1")
	if err := f.planMessage(msgID, txAgentM); err != nil {
		t.Fatal(err)
	}
	d := f.singleDeliveryForAgent(txAgentM)
	if _, err := f.db.Exec(`INSERT INTO agent_delivery_attempts
		(occurrence_id, delivery_id, attempt_number, workspace_id, agent_id, message_id,
		 machine_id_snapshot, launch_id_snapshot, session_id_snapshot, transport_kind,
		 lease_expires_at, retry_count, state, terminal_code, revision, created_at, updated_at)
		VALUES ('occ-nosnap', ?, 1, ?, ?, NULL, NULL, NULL, NULL, 'managed_wire', 1, 0, 'in_flight', NULL, 1, 1, 1)`,
		d.ID, txWS, txAgentM); err == nil {
		t.Fatal("managed attempt without identity snapshot must fail the schema CHECK")
	}
	if _, err := f.db.Exec(`INSERT INTO agent_delivery_attempts
		(occurrence_id, delivery_id, attempt_number, workspace_id, agent_id, message_id,
		 machine_id_snapshot, launch_id_snapshot, session_id_snapshot, transport_kind,
		 claim_id, lease_expires_at, retry_count, state, terminal_code, revision, created_at, updated_at)
		VALUES ('occ-fake', ?, 1, ?, ?, NULL, 'machine', NULL, NULL, 'external_claim', NULL, 1, 0, 'in_flight', NULL, 1, 1, 1)`,
		d.ID, txWS, txAgentM); err == nil {
		t.Fatal("external attempt with fabricated machine identity must fail the schema CHECK")
	}
}

// TestSchemaAgentDMMappingRejectsSelfAndDuplicates pins the new B-owned
// table constraints the migration freezes for the messaging worker.
func TestSchemaAgentDMMappingConstraints(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.mustExec(`INSERT INTO channels (id, workspace_id, name, type, created_at)
		VALUES ('55555555-5555-4555-8555-555555555599', ?, 'agent-dm', 'dm', 1)`, txWS)
	f.mustExec(`INSERT INTO agent_direct_messages (workspace_id, user_id, agent_id, channel_id, created_at)
		VALUES (?, ?, ?, ?, 1)`, txWS, txAlice, txAgentM, "55555555-5555-4555-8555-555555555599")
	if _, err := f.db.Exec(`INSERT INTO agent_direct_messages (workspace_id, user_id, agent_id, channel_id, created_at)
		VALUES (?, ?, ?, ?, 1)`, txWS, txAlice, txAgentM, "55555555-5555-4555-8555-555555555598"); err == nil {
		t.Fatal("duplicate (workspace,user,agent) pair must be rejected")
	}
	if _, err := f.db.Exec(`INSERT INTO agent_direct_messages (workspace_id, user_id, agent_id, channel_id, created_at)
		VALUES (?, ?, ?, ?, 1)`, txWS, txAgentM, txAgentM, "55555555-5555-4555-8555-555555555597"); err == nil {
		t.Fatal("user_id == agent_id must be rejected")
	}
}

// TestSchemaCrossWorkspaceAgentIsRejected pins the composite foreign keys:
// an agent UUID from another workspace cannot receive an intent.
func TestSchemaCrossWorkspaceAgentIsRejected(t *testing.T) {
	f := newFixture(t)
	f.seed()
	f.mustExec(`INSERT INTO agents (id, workspace_id, name, status, runtime, created_at, updated_at)
		VALUES ('77777777-7777-4777-8777-777777777772', ?, 'other-ws', 'active', 'claude', 1, 1)`, txWS2)
	if _, err := f.db.Exec(`INSERT INTO agent_deliveries
		(id, delivery_order, workspace_id, agent_id, source_kind, source_id, conversation_id,
		 scheduling_state, retry_count, next_attempt_at, revision, created_at, updated_at)
		VALUES ('dx1', 1, ?, '77777777-7777-4777-8777-777777777772', 'briefing', 'briefing:a:b:c', NULL,
		 'pending', 0, 0, 1, 1, 1)`, txWS); err == nil {
		t.Fatal("cross-workspace agent must fail the composite foreign key")
	}
}

var _ = sql.ErrNoRows
