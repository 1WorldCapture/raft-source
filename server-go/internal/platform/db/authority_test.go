package db

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func authorityFixture(t *testing.T) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "raft.db")
	handle, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close(); ReleaseAuthorityFence(handle) })
	if err := WithWriteTx(context.Background(), handle, func(tx *sql.Tx) error {
		for _, statement := range []string{
			`INSERT INTO users(id,email,name,email_verified,password_hash,created_at,updated_at) VALUES('owner','owner@example.test','owner',1,'hash',1,1)`,
			`INSERT INTO workspaces(id,name,slug,owner_id,created_at) VALUES('ws','Fixture','fixture','owner',1)`,
			`INSERT INTO workspace_memberships(workspace_id,user_id,role,joined_at) VALUES('ws','owner','owner',1)`,
			`INSERT INTO session_families(id,user_id,created_at) VALUES('family-one','owner',1),('family-two','owner',1)`,
		} {
			if _, err := tx.Exec(statement); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return handle, path
}

func TestM4AuthorityMigrationOnlyInitializesCounterOrigin(t *testing.T) {
	handle, err := Open(filepath.Join(t.TempDir(), "empty.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = handle.Close(); ReleaseAuthorityFence(handle) }()
	var count, value int
	if err := handle.QueryRow(`SELECT COUNT(*),COALESCE(MAX(value),-1) FROM authority_clock WHERE id=1`).Scan(&count, &value); err != nil || count != 1 || value != 0 {
		t.Fatalf("authority origin must be exactly (1,0): count=%d value=%d err=%v", count, value, err)
	}
	for _, table := range []string{"authority_epochs", "messages", "realtime_publications", "activity_scopes", "activity_changes"} {
		if err := handle.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("migration fabricated domain facts in %s: %d %v", table, count, err)
		}
	}
}

func TestM4AuthorityRollbackDoesNotChangeCacheOrNotify(t *testing.T) {
	handle, _ := authorityFixture(t)
	before := AuthorityGeneration(handle, "workspace", "ws")
	if before == 0 {
		t.Fatal("membership trigger did not publish initial workspace generation")
	}
	var notifications atomic.Int64
	unsubscribe := RegisterAuthorityListener(handle, func([]AuthorityChange) { notifications.Add(1) })
	defer unsubscribe()
	rollback := errors.New("rollback")
	err := WithWriteTx(context.Background(), handle, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`UPDATE workspace_memberships SET role='member' WHERE workspace_id='ws' AND user_id='owner'`); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	if got := AuthorityGeneration(handle, "workspace", "ws"); got != before || notifications.Load() != 0 {
		t.Fatalf("rollback escaped into invalidation: %d -> %d, notifications=%d", before, got, notifications.Load())
	}
	var durable uint64
	if err := handle.QueryRow(`SELECT generation FROM authority_epochs WHERE kind='workspace' AND scope_id='ws'`).Scan(&durable); err != nil || durable != before {
		t.Fatalf("rollback changed durable epoch: %d %v", durable, err)
	}
}

func TestM4AuthorityCommitPublishesBeforeAdmissionAndSurvivesReopen(t *testing.T) {
	handle, path := authorityFixture(t)
	ctx := context.Background()
	before := AuthorityGeneration(handle, "workspace", "ws")
	var notified atomic.Int64
	unsubscribe := RegisterAuthorityListener(handle, func(changes []AuthorityChange) {
		// Listener runs after release: taking the admission fence here must
		// succeed, and it must observe the new durable state AND generation.
		bounded, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		if err := WithAuthorityReadContext(bounded, handle, func() error {
			var role string
			if err := handle.QueryRow(`SELECT role FROM workspace_memberships WHERE workspace_id='ws' AND user_id='owner'`).Scan(&role); err != nil {
				return err
			}
			if role != "member" || AuthorityGeneration(handle, "workspace", "ws") <= before {
				return errors.New("new admission observed a committed role with stale generation")
			}
			return nil
		}); err != nil {
			t.Error(err)
		}
		if len(changes) != 1 || changes[0].Scope != (AuthorityScope{Kind: "workspace", ID: "ws"}) {
			t.Errorf("unexpected changed scope: %+v", changes)
		}
		notified.Add(1)
	})
	if err := WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE workspace_memberships SET role='member' WHERE workspace_id='ws' AND user_id='owner'`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	unsubscribe()
	if notified.Load() != 1 {
		t.Fatalf("missing committed invalidation: %d", notified.Load())
	}
	after := AuthorityGeneration(handle, "workspace", "ws")
	if err := handle.Close(); err != nil {
		t.Fatal(err)
	}
	ReleaseAuthorityFence(handle)
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close(); ReleaseAuthorityFence(reopened) }()
	if got := AuthorityGeneration(reopened, "workspace", "ws"); got != after {
		t.Fatalf("reopen lost committed authority: %d != %d", got, after)
	}
}

func TestM4AuthorityFamilyLogoutDoesNotInvalidateIndependentFamily(t *testing.T) {
	handle, _ := authorityFixture(t)
	userBefore := AuthorityGeneration(handle, "user", "owner")
	otherBefore := AuthorityGeneration(handle, "family", "family-two")
	if err := WithWriteTx(context.Background(), handle, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE session_families SET revoked_at=10 WHERE id='family-one'`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if AuthorityGeneration(handle, "family", "family-one") == 0 {
		t.Fatal("logout did not invalidate its family")
	}
	if AuthorityGeneration(handle, "user", "owner") != userBefore || AuthorityGeneration(handle, "family", "family-two") != otherBefore {
		t.Fatal("one-family logout invalidated an independent login")
	}
}

func TestM4AdmissionFenceOrdersOldEligibilityAgainstCommit(t *testing.T) {
	handle, _ := authorityFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	oldGeneration := AuthorityGeneration(handle, "workspace", "ws")
	writerEntered := make(chan struct{})
	commitAllowed := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		writerDone <- WithWriteTx(ctx, handle, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, `UPDATE workspace_memberships SET role='member' WHERE workspace_id='ws' AND user_id='owner'`); err != nil {
				return err
			}
			close(writerEntered)
			<-commitAllowed
			return nil
		})
	}()
	<-writerEntered
	admitted := make(chan bool, 1)
	go func() {
		allowed := false
		err := WithAuthorityReadContext(ctx, handle, func() error {
			allowed = AuthorityGeneration(handle, "workspace", "ws") == oldGeneration
			return nil
		})
		admitted <- err == nil && allowed
	}()
	close(commitAllowed)
	if err := <-writerDone; err != nil {
		t.Fatal(err)
	}
	if <-admitted {
		t.Fatal("old-generation sender admitted after permission commit")
	}
}
