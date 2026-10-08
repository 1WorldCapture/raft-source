package auth

import (
	"context"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
)

// newSessionsFixture opens a real SQLite database and wires the session
// service with a controllable clock.
func newSessionsFixture(t *testing.T) (*SessionService, *Store, *clock.Fixed) {
	t.Helper()
	handle, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handle.Close() })
	store := NewStore(handle)
	signer := NewTokenSigner([]byte("test-secret-0123456789abcdef"), time.Minute)
	receiptKey := deriveTestKey(t)
	clock := &clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	sessions := NewSessionService(handle, store, signer, receiptKey, 24*time.Hour, 10*time.Second, 15*time.Minute)
	sessions.SetClock(clock.Now)
	return sessions, store, clock
}

func deriveTestKey(t *testing.T) []byte {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	return key
}

type sqlDB struct {
	handle interface {
		Exec(string, ...any) (interface{ RowsAffected() (int64, error) }, error)
	}
}

func newTestUser(t *testing.T, store *Store, email string) *User {
	t.Helper()
	hasher := testHasher()
	hash, err := hasher.Hash("password-123")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	user := &User{
		ID: NewUUID(), Email: email, Name: NewPendingHandle(),
		PasswordHash: hash, CreatedAt: now, UpdatedAt: now,
	}
	if err := store.InsertUser(context.Background(), DBExecutor(store.DB()), user); err != nil {
		t.Fatal(err)
	}
	return user
}

func TestCreateAndValidateSession(t *testing.T) {
	sessions, store, _ := newSessionsFixture(t)
	user := newTestUser(t, store, "sess@example.com")
	issued, err := sessions.CreateSession(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if issued.RefreshToken == "" || issued.FamilyID == "" {
		t.Fatal("issued session incomplete")
	}
	live, err := sessions.ValidateSession(context.Background(), issued.RefreshToken)
	if err != nil || live == nil {
		t.Fatalf("validate: %v %v", live, err)
	}
	if live.UserID != user.ID || live.FamilyID != issued.FamilyID {
		t.Error("live session mismatch")
	}
	if bad, err := sessions.ValidateSession(context.Background(), "unknown-test-token"); err != nil || bad != nil {
		t.Error("unknown token validated")
	}
}

func TestRotationIssuesNewTokenAndInvalidatesOld(t *testing.T) {
	sessions, store, _ := newSessionsFixture(t)
	user := newTestUser(t, store, "rotate@example.com")
	issued, _ := sessions.CreateSession(context.Background(), user.ID)

	outcome, err := sessions.Refresh(context.Background(), issued.RefreshToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if outcome == nil || outcome.Session == nil || outcome.Replayed {
		t.Fatalf("rotation failed: %+v", outcome)
	}
	if outcome.Session.RefreshToken == issued.RefreshToken {
		t.Error("successor equals predecessor")
	}
	if outcome.Session.FamilyID != issued.FamilyID {
		t.Error("rotation must stay in the same family")
	}
	if old, _ := sessions.ValidateSession(context.Background(), issued.RefreshToken); old != nil {
		t.Error("old token still valid after rotation")
	}
}

func TestReplayWithinGraceReturnsSameSuccessor(t *testing.T) {
	sessions, store, clock := newSessionsFixture(t)
	user := newTestUser(t, store, "replay@example.com")
	issued, _ := sessions.CreateSession(context.Background(), user.ID)

	first, _ := sessions.Refresh(context.Background(), issued.RefreshToken, nil)
	clock.Advance(3 * time.Second) // inside the 10s grace window
	second, err := sessions.Refresh(context.Background(), issued.RefreshToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if second == nil || second.Session == nil || !second.Replayed {
		t.Fatalf("expected in-grace replay, got %+v", second)
	}
	if second.Session.RefreshToken != first.Session.RefreshToken {
		t.Error("replay must return the SAME successor token")
	}
}

func TestReplayBeyondGraceRevokesFamily(t *testing.T) {
	sessions, store, clock := newSessionsFixture(t)
	user := newTestUser(t, store, "stale@example.com")
	issued, _ := sessions.CreateSession(context.Background(), user.ID)

	first, _ := sessions.Refresh(context.Background(), issued.RefreshToken, nil)
	if first == nil || first.Session == nil {
		t.Fatal("initial rotation failed")
	}
	clock.Advance(30 * time.Second) // beyond grace
	outcome, err := sessions.Refresh(context.Background(), issued.RefreshToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if outcome == nil || outcome.Session != nil {
		t.Fatalf("expected rejection, got %+v", outcome)
	}
	if !outcome.FamilyRevoked {
		t.Error("out-of-grace reuse must revoke the family")
	}
	// The successor the legitimate client held is dead too.
	if live, _ := sessions.ValidateSession(context.Background(), first.Session.RefreshToken); live != nil {
		t.Error("successor survived family revocation")
	}
	revoked, _ := sessions.FamilyRevoked(context.Background(), issued.FamilyID)
	if !revoked {
		t.Error("family not marked revoked")
	}
}

func TestConcurrentRefreshSingleWinner(t *testing.T) {
	sessions, store, _ := newSessionsFixture(t)
	user := newTestUser(t, store, "race@example.com")
	issued, _ := sessions.CreateSession(context.Background(), user.ID)

	const attempts = 8
	successes := 0
	var mu sync.Mutex
	var wg sync.WaitGroup
	distinct := map[string]bool{}
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			outcome, err := sessions.Refresh(context.Background(), issued.RefreshToken, nil)
			if err != nil {
				t.Error(err)
				return
			}
			if outcome != nil && outcome.Session != nil {
				mu.Lock()
				distinct[outcome.Session.RefreshToken] = true
				successes++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if successes != attempts || len(distinct) != 1 {
		t.Fatalf("concurrent refresh must return one successor to every caller: %d successes, %d distinct tokens", successes, len(distinct))
	}
}

func TestLogoutRevokesFamilyIncludingRotatedToken(t *testing.T) {
	sessions, store, _ := newSessionsFixture(t)
	user := newTestUser(t, store, "bye@example.com")
	issued, _ := sessions.CreateSession(context.Background(), user.ID)

	// Logout with the ORIGINAL (already rotated away) token: lineage lookup
	// must still revoke the family.
	rotated, _ := sessions.Refresh(context.Background(), issued.RefreshToken, nil)
	if rotated == nil || rotated.Session == nil {
		t.Fatal("rotation failed")
	}
	revoked, err := sessions.Logout(context.Background(), issued.RefreshToken)
	if err != nil || !revoked {
		t.Fatalf("logout via predecessor failed: %v %v", revoked, err)
	}
	if live, _ := sessions.ValidateSession(context.Background(), rotated.Session.RefreshToken); live != nil {
		t.Error("successor survived logout")
	}
	// Idempotent: logout again is still ok:true.
	if _, err := sessions.Logout(context.Background(), issued.RefreshToken); err != nil {
		t.Errorf("second logout errored: %v", err)
	}
}

func TestDurableReceiptReplayAndBindingMismatch(t *testing.T) {
	sessions, store, clock := newSessionsFixture(t)
	user := newTestUser(t, store, "durable@example.com")
	issued, _ := sessions.CreateSession(context.Background(), user.ID)

	binding := RefreshBinding{AttemptID: "arf_0123456789abcdef", InstallationID: "ari_0123456789abcdef0123456789abcdef"}
	first, err := sessions.Refresh(context.Background(), issued.RefreshToken, &binding)
	if err != nil || first == nil || first.Session == nil {
		t.Fatalf("bound rotation failed: %v %+v", err, first)
	}
	clock.Advance(2 * time.Second)
	same, err := sessions.Refresh(context.Background(), issued.RefreshToken, &binding)
	if err != nil || same == nil || same.Session == nil || !same.Replayed {
		t.Fatalf("bound replay failed: %v %+v", err, same)
	}
	if same.Session.RefreshToken != first.Session.RefreshToken {
		t.Error("bound replay returned a different successor")
	}

	// A different binding replaying the same predecessor is an attack signal:
	// family revoked, request rejected.
	other := RefreshBinding{AttemptID: "arf_fedcba9876543210", InstallationID: "ari_fedcba9876543210fedcba9876543210"}
	outcome, err := sessions.Refresh(context.Background(), issued.RefreshToken, &other)
	if err != nil {
		t.Fatal(err)
	}
	if outcome == nil || outcome.Session != nil || !outcome.FamilyRevoked {
		t.Fatalf("binding mismatch must revoke family, got %+v", outcome)
	}
}

func TestDurableReceiptExpires(t *testing.T) {
	sessions, store, clock := newSessionsFixture(t)
	user := newTestUser(t, store, "expiry@example.com")
	issued, _ := sessions.CreateSession(context.Background(), user.ID)
	binding := RefreshBinding{AttemptID: "arf_0123456789abcdef", InstallationID: "ari_0123456789abcdef0123456789abcdef"}
	if outcome, _ := sessions.Refresh(context.Background(), issued.RefreshToken, &binding); outcome == nil || outcome.Session == nil {
		t.Fatal("bound rotation failed")
	}
	clock.Advance(16 * time.Minute) // beyond the 15m durable TTL
	outcome, err := sessions.Refresh(context.Background(), issued.RefreshToken, &binding)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != nil && outcome.Session != nil {
		t.Fatal("expired receipt issued an authenticated successor")
	}
}

func TestSessionStateSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "restart.db")
	handle, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(handle)
	signer := NewTokenSigner([]byte("test-secret-0123456789abcdef"), time.Minute)
	sessions := NewSessionService(handle, store, signer, deriveTestKey(t), 24*time.Hour, 10*time.Second, 15*time.Minute)
	user := newTestUser(t, store, "restart@example.com")
	issued, err := sessions.CreateSession(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	handle.Close()

	// "Restart": reopen the same database and verify session + family state.
	handle2, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer handle2.Close()
	store2 := NewStore(handle2)
	signer2 := NewTokenSigner([]byte("test-secret-0123456789abcdef"), time.Minute)
	sessions2 := NewSessionService(handle2, store2, signer2, deriveTestKey(t), 24*time.Hour, 10*time.Second, 15*time.Minute)
	live, err := sessions2.ValidateSession(context.Background(), issued.RefreshToken)
	if err != nil || live == nil {
		t.Fatalf("session lost across restart: %v", err)
	}
	revoked, err := sessions2.Logout(context.Background(), issued.RefreshToken)
	if err != nil || !revoked {
		t.Fatalf("logout lost across restart: %v %v", revoked, err)
	}
}

func TestCleanupExpired(t *testing.T) {
	sessions, store, clock := newSessionsFixture(t)
	user := newTestUser(t, store, "janitor@example.com")
	issued, _ := sessions.CreateSession(context.Background(), user.ID)
	if err := sessions.CleanupExpired(context.Background()); err != nil {
		t.Fatal(err)
	}
	clock.Advance(25 * time.Hour)
	if err := sessions.CleanupExpired(context.Background()); err != nil {
		t.Fatal(err)
	}
	if live, _ := sessions.ValidateSession(context.Background(), issued.RefreshToken); live != nil {
		t.Error("expired session survived cleanup")
	}
}
