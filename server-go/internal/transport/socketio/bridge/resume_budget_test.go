package bridge

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	platformdb "raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/protocol/client"
	"raft.local/server-go/internal/transport/presenter"
)

// The Socket.IO resume byte budget lives at the encoding boundary (it is
// defined over the FULLY ENCODED wire envelope). These tests relocate the
// message worker's frozen budget regressions verbatim: a cut page is always
// a seq PREFIX, paging under a tight budget loses nothing, and an oversize
// single message surfaces the typed error instead of a looping empty page.

type renv struct {
	t        *testing.T
	db       *sql.DB
	channels *channel.Store
	messages *message.Store
}

func newRenv(t *testing.T) *renv {
	t.Helper()
	handle, err := platformdb.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	channels := channel.NewStore(handle)
	return &renv{t: t, db: handle, channels: channels, messages: message.NewStore(handle, channels)}
}

const (
	rWS      = "aaaaaaa3-0000-4000-8000-000000000001"
	rGeneral = "aaaaaaa3-0000-4000-8000-000000000002"
	rAlice   = "aaaaaaa3-0000-4000-8000-000000000003"
)

func (e *renv) exec(query string, args ...any) {
	e.t.Helper()
	if _, err := e.db.Exec(query, args...); err != nil {
		e.t.Fatal(err)
	}
}

func (e *renv) seed() {
	e.t.Helper()
	e.exec(`INSERT INTO users (id, email, name, password_hash, email_verified, profile_setup_completed_at, created_at, updated_at)
		VALUES (?, 'alice@t', 'alice', 'x', 1, 1, 0, 0)`, rAlice)
	e.exec(`INSERT INTO session_families (id, user_id, created_at) VALUES ('fam-a', ?, 0)`, rAlice)
	e.exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?, 'w', 'w', ?, 0)`, rWS, rAlice)
	e.exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', 0)`, rWS, rAlice)
	e.exec(`INSERT INTO channels (id, workspace_id, name, type, created_at) VALUES (?, ?, 'general', 'channel', 0)`, rGeneral, rWS)
	e.exec(`INSERT INTO channel_humans (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', 0)`, rGeneral, rAlice)
}

func (e *renv) rawClaims() auth.AccessTokenClaims {
	now := time.Now()
	return auth.AccessTokenClaims{
		Subject: rAlice, Type: "access", FamilyID: "fam-a",
		IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour),
	}
}

func (e *renv) claims() message.Claims {
	return message.NewClaims(e.rawClaims())
}

// send commits one message through the real creation step (facts +
// publication intents, the seeding path the acceptance fixture uses).
func (e *renv) send(content string) *message.CreateResult {
	e.t.Helper()
	var result *message.CreateResult
	raw := e.rawClaims()
	err := platformdb.WithWriteTx(context.Background(), e.db, func(tx *sql.Tx) error {
		created, err := e.messages.CreateMessageTx(context.Background(), tx, raw, rWS, message.CreateInput{
			ChannelID: rGeneral, Content: content,
		})
		if err != nil {
			return err
		}
		if err := e.messages.RecordSendPublicationsTx(context.Background(), tx, rWS, created); err != nil {
			return err
		}
		result = created
		return nil
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return result
}

// page renders one budgeted resume page from the real facts scan.
func (e *renv) page(t *testing.T, since int64, maxMessages int, budget int64) *client.ResumeEnvelope {
	t.Helper()
	result, err := e.messages.SyncVisibleMessages(context.Background(), e.claims(), rWS, since, "", maxMessages)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := presenter.RenderResumePage(result.Projections, result.CoveredThrough, result.HasMore, budget)
	if err != nil {
		t.Fatal(err)
	}
	return envelope
}

func TestResumePageByteBoundNeverSkipsVisibleMessages(t *testing.T) {
	e := newRenv(t)
	e.seed()

	long := strings.Repeat("聊", 32_000) // 32000 UTF-16 units ≈ 96KB UTF-8
	var ids []string
	var seqs []int64
	for i := 0; i < 6; i++ {
		msg := e.send(long)
		ids = append(ids, msg.Message.ID)
		seqs = append(seqs, msg.Message.Seq)
	}

	page := e.page(t, 0, 500, 380*1024)
	if len(page.Messages) >= len(ids) {
		t.Fatalf("byte bound should have cut the page: %d", len(page.Messages))
	}
	if !page.HasMore {
		t.Fatal("a cut page must report hasMore")
	}
	// The kept set is exactly the seq PREFIX.
	for i, m := range page.Messages {
		if m.ID != ids[i] {
			t.Fatalf("kept set must be a prefix: position %d", i)
		}
	}
	if page.CurrentSeq != seqs[len(page.Messages)-1] {
		t.Fatalf("currentSeq must be the last included seq: %d want %d", page.CurrentSeq, seqs[len(page.Messages)-1])
	}
	// Paging through with the returned cursor reaches every message exactly once.
	seen := map[string]bool{}
	cursor := int64(0)
	for {
		page := e.page(t, cursor, 500, 380*1024)
		for _, m := range page.Messages {
			if seen[m.ID] {
				t.Fatalf("message %s served twice", m.ID)
			}
			seen[m.ID] = true
		}
		if page.CurrentSeq <= cursor && len(page.Messages) > 0 {
			t.Fatalf("cursor must advance: %d -> %d", cursor, page.CurrentSeq)
		}
		cursor = page.CurrentSeq
		if !page.HasMore {
			break
		}
	}
	if len(seen) != len(ids) {
		t.Fatalf("byte-bounded resume lost messages: %d of %d", len(seen), len(ids))
	}
}

// TestResumeByteBudgetIncludesEnvelopeAndNeverAdmitsOversize pins the
// envelope-inclusive accounting: a single legal 32000-CJK message fits the
// default 1 MiB budget whole; a budget shrunken below one message surfaces
// the typed error (gateway retry/close) instead of silently admitting the
// row or returning an empty page that loops forever.
func TestResumeByteBudgetIncludesEnvelopeAndNeverAdmitsOversize(t *testing.T) {
	e := newRenv(t)
	e.seed()
	msg := e.send(strings.Repeat("聊", 32_000))

	// Default budget: the oversize-but-legal row fits whole.
	page := e.page(t, 0, 500, 0)
	if len(page.Messages) != 1 || page.Messages[0].ID != msg.Message.ID {
		t.Fatalf("single legal message must fit the default budget: %+v", page)
	}
	if page.HasMore {
		t.Fatal("nothing left after the only visible row")
	}

	// A budget below one encoded message surfaces the typed error.
	result, err := e.messages.SyncVisibleMessages(context.Background(), e.claims(), rWS, 0, "", 500)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := presenter.RenderResumePage(result.Projections, result.CoveredThrough, result.HasMore, 1024); !errors.Is(err, presenter.ErrResumeMessageExceedsBudget) {
		t.Fatalf("oversize budget error = %v, want ErrResumeMessageExceedsBudget", err)
	}
}

// A tight budget that still fits one message pages through everything
// without duplicates and every envelope honors the bound.
func TestResumeTightBudgetPagesEverything(t *testing.T) {
	e := newRenv(t)
	e.seed()
	for _, content := range []string{"first body", "second body"} {
		e.send(content)
	}
	budget := int64(2048)
	seen := map[string]bool{}
	pages := 0
	cursor := int64(0)
	for {
		page := e.page(t, cursor, 500, budget)
		raw, err := json.Marshal(page)
		if err != nil {
			t.Fatal(err)
		}
		if int64(len(raw)) > budget {
			t.Fatalf("page %d envelope %d exceeds budget %d", pages, len(raw), budget)
		}
		for _, m := range page.Messages {
			if seen[m.ID] {
				t.Fatalf("duplicate: %s", m.ID)
			}
			seen[m.ID] = true
		}
		pages++
		if !page.HasMore {
			break
		}
		if page.CurrentSeq <= cursor {
			t.Fatalf("cursor stalled at %d", cursor)
		}
		cursor = page.CurrentSeq
	}
	if len(seen) != 2 {
		t.Fatalf("tight-budget paging lost messages: %d", len(seen))
	}
}
