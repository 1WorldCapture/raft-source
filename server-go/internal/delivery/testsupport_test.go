package delivery

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
)

// Fixed test identities (stable UUIDs keep cross-references readable).
const (
	txAlice    = "11111111-1111-4111-8111-111111111111"
	txWS       = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	txWS2      = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	txMachine1 = "66666666-6666-4666-8666-666666666661"
	txMachine2 = "66666666-6666-4666-8666-666666666662"
	txAgentM   = "88888888-8888-4888-8888-888888888881" // managed-wire agent
	txAgentE   = "88888888-8888-4888-8888-888888888882" // external-runner agent
	txChannel1 = "55555555-5555-4555-8555-555555555551"
)

// fixture is one temp SQLite database with the real migration chain
// (including 0014) and the delivery store over a fixed clock.
type fixture struct {
	t      *testing.T
	db     *sql.DB
	store  *Store
	clock  *clock.Fixed
	seeded bool
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close(); platformdb.ReleaseAuthorityFence(handle) })
	fixed := &clock.Fixed{T: time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)}
	return &fixture{
		t:     t,
		db:    handle,
		store: NewStoreWithOptions(handle, Options{Clock: fixed}),
		clock: fixed,
	}
}

func (f *fixture) seed() {
	f.t.Helper()
	if f.seeded {
		return
	}
	f.seeded = true
	now := f.clock.Now().UnixMilli()
	f.mustExec(`INSERT INTO users (id, email, name, display_name, password_hash, email_verified, created_at, updated_at)
		VALUES (?,?,?,?,?,1,?,?)`, txAlice, "alice@example.test", "alice", "Alice", "x", now, now)
	for _, ws := range []struct{ id, slug string }{{txWS, "alpha"}, {txWS2, "beta"}} {
		f.mustExec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?,?,?,?,?)`,
			ws.id, "WS "+ws.slug, ws.slug, txAlice, now)
	}
	f.mustExec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?,?,'owner',0,?)`, txWS, txAlice, now)
	for _, m := range []struct{ id, name string }{{txMachine1, "mac-one"}, {txMachine2, "mac-two"}} {
		f.mustExec(`INSERT INTO machines (id, workspace_id, user_id, name, created_at) VALUES (?,?,?,?,?)`,
			m.id, txWS, txAlice, m.name, now)
	}
	for _, a := range []struct{ id, machine, runtime string }{
		{txAgentM, txMachine1, "claude"},
		{txAgentE, "", "external"},
	} {
		machine := sql.NullString{String: a.machine, Valid: a.machine != ""}
		f.mustExec(`INSERT INTO agents (id, workspace_id, name, status, runtime, machine_id, created_at, updated_at)
			VALUES (?,?,?,?,?,?,?,?)`, a.id, txWS, "agent-"+a.runtime, "active", a.runtime, machine, now, now)
	}
	f.mustExec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?,?,?,'channel',?)`,
		txChannel1, txWS, "general", now)
}

// seedMessage inserts one committed message row and returns (id, seq).
// Re-seeding the same id is a no-op (helpers may both seed).
func (f *fixture) seedMessage(id string) (string, int64) {
	f.t.Helper()
	var existing int64
	if err := f.db.QueryRow(`SELECT seq FROM messages WHERE id = ?`, id).Scan(&existing); err == nil {
		return id, existing
	}
	res, err := f.db.Exec(`INSERT INTO messages
		(id, workspace_id, channel_id, sender_type, sender_id, content, message_type, random_id, request_digest, thread_id, revision, created_at)
		VALUES (?,?,?, 'user', ?, 'hello agent', 'chat', NULL, ?, NULL, 1, ?)`,
		id, txWS, txChannel1, txAlice, "digest-"+id, f.clock.Now().UnixMilli())
	if err != nil {
		f.t.Fatal(err)
	}
	seq, err := res.LastInsertId()
	if err != nil {
		f.t.Fatal(err)
	}
	return id, seq
}

func (f *fixture) mustExec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Exec(query, args...); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) planBriefing(agentID, purpose string) error {
	f.t.Helper()
	return platformdb.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		return f.store.PlanBriefingTx(context.Background(), tx, BriefingPlanInput{
			WorkspaceID: txWS, AgentID: agentID, MemberID: txAlice,
			Purpose: purpose, Version: "1", ConversationID: txChannel1,
		})
	})
}

func (f *fixture) planMessage(messageID string, agents ...string) error {
	f.t.Helper()
	return platformdb.WithWriteTx(context.Background(), f.db, func(tx *sql.Tx) error {
		return f.store.PlanMessageTx(context.Background(), tx, PlanInput{
			WorkspaceID: txWS, MessageID: messageID, ChannelID: txChannel1, AgentIDs: agents,
		})
	})
}

// factsFor pins static dispatch facts per agent for one test.
func factsFor(facts DispatchFacts) AgentFactsFn {
	return func(context.Context, Executor, string, string) (DispatchFacts, error) { return facts, nil }
}

func factsPerAgent(perAgent map[string]DispatchFacts) AgentFactsFn {
	return func(_ context.Context, _ Executor, _ string, agentID string) (DispatchFacts, error) {
		return perAgent[agentID], nil
	}
}

// allowAll is the always-authorized callback (revocation paths are tested
// explicitly with deny callbacks).
func allowAll(context.Context, Executor, Delivery) (bool, string, error) { return true, "", nil }

func denyWith(reason string) DeliveryAuthorizationFn {
	return func(context.Context, Executor, Delivery) (bool, string, error) { return false, reason, nil }
}

func fullFacts(machine, launch, session string) DispatchFacts {
	return DispatchFacts{SupportsManagedWire: true, Reachable: true, MachineID: machine, LaunchID: launch, SessionID: session}
}

func externalFacts() DispatchFacts {
	return DispatchFacts{SupportsManagedWire: false}
}

func validateOK(context.Context, Executor, AgentPrincipal) error { return nil }

func snapshotOf(a *Attempt) MentionSnapshot {
	return MentionSnapshot{
		OccurrenceID: a.OccurrenceID,
		MessageID:    a.MessageID.String,
		MachineID:    a.MachineSnapshot.String,
		LaunchID:     a.LaunchSnapshot.String,
		SessionID:    a.SessionSnapshot.String,
	}
}

func principalOf(a *Attempt) MachinePrincipal {
	return MachinePrincipal{ComputerID: "computer-1", MachineID: a.MachineSnapshot.String, WorkspaceID: a.WorkspaceID}
}

// deliveryState reads one column helper for assertions.
func (f *fixture) deliveryByID(id string) *Delivery {
	f.t.Helper()
	var d *Delivery
	if err := platformdb.WithReadSnapshot(context.Background(), f.db, func(ex Executor) error {
		row, err := deliveryByIDTx(context.Background(), ex, id)
		d = row
		return err
	}); err != nil || d == nil {
		f.t.Fatalf("delivery %s not found: %v", id, err)
	}
	return d
}

func (f *fixture) singleDeliveryForAgent(agentID string) *Delivery {
	f.t.Helper()
	var id string
	if err := f.db.QueryRow(
		`SELECT id FROM agent_deliveries WHERE agent_id = ? ORDER BY created_at LIMIT 1`, agentID).Scan(&id); err != nil {
		f.t.Fatalf("no delivery for agent %s: %v", agentID, err)
	}
	return f.deliveryByID(id)
}

func (f *fixture) openAttempt(deliveryID string) *Attempt {
	f.t.Helper()
	var a *Attempt
	if err := platformdb.WithReadSnapshot(context.Background(), f.db, func(ex Executor) error {
		row, err := openAttemptForDeliveryTx(context.Background(), ex, deliveryID)
		a = row
		return err
	}); err != nil {
		f.t.Fatal(err)
	}
	return a
}

func (f *fixture) prepare(deps DispatchDeps) []DispatchPlan {
	f.t.Helper()
	plans, err := f.store.PrepareManagedDispatches(context.Background(), deps, PrepareInput{})
	if err != nil {
		f.t.Fatal(err)
	}
	return plans
}

func i64(v sql.NullInt64) int64 {
	if v.Valid {
		return v.Int64
	}
	return 0
}

func str(v sql.NullString) string {
	if v.Valid {
		return v.String
	}
	return ""
}
