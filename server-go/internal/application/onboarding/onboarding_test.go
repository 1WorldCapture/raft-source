package onboarding

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/delivery"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/workspace"
)

type briefingFixture struct {
	db         *sql.DB
	service    *Service
	deliveries *delivery.Store
	workspace  string
	owner      string
	agent      string
	channel    string
}

func newBriefingFixture(t *testing.T) *briefingFixture {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "briefing.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close(); platformdb.ReleaseAuthorityFence(handle) })
	f := &briefingFixture{db: handle, deliveries: delivery.NewStore(handle)}
	f.service, err = NewService(workspace.NewStore(handle), channel.NewStore(handle), f.deliveries)
	if err != nil {
		t.Fatal(err)
	}
	f.workspace, f.owner, f.agent, f.channel = seedBriefingWorkspace(t, handle, "0000")
	return f
}

func seedBriefingWorkspace(t *testing.T, handle *sql.DB, suffix string) (ws, owner, agentID, channelID string) {
	t.Helper()
	ws, owner, agentID, channelID = "briefing-ws-"+suffix, "briefing-owner-"+suffix, "briefing-agent-"+suffix, "briefing-channel-"+suffix
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,email,name,display_name,password_hash,email_verified,profile_setup_completed_at,created_at,updated_at) VALUES(?,?,?,?, 'test-only',1,1,1,1)`, []any{owner, owner + "@example.test", "owner" + suffix, "Owner " + suffix}},
		{`INSERT INTO workspaces(id,name,slug,owner_id,created_at,updated_at) VALUES(?,?,?,?,1,1)`, []any{ws, "Briefing " + suffix, "briefing-" + suffix, owner}},
		{`INSERT INTO workspace_memberships(workspace_id,user_id,role,server_push_muted,joined_at) VALUES(?,?,'owner',0,1)`, []any{ws, owner}},
		{`INSERT INTO workspace_member_setup(workspace_id,user_id,status,completion_reason,contract_version,handoff_acknowledged_at) VALUES(?,?,'complete','normal','onboarding-setup-v2',100)`, []any{ws, owner}},
		{`INSERT INTO workspace_member_preferences(workspace_id,user_id) VALUES(?,?)`, []any{ws, owner}},
		{`INSERT INTO agents(id,workspace_id,name,status,runtime,creator_type,creator_id,created_at,updated_at) VALUES(?,?,?,'active','claude','user',?,1,1)`, []any{agentID, ws, "helper" + suffix, owner}},
		{`INSERT INTO agent_members(workspace_id,agent_id,role,joined_at,updated_at) VALUES(?,?,'member',1,1)`, []any{ws, agentID}},
		{`UPDATE workspaces SET onboarding_agent_id=? WHERE id=?`, []any{agentID, ws}},
		{`INSERT INTO channels(id,workspace_id,name,type,system_kind,created_at) VALUES(?,?,'all','channel','all',1)`, []any{channelID, ws}},
	}
	for _, statement := range statements {
		if _, err := handle.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	return
}

func (f *briefingFixture) planned(t *testing.T) *delivery.Delivery {
	t.Helper()
	var d *delivery.Delivery
	err := platformdb.WithReadSnapshot(context.Background(), f.db, func(ex platformdb.Executor) error {
		var err error
		d, err = f.deliveries.FindPlannedSourceTx(context.Background(), ex, f.workspace, f.agent, delivery.SourceBriefing, ownerSourceID(f.owner))
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func (f *briefingFixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var count int
	if err := f.db.QueryRow(query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestOwnerBriefingIntentIsPrivateAtomicAndIdempotent(t *testing.T) {
	f := newBriefingFixture(t)
	for i := 0; i < 3; i++ {
		if err := f.service.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if count := f.count(t, `SELECT COUNT(*) FROM agent_deliveries`); count != 1 {
		t.Fatalf("repeated handoff discovery created %d intents", count)
	}
	if count := f.count(t, `SELECT COUNT(*) FROM messages`); count != 0 {
		t.Fatal("private onboarding briefing leaked into public message history")
	}
	if count := f.count(t, `SELECT COUNT(*) FROM realtime_publications`); count != 0 {
		t.Fatal("private onboarding briefing generated a browser publication")
	}
	d := f.planned(t)
	if d == nil || d.MessageID.Valid || d.SchedulingState != delivery.StatePending || d.AcknowledgedAt.Valid {
		t.Fatalf("a planned briefing must not fabricate a chat message or receipt: %+v", d)
	}
	if count := f.count(t, `SELECT COUNT(*) FROM workspace_member_preferences WHERE onboarding_dm_sent_at IS NOT NULL`); count != 0 {
		t.Fatal("planning falsely marked the briefing delivered")
	}
	var briefing *Briefing
	err := platformdb.WithReadSnapshot(context.Background(), f.db, func(ex platformdb.Executor) error {
		var err error
		briefing, err = f.service.BriefingTx(context.Background(), ex, *d)
		return err
	})
	if err != nil || briefing.NoticeID != d.ID || briefing.ChannelID != f.channel || !strings.Contains(briefing.Content, "Do not quote or publish") {
		t.Fatalf("private notice projection: %+v err=%v", briefing, err)
	}

	// Persist a synthetic receipt FACT in this domain-only test. The machine
	// receipt authentication is tested separately; this proves no sent field
	// is written until a durable acknowledgement actually exists.
	reportedAt := time.Now().UnixMilli()
	if _, err := f.db.Exec(`UPDATE agent_deliveries SET scheduling_state='acknowledged',acknowledged_at=?,lease_expires_at=NULL WHERE id=?`, reportedAt, d.ID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := f.service.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	var stamp int64
	var by string
	if err := f.db.QueryRow(`SELECT onboarding_dm_sent_at,onboarding_dm_sent_by_agent_id FROM workspace_member_preferences WHERE workspace_id=? AND user_id=?`, f.workspace, f.owner).Scan(&stamp, &by); err != nil {
		t.Fatal(err)
	}
	if stamp != reportedAt || by != f.agent {
		t.Fatalf("receipt projection: at=%d by=%s", stamp, by)
	}
	if _, err := f.db.Exec(`UPDATE agent_deliveries SET acknowledged_at=acknowledged_at+1000 WHERE id=?`, d.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	var again int64
	if err := f.db.QueryRow(`SELECT onboarding_dm_sent_at FROM workspace_member_preferences WHERE workspace_id=? AND user_id=?`, f.workspace, f.owner).Scan(&again); err != nil || again != stamp {
		t.Fatalf("first receipt must be stable: %d %v", again, err)
	}
}

func TestOwnerBriefingGatesAndQueuedAuthorityRevalidation(t *testing.T) {
	for _, tc := range []struct{ name, mutation string }{
		{"setup incomplete", `UPDATE workspace_member_setup SET status='not_started',completion_reason=NULL`},
		{"handoff absent", `UPDATE workspace_member_setup SET handoff_acknowledged_at=NULL`},
		{"all hidden", `UPDATE channels SET type='private' WHERE name='all'`},
		{"all archived", `UPDATE channels SET archived_at=1`},
		{"Agent deleted", `UPDATE agents SET deleted_at=1`},
		{"workspace deleted", `UPDATE workspaces SET deleted_at=1`},
		{"owner demoted", `UPDATE workspace_memberships SET role='member'`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newBriefingFixture(t)
			if _, err := f.db.Exec(tc.mutation); err != nil {
				t.Fatal(err)
			}
			if err := f.service.Reconcile(context.Background()); err != nil {
				t.Fatal(err)
			}
			if count := f.count(t, `SELECT COUNT(*) FROM agent_deliveries`); count != 0 {
				t.Fatalf("ineligible owner handoff produced %d intents", count)
			}
		})
	}
	f := newBriefingFixture(t)
	if err := f.service.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	d := f.planned(t)
	if _, err := f.db.Exec(`UPDATE channels SET type='private' WHERE id=?`, f.channel); err != nil {
		t.Fatal(err)
	}
	err := platformdb.WithReadSnapshot(context.Background(), f.db, func(ex platformdb.Executor) error {
		_, err := f.service.BriefingTx(context.Background(), ex, *d)
		return err
	})
	if !errors.Is(err, ErrBriefingUnavailable) {
		t.Fatalf("queued brief must not retain old #all permission: %v", err)
	}
}

func TestOwnerBriefingPlanningFailurePreservesHandoffAndNoSentStamp(t *testing.T) {
	f := newBriefingFixture(t)
	if _, err := f.db.Exec(`CREATE TRIGGER fail_briefing_plan BEFORE INSERT ON agent_deliveries BEGIN SELECT RAISE(ABORT,'test outbox failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := f.service.Reconcile(context.Background()); err == nil {
		t.Fatal("required outbox storage failure was hidden")
	}
	if got := f.count(t, `SELECT COUNT(*) FROM agent_deliveries`); got != 0 {
		t.Fatal("failed briefing plan left an intent")
	}
	if got := f.count(t, `SELECT COUNT(*) FROM workspace_member_setup WHERE handoff_acknowledged_at=100`); got != 1 {
		t.Fatal("delivery failure erased the user's real handoff")
	}
	if got := f.count(t, `SELECT COUNT(*) FROM workspace_member_preferences WHERE onboarding_dm_sent_at IS NOT NULL`); got != 0 {
		t.Fatal("delivery failure falsely claimed a briefing receipt")
	}
}

func TestOwnerBriefingScanDoesNotStarveBehindUnacknowledgedPage(t *testing.T) {
	f := newBriefingFixture(t)
	for i := 1; i < 103; i++ {
		seedBriefingWorkspace(t, f.db, fmt.Sprintf("%04d", i))
	}
	for i := 0; i < 2; i++ {
		if err := f.service.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if count := f.count(t, `SELECT COUNT(*) FROM agent_deliveries`); count != 103 {
		t.Fatalf("old unacknowledged sources starved later workspaces: %d/103 planned", count)
	}
}
