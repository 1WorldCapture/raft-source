package workspace_test

// Concurrency evidence for the invitation accept path. SQLite serializes
// writers, but correctness here is a transaction-property claim: the guarded
// use-count UPDATE and the membership insert share one transaction, so
// concurrent last-use racing cannot over-admit and concurrent same-user
// accepts cannot double-consume. These tests run real goroutines against the
// real store — sequential tests cannot prove either property.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"raft.local/server-go/internal/workspace"
)

// inviteConcEnv is a migrated DB, a workspace store and one workspace.
type inviteConcEnv struct {
	db          *sql.DB
	store       *workspace.Store
	workspaceID string
}

func newInviteConcEnv(t *testing.T) *inviteConcEnv {
	t.Helper()
	handle := newWorkspaceDB(t)
	store, _ := newTestStore(handle, workspace.Policy{})
	owner := fmt.Sprintf("conc-owner-%d", time.Now().UnixNano())
	seedUser(t, handle, owner)
	record, err := store.CreateWorkspace(context.Background(), owner, "Conc", fmt.Sprintf("conc-ws-%d", time.Now().UnixNano()))
	if err != nil {
		t.Fatal(err)
	}
	return &inviteConcEnv{db: handle, store: store, workspaceID: record.ID}
}

// digestOf mirrors the store's token digest for row assertions.
func digestOf(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (e *inviteConcEnv) joinLink(t *testing.T, opts workspace.JoinLinkOptions) string {
	t.Helper()
	token, _, err := e.store.CreateJoinLink(context.Background(), e.workspaceID, e.ownerID(t), opts)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func (e *inviteConcEnv) ownerID(t *testing.T) string {
	t.Helper()
	var id string
	if err := e.db.QueryRow(`SELECT owner_id FROM workspaces WHERE id = ?`, e.workspaceID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func (e *inviteConcEnv) useCount(t *testing.T, linkToken string) int64 {
	t.Helper()
	var n int64
	if err := e.db.QueryRow(`SELECT use_count FROM workspace_join_links WHERE token_digest = ?`, digestOf(linkToken)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func (e *inviteConcEnv) membershipCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ?`, e.workspaceID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// TestAcceptJoinLinkConcurrentLastUse: a maxUses=2 link raced by four
// distinct users admits exactly two. Every loser must receive the exact
// usage-limit sentence, never a success, and the persisted counter must read
// exactly 2.
func TestAcceptJoinLinkConcurrentLastUse(t *testing.T) {
	env := newInviteConcEnv(t)
	const contenders = 4
	maxUses := int64(2)
	token := env.joinLink(t, workspace.JoinLinkOptions{MaxUses: &maxUses})
	users := make([]string, contenders)
	for i := range users {
		users[i] = fmt.Sprintf("conc-user-%d-%d", i, time.Now().UnixNano())
		seedUser(t, env.db, users[i])
	}

	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make([]error, contenders)
	for i, user := range users {
		wg.Add(1)
		go func(i int, user string) {
			defer wg.Done()
			<-start
			_, err := env.store.AcceptInvite(context.Background(), token, user)
			results[i] = err
		}(i, user)
	}
	close(start)
	wg.Wait()

	succeeded, refused := 0, 0
	for _, err := range results {
		switch {
		case err == nil:
			succeeded++
		case workspace.AsDomainError(err) != nil && workspace.AsDomainError(err).Message == "This invite has already reached its usage limit":
			refused++
		default:
			t.Fatalf("unexpected accept outcome: %v", err)
		}
	}
	if succeeded != 2 || refused != contenders-2 {
		t.Fatalf("outcomes = %d success / %d refused, want exactly %d/%d", succeeded, refused, 2, contenders-2)
	}
	if n := env.membershipCount(t); n != 3 { // owner + exactly two joiners
		t.Fatalf("memberships = %d, want 3 (no over-admission)", n)
	}
	if got := env.useCount(t, token); got != maxUses {
		t.Fatalf("use_count = %d, want exactly %d", got, maxUses)
	}
}

// TestAcceptJoinLinkConcurrentSameUser: one user racing the same link many
// times concurrently ends with exactly one membership, one consumed use and
// every accept reporting success (conditional idempotency).
func TestAcceptJoinLinkConcurrentSameUser(t *testing.T) {
	env := newInviteConcEnv(t)
	token := env.joinLink(t, workspace.JoinLinkOptions{})
	user := fmt.Sprintf("conc-same-%d", time.Now().UnixNano())
	seedUser(t, env.db, user)

	const attempts = 8
	var wg sync.WaitGroup
	start := make(chan struct{})
	var failures atomic.Int32
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, err := env.store.AcceptInvite(context.Background(), token, user); err != nil {
				failures.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if n := failures.Load(); n != 0 {
		t.Fatalf("%d concurrent same-user accepts failed", n)
	}
	if n := env.membershipCount(t); n != 2 { // owner + the one user
		t.Fatalf("memberships = %d, want 2", n)
	}
	if got := env.useCount(t, token); got != 1 {
		t.Fatalf("use_count = %d, want exactly 1 (no double consumption)", got)
	}
}

// TestAcceptEmailInviteConcurrentSingleUse: an email invite raced by the
// SAME bound user concurrently joins exactly once; every other attempt
// reports the exact already-used sentence (strict single-use, unlike join
// links' conditional idempotency).
func TestAcceptEmailInviteConcurrentSingleUse(t *testing.T) {
	env := newInviteConcEnv(t)
	owner := env.ownerID(t)
	user := fmt.Sprintf("conc-mail-%d", time.Now().UnixNano())
	seedUser(t, env.db, user)
	email := user + "@example.test"
	// The account email must match the invited address for the binding.
	if _, err := env.db.Exec(`UPDATE users SET email = ? WHERE id = ?`, email, user); err != nil {
		t.Fatal(err)
	}
	created, err := env.store.CreateEmailInvite(context.Background(), env.workspaceID, owner, email, "member")
	if err != nil {
		t.Fatal(err)
	}

	const attempts = 6
	var wg sync.WaitGroup
	start := make(chan struct{})
	var succeeded, alreadyUsed atomic.Int32
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := env.store.AcceptInvite(context.Background(), created.Token, user)
			switch {
			case err == nil:
				succeeded.Add(1)
			case workspace.AsDomainError(err) != nil && workspace.AsDomainError(err).Message == "This invite has already been used":
				alreadyUsed.Add(1)
			default:
				t.Errorf("unexpected concurrent email-accept outcome: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()
	if succeeded.Load() != 1 {
		t.Fatalf("concurrent email accepts succeeded %d times, want exactly 1", succeeded.Load())
	}
	if alreadyUsed.Load() != attempts-1 {
		t.Fatalf("already-used outcomes = %d, want %d", alreadyUsed.Load(), attempts-1)
	}
	if n := env.membershipCount(t); n != 2 {
		t.Fatalf("memberships = %d, want 2", n)
	}
}
