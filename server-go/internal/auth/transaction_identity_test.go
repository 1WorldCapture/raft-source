package auth

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	platformdb "raft.local/server-go/internal/platform/db"
)

func TestM4HumanTransactionIdentityIsOwnedLiveAndPurposeBound(t *testing.T) {
	sessions, store, clock := newSessionsFixture(t)
	user := newTestUser(t, store, "m4-human@example.com")
	other := newTestUser(t, store, "m4-other@example.com")
	if _, err := store.DB().Exec(`UPDATE users SET email_verified=1,name='m4human' WHERE id=?`, user.ID); err != nil {
		t.Fatal(err)
	}
	issued, err := sessions.CreateSession(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	valid := AccessTokenClaims{Subject: user.ID, FamilyID: issued.FamilyID, Type: "access", IssuedAt: clock.Now(), ExpiresAt: clock.Now().Add(time.Minute)}
	check := func(claims AccessTokenClaims) error {
		return platformdb.WithWriteTx(context.Background(), store.DB(), func(tx *sql.Tx) error {
			return ValidateHumanTx(context.Background(), tx, claims, clock.Now())
		})
	}
	if err := check(valid); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		edit func(*AccessTokenClaims)
	}{
		{"subject belongs to another family", func(c *AccessTokenClaims) { c.Subject = other.ID }},
		{"missing family", func(c *AccessTokenClaims) { c.FamilyID = "" }},
		{"unknown family", func(c *AccessTokenClaims) { c.FamilyID = "absent" }},
		{"wrong purpose", func(c *AccessTokenClaims) { c.Type = "refresh" }},
		{"expiry boundary", func(c *AccessTokenClaims) { c.ExpiresAt = clock.Now() }},
		{"future issued", func(c *AccessTokenClaims) { c.IssuedAt = clock.Now().Add(time.Second) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claims := valid
			tc.edit(&claims)
			if err := check(claims); !errors.Is(err, ErrTokenInvalid) {
				t.Fatalf("unexpected identity result: %v", err)
			}
		})
	}
	if err := platformdb.WithWriteTx(context.Background(), store.DB(), func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE session_families SET revoked_at=? WHERE id=?`, clock.Now().UnixMilli(), issued.FamilyID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// This proof was valid before the revocation, like a request queued after
	// the HTTP middleware. It cannot be used in the later write transaction.
	if err := check(valid); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("revoked family survived transaction check: %v", err)
	}
}

func TestM4HumanTransactionIdentityKeepsStorageErrorsDistinct(t *testing.T) {
	sessions, store, clock := newSessionsFixture(t)
	user := newTestUser(t, store, "m4-storage@example.com")
	issued, err := sessions.CreateSession(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	claims := AccessTokenClaims{Subject: user.ID, FamilyID: issued.FamilyID, Type: "access", IssuedAt: clock.Now(), ExpiresAt: clock.Now().Add(time.Minute)}
	if err := ValidateHumanTx(context.Background(), store.DB(), claims, clock.Now()); !errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("unverified/placeholder account admitted: %v", err)
	}
	if _, err := store.DB().Exec(`UPDATE users SET email_verified=1,name='readyuser' WHERE id=?`, user.ID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := ValidateHumanTx(ctx, store.DB(), claims, clock.Now()); !errors.Is(err, context.Canceled) || errors.Is(err, ErrTokenInvalid) {
		t.Fatalf("storage/cancellation became credential rejection: %v", err)
	}
}
