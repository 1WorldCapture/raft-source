package acceptance

// Executable query-budget coverage for the channelview batch projection
// (approved design section 6.1: pagination and query work must stay bounded;
// batch fact readers must not degenerate into unbounded per-channel reads).
//
// The projection is driven on a COUNTING caller-pinned executor so the exact
// number of statements issued against the caller's snapshot is asserted.
// The baseline-derived budget of the current implementation is:
//
//   3 fixed batch readers  (viewer read states / mute states / display prefs)
// + 1 if last-message facts are attached (list exit only)
// + 2 per channel that HAS a read row (its typed frontier: scope row + the
//   same-source latest-activity pair)
//
// The per-channel frontier cost is baseline-preexisting linear work (the
// frozen 6ffc168 projector issued the same per-channel frontier query); it
// is pinned here so any NEW per-channel or unbatched statement introduced
// by future changes fails this test instead of silently regressing. Exact
// counts detect replacing caller-bound reads with hidden reads; a ONE-slot
// connection pool additionally prevents taking a second connection while the
// caller's snapshot is held. Counts alone would not detect extra hidden reads.
//
// This is a work budget, not a benchmark. The context deadline below is only
// a deadlock escape for the one-connection snapshot contract.

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"raft.local/server-go/internal/application/channelview"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/readstate"
	"raft.local/server-go/tests/testkit"
)

// stabCountingExec counts every statement issued through the caller-pinned
// executor handed to the projection.
type stabCountingExec struct {
	inner      platformdb.Executor
	queries    int
	executions int
}

func (c *stabCountingExec) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	c.executions++
	return c.inner.ExecContext(ctx, query, args...)
}

func (c *stabCountingExec) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	c.queries++
	return c.inner.QueryContext(ctx, query, args...)
}

func (c *stabCountingExec) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	c.queries++
	return c.inner.QueryRowContext(ctx, query, args...)
}

const (
	stabBudgetWorkspace = "ws-budget"
	stabBudgetViewer    = "u-budget"
	stabBudgetTotal     = 40 // channels in the "many" case
	stabBudgetWithRead  = 17 // of them carry a viewer read row
)

// stabBudgetService builds a channelview.Service over the whole-app temp
// database (migrated schema, FKs enforced) with a seeded viewer scope.
func stabBudgetService(t *testing.T) (*testkit.TestEnv, *channelview.Service) {
	t.Helper()
	env := testkit.NewTestEnv(t)
	db := env.App.DB
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES (?, 'budget@a.test', 'budget', 'x', 1, 1, 1)`, stabBudgetViewer); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?,?,?, ?,1)`,
		stabBudgetWorkspace, "Budget", "budget", stabBudgetViewer); err != nil {
		t.Fatal(err)
	}
	channels := channel.NewStore(db)
	states := readstate.NewStore(db, channels)
	messages := message.NewStore(db, channels)
	svc, err := channelview.NewService(channels, states, messages)
	if err != nil {
		t.Fatalf("channelview service: %v", err)
	}
	return env, svc
}

// stabBudgetSeed inserts the channel rows and the viewer's read/mute/
// display/message facts for the "many" case. It returns the channel
// literals to project, mirroring the seeded rows.
func stabBudgetSeed(t *testing.T, db *sql.DB, total, withRead int) []channel.Channel {
	t.Helper()
	announcement := "announcement"
	out := make([]channel.Channel, 0, total)
	for i := 0; i < total; i++ {
		id := fmt.Sprintf("bc-%02d", i)
		sysKind := any(nil)
		if i == total-1 {
			sysKind = &announcement
		}
		if _, err := db.Exec(`INSERT INTO channels (id, workspace_id, name, type, system_kind, created_at)
			VALUES (?,?,?, 'channel', ?, 1)`, id, stabBudgetWorkspace, id, sysKind); err != nil {
			t.Fatalf("seed channel %s: %v", id, err)
		}
		c := channel.Channel{ID: id, WorkspaceID: stabBudgetWorkspace, Type: channel.TypeChannel}
		if i == total-1 {
			c.SystemKind = &announcement
		}
		out = append(out, c)

		if i < withRead {
			if _, err := db.Exec(`INSERT INTO user_channel_read_states
				(workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at)
				VALUES (?,?,?,?,?,1)`, stabBudgetWorkspace, stabBudgetViewer, id, int64(i+1), int64(i+1)); err != nil {
				t.Fatalf("seed read row %s: %v", id, err)
			}
		}
	}
	// A mute row, a display row and real messages exist for in-scope
	// channels: these must ride the FIXED batch readers, never add statements.
	if _, err := db.Exec(`INSERT INTO user_channel_mute_states
		(workspace_id, user_id, channel_id, activity_muted, mute_from_seq, prefs_version, created_at, updated_at)
		VALUES (?,?,?,1,5,2,1,1)`, stabBudgetWorkspace, stabBudgetViewer, out[0].ID); err != nil {
		t.Fatalf("seed mute row: %v", err)
	}
	displayIdx := 1
	if displayIdx >= total {
		displayIdx = total - 1
	}
	if _, err := db.Exec(`INSERT INTO user_channel_display_prefs
		(workspace_id, user_id, channel_id, collapse_long_messages, prefs_version, created_at, updated_at)
		VALUES (?,?,?,1,3,1,1)`, stabBudgetWorkspace, stabBudgetViewer, out[displayIdx].ID); err != nil {
		t.Fatalf("seed display row: %v", err)
	}
	msgIdx := []int{0}
	if total > 1 {
		msgIdx = append(msgIdx, 1)
	}
	for _, i := range msgIdx {
		if _, err := db.Exec(`INSERT INTO messages
			(id, workspace_id, channel_id, sender_type, sender_id, content, message_type, request_digest, revision, created_at)
			VALUES (?,?,?, 'user', ?, 'budget seed', 'chat', 'd', 1, 1)`,
			fmt.Sprintf("bm-%02d", i), stabBudgetWorkspace, out[i].ID, stabBudgetViewer); err != nil {
			t.Fatalf("seed message: %v", err)
		}
	}
	// Foreign-scope facts (another viewer) for channels that are unread for
	// our viewer: they must not leak work into this projection.
	if _, err := db.Exec(`INSERT OR IGNORE INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
		VALUES ('u-other', 'other@a.test', 'other', 'x', 1, 1, 1)`); err != nil {
		t.Fatal(err)
	}
	for i := withRead; i < min(withRead+5, total); i++ {
		if _, err := db.Exec(`INSERT INTO user_channel_read_states
			(workspace_id, user_id, channel_id, last_read_seq, read_state_version, updated_at)
			VALUES (?, 'u-other', ?, 9, 9, 1)`, stabBudgetWorkspace, out[i].ID); err != nil {
			t.Fatalf("seed foreign read row: %v", err)
		}
	}
	return out
}

// stabBudgetProject runs the projection on a counting pinned executor.
func stabBudgetProject(t *testing.T, svc *channelview.Service, db *sql.DB, channels []channel.Channel, includeLastMessage bool) (int, int) {
	t.Helper()
	var queries, executions int
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	err := platformdb.WithReadSnapshot(ctx, db, func(ex platformdb.Executor) error {
		counter := &stabCountingExec{inner: ex}
		if _, err := svc.Project(ctx, counter, stabBudgetWorkspace, stabBudgetViewer, channels, includeLastMessage); err != nil {
			return err
		}
		queries, executions = counter.queries, counter.executions
		return nil
	})
	if err != nil {
		t.Fatalf("project: %v", err)
	}
	return queries, executions
}

func stabBudgetWant(t *testing.T, label string, got, want int) {
	t.Helper()
	if got != want {
		t.Errorf("%s: %d statements on the caller's executor, want %d (baseline budget: 3 batch readers + 1 optional last-message + 2 per channel WITH a read row; per-channel frontier is baseline-preexisting linear work — anything beyond it is an unbatched or per-channel regression)",
			label, got, want)
	}
}

func TestStabilizationChannelProjectionQueryBudget(t *testing.T) {
	// Every subtest owns its own app/temp database: the seeded channel ids
	// are per-fixture and must never collide across cases.
	freshCase := func(t *testing.T) (*sql.DB, *channelview.Service) {
		env, svc := stabBudgetService(t)
		return env.App.DB, svc
	}

	t.Run("empty batch does no work", func(t *testing.T) {
		db, svc := freshCase(t)
		queries, executions := stabBudgetProject(t, svc, db, nil, true)
		stabBudgetWant(t, "0 channels", queries, 0)
		stabBudgetWant(t, "0 channels execs", executions, 0)
	})

	t.Run("single unread channel is exactly the three batch readers", func(t *testing.T) {
		db, svc := freshCase(t)
		ch := stabBudgetSeed(t, db, 1, 0)
		queries, executions := stabBudgetProject(t, svc, db, ch, false)
		stabBudgetWant(t, "1 unread channel", queries, 3)
		stabBudgetWant(t, "1 unread channel execs", executions, 0)
	})

	t.Run("single read channel adds only its typed frontier", func(t *testing.T) {
		db, svc := freshCase(t)
		ch := stabBudgetSeed(t, db, 1, 1)
		queries, _ := stabBudgetProject(t, svc, db, ch, false)
		stabBudgetWant(t, "1 read channel", queries, 3+2)
	})

	t.Run("many channels stay batch-bounded", func(t *testing.T) {
		db, svc := freshCase(t)
		many := stabBudgetSeed(t, db, stabBudgetTotal, stabBudgetWithRead)
		want := 3 + 2*stabBudgetWithRead
		queries, executions := stabBudgetProject(t, svc, db, many, false)
		stabBudgetWant(t, fmt.Sprintf("%d channels, %d with read rows", stabBudgetTotal, stabBudgetWithRead), queries, want)
		stabBudgetWant(t, "many channels execs", executions, 0)

		queriesWithLast, _ := stabBudgetProject(t, svc, db, many, true)
		stabBudgetWant(t, "many channels with last-message facts", queriesWithLast, want+1)
	})

	t.Run("adding unread channels adds zero statements", func(t *testing.T) {
		db, svc := freshCase(t)
		base := stabBudgetSeed(t, db, stabBudgetTotal, stabBudgetWithRead)
		baseQueries, _ := stabBudgetProject(t, svc, db, base, true)

		// Reset the fixture scope (cascades clear the viewer facts), then
		// reseed with 23 MORE unread channels and the SAME read-row count.
		if _, err := db.Exec(`DELETE FROM channels WHERE workspace_id = ?`, stabBudgetWorkspace); err != nil {
			t.Fatalf("reset fixture: %v", err)
		}
		grown := stabBudgetSeed(t, db, stabBudgetTotal+23, stabBudgetWithRead)
		grownQueries, _ := stabBudgetProject(t, svc, db, grown, true)

		if grownQueries != baseQueries {
			t.Errorf("adding 23 unread channels changed the projection from %d to %d statements: unread channels must ride the fixed batch readers, not per-channel work (design 6.1 forbids degenerating the batch into unbounded per-channel reads)", baseQueries, grownQueries)
		}
	})
}
