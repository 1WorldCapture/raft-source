package computer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestLivePrincipalRejectsRevocationBeforeAnotherDomainWrite(t *testing.T) {
	f := newFixture(t)
	f.seedUser(t, "u")
	f.seedWorkspace(t, "w", "alpha", "u")
	f.seedMembership(t, "w", "u", "owner")
	a, err := f.store.AttachComputer(t.Context(), "u", "alpha", "Computer")
	if err != nil {
		t.Fatal(err)
	}
	p, err := f.store.Authenticate(t.Context(), a.APIKey)
	if err != nil || p.CredentialRevision == "" {
		t.Fatalf("proved principal missing revision: %v", err)
	}
	encoded, err := json.Marshal(p)
	if err != nil || strings.Contains(string(encoded), p.CredentialRevision) {
		t.Fatal("stored verifier revision must not be in external principal JSON")
	}
	if err := f.store.ValidatePrincipal(t.Context(), p); err != nil {
		t.Fatal(err)
	}
	unproved := p
	unproved.CredentialRevision = ""
	wantAuthReason(t, f.store.ValidatePrincipal(t.Context(), unproved), ReasonComputerKeyMismatch, StageComputerLookup)
	if err := f.store.RevokeComputer(t.Context(), a.ServerMachineID, "u", "test"); err != nil {
		t.Fatal(err)
	}
	wantAuthReason(t, f.store.ValidatePrincipal(t.Context(), p), ReasonComputerRevoked, StageComputerLookup)
	// This models a delayed frame that was buffered before socket close: the
	// durable guard belongs to the same write transaction as its mutation.
	err = f.store.withTx(t.Context(), func(tx *sql.Tx) error {
		if err := ValidatePrincipalTx(t.Context(), tx, p); err != nil {
			return err
		}
		_, err := tx.Exec(`UPDATE machines SET hostname = 'should-not-land' WHERE id = ?`, p.MachineID)
		return err
	})
	wantAuthReason(t, err, ReasonComputerRevoked, StageComputerLookup)
	var hostname sql.NullString
	if err := f.db.QueryRow(`SELECT hostname FROM machines WHERE id = ?`, p.MachineID).Scan(&hostname); err != nil || hostname.Valid {
		t.Fatalf("revoked connection wrote a machine fact: %v", err)
	}
}

func TestLivePrincipalRotationAndBindingGuards(t *testing.T) {
	f := newFixture(t)
	f.seedUser(t, "u")
	f.seedWorkspace(t, "w", "alpha", "u")
	f.seedWorkspace(t, "other", "other", "u")
	f.seedMembership(t, "w", "u", "owner")
	registered, err := f.store.RegisterMachine(t.Context(), "w", "u", "Legacy")
	if err != nil {
		t.Fatal(err)
	}
	p, err := f.store.Authenticate(t.Context(), registered.APIKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.ValidatePrincipal(t.Context(), p); err != nil {
		t.Fatal(err)
	}
	key, err := f.store.RotateMachineKey(t.Context(), "w", p.MachineID, "u", "owner")
	if err != nil {
		t.Fatal(err)
	}
	wantAuthReason(t, f.store.ValidatePrincipal(t.Context(), p), ReasonMachineKeyInvalid, StageMachineLookup)
	current, err := f.store.Authenticate(t.Context(), key)
	if err != nil || current.CredentialRevision == p.CredentialRevision {
		t.Fatalf("rotation must change live proof: %v", err)
	}
	if err := f.store.ValidatePrincipal(t.Context(), current); err != nil {
		t.Fatal(err)
	}
	foreign := current
	foreign.WorkspaceID = "other"
	wantAuthReason(t, f.store.ValidatePrincipal(t.Context(), foreign), ReasonMachineKeyInvalid, StageMachineLookup)
	if _, err := f.db.Exec(`UPDATE machines SET legacy_key_migrated_at = 1 WHERE id = ?`, p.MachineID); err != nil {
		t.Fatal(err)
	}
	wantAuthReason(t, f.store.ValidatePrincipal(t.Context(), current), ReasonLegacyKeyMigrated, StageLegacyMigration)
}

func TestLivePrincipalCancellationIsNotInvalidCredentials(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err := f.store.ValidatePrincipal(ctx, Principal{})
	if !errors.Is(err, context.Canceled) || AsAuthError(err) != nil {
		t.Fatalf("cancellation was mislabeled credential failure: %v", err)
	}
	if err := ValidatePrincipalTx(t.Context(), nil, Principal{}); err == nil || AsAuthError(err) != nil {
		t.Fatalf("missing transaction was mislabeled credential failure: %v", err)
	}
}
