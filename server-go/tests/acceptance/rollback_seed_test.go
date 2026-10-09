package acceptance

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	platformdb "raft.local/server-go/internal/platform/db"
)

// TestSeedRollbackData is rollback-verification tooling: it writes an M4-shaped dataset (accounts, session
// family, workspace, channel, thread follow, messages, read/mute/display
// state, reaction, durable publication) with the CURRENT code's migration
// chain into the dir named by RAFT_GO_DATA_DIR, for the baseline-binary
// rollback check.
func TestSeedRollbackData(t *testing.T) {
	dir := os.Getenv("RAFT_ROLLBACK_DIR")
	if dir == "" {
		t.Skip("RAFT_ROLLBACK_DIR not set")
	}
	handle, err := platformdb.Open(filepath.Join(dir, "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	now := time.Now().UnixMilli()
	stmts := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, email, name, password_hash, email_verified, profile_setup_completed_at, created_at, updated_at) VALUES ('u1','rb@a.test','rb','x',1,1,?,?)`, []any{now, now}},
		{`INSERT INTO session_families (id, user_id, created_at) VALUES ('f1','u1',?)`, []any{now}},
		{`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES ('w1','RB','rb','u1',?)`, []any{now}},
		{`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at) VALUES ('w1','u1','owner',?)`, []any{now}},
		{`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES ('c1','w1','general','channel',?)`, []any{now}},
		{`INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES ('c1','u1','member',?)`, []any{now}},
		{`INSERT INTO messages (id, workspace_id, channel_id, sender_type, sender_id, content, message_type, request_digest, revision, created_at) VALUES ('m1','w1','c1','user','u1','rollback hello','chat','d',1,?)`, []any{now}},
		{`INSERT INTO thread_follows (workspace_id, thread_channel_id, user_id, parent_message_id, followed_at) VALUES ('w1','c1','u1','m1',?)`, []any{now}},
		{`INSERT INTO user_channel_read_states (workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at) VALUES ('w1','u1','c1',1,1,?)`, []any{now}},
		{`INSERT INTO user_channel_mute_states (workspace_id, user_id, channel_id, activity_muted, mute_from_seq, prefs_version, created_at, updated_at) VALUES ('w1','u1','c1',0,NULL,0,?,?)`, []any{now, now}},
		{`INSERT INTO user_channel_display_prefs (workspace_id, user_id, channel_id, collapse_long_messages, prefs_version, created_at, updated_at) VALUES ('w1','u1','c1',1,0,?,?)`, []any{now, now}},
		{`INSERT INTO realtime_publications (workspace_id, object_type, object_id, event_type, revision, subject_user_id, scope_id, created_at, next_attempt_at, attempts) VALUES ('w1','message','m1','message:new',1,'','c1',?,0,0)`, []any{now}},
	}
	for _, stmt := range stmts {
		if _, err := handle.Exec(stmt.sql, stmt.args...); err != nil {
			t.Fatalf("seed %q: %v", stmt.sql[:40], err)
		}
	}
	var migrations int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&migrations); err != nil {
		t.Fatal(err)
	}
	t.Logf("seeded M4 dataset over %d migrations", migrations)
}
