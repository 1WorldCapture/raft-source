package agent

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"
)

// mintForAgent issues a live sk_agent credential through the store so the
// lookup mirrors exactly what the middleware would hand SendAgent.
func mintForAgent(t *testing.T, store *Store, agentID string, scopes []string) CredentialLookup {
	t.Helper()
	minted, err := store.MintCredential(context.Background(), agentID, scopes, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	return CredentialLookup{
		CredentialID: minted.CredentialID,
		AgentID:      agentID,
		WorkspaceID:  minted.WorkspaceID,
		Scopes:       minted.Scopes,
	}
}

func TestRevalidateCredentialReturnsCurrentStoredScopes(t *testing.T) {
	handle, store, _ := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusActive, "", "owner")
	if _, err := handle.Exec(`
		INSERT INTO agent_members (workspace_id, agent_id, role, joined_at, updated_at)
		VALUES ('ws', 'agent-1', 'member', 1, 1)`); err != nil {
		t.Fatal(err)
	}
	lookup := mintForAgent(t, store, "agent-1", []string{"send", "read"})

	// The middleware snapshot is stale the moment the stored scopes change:
	// revalidation must return the CURRENT row, not the lookup copy.
	encoded, err := json.Marshal([]string{"read"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE agent_credentials SET scopes = ? WHERE id = ?`,
		string(encoded), lookup.CredentialID); err != nil {
		t.Fatal(err)
	}

	principal, err := store.RevalidateCredential(context.Background(), lookup)
	if err != nil {
		t.Fatal(err)
	}
	if len(principal.Scopes) != 1 || principal.Scopes[0] != "read" {
		t.Fatalf("scopes not re-read from the row: %v", principal.Scopes)
	}
	if principal.HasScope("send") {
		t.Fatal("revoked-by-update scope still authorizes")
	}
	if !principal.HasScope("read") {
		t.Fatal("live scope missing")
	}
	if principal.Agent == nil || principal.Agent.ID != "agent-1" {
		t.Fatalf("agent projection: %+v", principal.Agent)
	}
	if principal.Role == nil || *principal.Role != "member" {
		t.Fatalf("role: %+v", principal.Role)
	}
}

func TestRevalidateCredentialRevokedRefusesDespiteLookupScopes(t *testing.T) {
	handle, store, _ := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusActive, "", "owner")
	lookup := mintForAgent(t, store, "agent-1", []string{"send"})
	if _, err := handle.Exec(`UPDATE agent_credentials SET revoked_at = 5 WHERE id = ?`,
		lookup.CredentialID); err != nil {
		t.Fatal(err)
	}
	_, err := store.RevalidateCredential(context.Background(), lookup)
	if AsError(err) != ErrCredentialRevoked {
		t.Fatalf("revoked credential revalidated: %v", err)
	}
}

func TestRevalidateCredentialAgentAndWorkspaceGone(t *testing.T) {
	handle, store, _ := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusActive, "", "owner")
	lookup := mintForAgent(t, store, "agent-1", []string{"send"})

	if _, err := handle.Exec(`UPDATE agents SET deleted_at = 9 WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RevalidateCredential(context.Background(), lookup); AsError(err) != ErrAuthenticatedAgentGone {
		t.Fatalf("deleted agent revalidated: %v", err)
	}
	if _, err := handle.Exec(`UPDATE agents SET deleted_at = NULL WHERE id = 'agent-1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`UPDATE workspaces SET deleted_at = 9 WHERE id = 'ws'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RevalidateCredential(context.Background(), lookup); AsError(err) != ErrAuthenticatedServerGone {
		t.Fatalf("deleted workspace revalidated: %v", err)
	}
}

func TestRevalidateCredentialBindingAndWorkspaceMismatchRefuse(t *testing.T) {
	handle, store, _ := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusActive, "", "owner")
	insertAgent(t, handle, "agent-2", "ws", "Bea", StatusActive, "", "owner")
	lookup := mintForAgent(t, store, "agent-1", []string{"send"})

	// Forged lookup: same credential, different agent.
	forged := lookup
	forged.AgentID = "agent-2"
	if _, err := store.RevalidateCredential(context.Background(), forged); AsError(err) == nil || AsError(err).Status != 401 {
		t.Fatalf("credential re-bound across agents: %v", err)
	}

	// Cross-workspace target: the credential is live but the send would land
	// in another workspace.
	seedIdentity(t, handle, "owner2", "ws2")
	insertAgent(t, handle, "agent-x", "ws2", "Eve", StatusActive, "", "owner2")
	cross := lookup
	cross.WorkspaceID = "ws2"
	if _, err := store.RevalidateCredential(context.Background(), cross); AsError(err) == nil || AsError(err).Status != 401 {
		t.Fatalf("cross-workspace principal accepted: %v", err)
	}
}

func TestRevalidateCredentialTxRunsInCallerTransaction(t *testing.T) {
	handle, store, _ := newTestStore(t)
	seedIdentity(t, handle, "owner", "ws")
	insertAgent(t, handle, "agent-1", "ws", "Ada", StatusActive, "", "owner")
	lookup := mintForAgent(t, store, "agent-1", []string{"send"})

	// Happy path first: the transaction-bound call succeeds inside the
	// caller's open transaction and leaves it usable for the send itself.
	txErr := store.withTx(context.Background(), func(tx *sql.Tx) error {
		verified, err := store.RevalidateCredentialTx(context.Background(), tx, lookup)
		if err != nil {
			return err
		}
		if !verified.HasScope("send") {
			t.Fatalf("scopes: %v", verified.Scopes)
		}
		// The caller keeps writing through the same transaction (the send's
		// own facts) — prove the transaction is still alive.
		_, err = tx.ExecContext(context.Background(),
			`UPDATE agents SET updated_at = updated_at WHERE id = 'agent-1'`)
		return err
	})
	if txErr != nil {
		t.Fatalf("tx form happy path: %v", txErr)
	}

	// The refusal path: a revocation made inside the SAME transaction must
	// refuse the principal even though the middleware lookup predates it.
	refused := false
	txErr = store.withTx(context.Background(), func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(context.Background(),
			`UPDATE agent_credentials SET revoked_at = 7 WHERE id = ?`, lookup.CredentialID); err != nil {
			return err
		}
		_, err := store.RevalidateCredentialTx(context.Background(), tx, lookup)
		if AsError(err) == ErrCredentialRevoked {
			refused = true
			return nil
		}
		return err
	})
	if txErr != nil {
		t.Fatalf("tx form refusal path: %v", txErr)
	}
	if !refused {
		t.Fatal("revocation inside the send transaction did not refuse the principal")
	}
	_ = handle
}
