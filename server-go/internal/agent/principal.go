// Transaction-bound agent principal revalidation (M5 cross-module contract
// #6). B's messaging.Service.SendAgent and the Agent API handlers receive an
// authenticated CredentialLookup from the middleware (argon2id already ran at
// the door). That lookup is NOT a standing authorization: every use case must
// reverify, inside the SAME write transaction that persists the send, that
// the credential is still live, that its scopes are the CURRENT stored ones
// (a revoked credential's scopes are revoked with it — the middleware
// snapshot is never trusted), that the agent and workspace are still live,
// and that the credential is still bound to the same agent. This file owns
// exactly that check. It never hashes and never touches the network.
package agent

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	platformdb "raft.local/server-go/internal/platform/db"
)

// RevalidatedPrincipal is the live authorization snapshot as of the
// transaction that produced it. Scopes are re-read from agent_credentials,
// never copied from the caller's lookup.
type RevalidatedPrincipal struct {
	CredentialID string
	AgentID      string
	WorkspaceID  string
	// Scopes are the credential's CURRENT stored capabilities. A credential
	// whose row is revoked fails revalidation entirely; there is no state in
	// which revoked scopes still authorize anything.
	Scopes []string
	// Agent is the live agent row projection the send will be attributed to.
	Agent *Agent
	// Role is the agent's server membership role (nil when absent).
	Role *string
}

// HasScope reports whether the revalidated scopes include one capability.
func (p *RevalidatedPrincipal) HasScope(capability string) bool {
	if p == nil {
		return false
	}
	for _, scope := range p.Scopes {
		if scope == capability {
			return true
		}
	}
	return false
}

// Revalidation failures. AsError carries the legacy status/body the Agent
// API maps; the revoked case is distinct from a bad key so operators can see
// a revocation took effect (the key itself already authenticated at the door).
var ErrCredentialRevoked = errf(401, "credential_revoked", "Agent credential has been revoked")

// ErrLaunchPersistenceUnavailable is returned by the M5 lifecycle paths when
// the agent_launches table (migration 0014, delivery worker A) is not
// present. It is a real refusal, not a silent fallback.
var ErrLaunchPersistenceUnavailable = errf(501, "launch_persistence_unavailable",
	"Agent launch persistence is not available in this build")

// RevalidateCredentialTx revalidates the principal inside the CALLER'S open
// write transaction (the same platformdb.WithWriteTx that will persist the
// send). B calls this from messaging.Service.SendAgent; the Agent API uses
// the standalone variant. Rules, in order:
//
//  1. the credential row must exist with revoked_at IS NULL,
//  2. the row must still be bound to lookup.AgentID (binding drift refuses),
//  3. the agent must be live and in lookup.WorkspaceID when that is set,
//  4. the workspace must be live,
//  5. scopes are the row's CURRENT stored scopes.
//
// A failure returns a *Error; nothing about the caller's transaction is
// rolled back here (the caller decides), but the send use case must treat
// any error as a refusal.
func (s *Store) RevalidateCredentialTx(ctx context.Context, tx *sql.Tx, lookup CredentialLookup) (*RevalidatedPrincipal, error) {
	if tx == nil {
		return nil, fmt.Errorf("agent: RevalidateCredentialTx requires the caller's open transaction")
	}
	return s.validateCredentialOn(ctx, tx, lookup)
}

// RevalidateCredential is the standalone form: it opens one short IMMEDIATE
// transaction itself. Use it when the caller has no send transaction of its
// own (Agent API reads); use RevalidateCredentialTx for sends so the check
// commits with the fact it authorizes.
func (s *Store) RevalidateCredential(ctx context.Context, lookup CredentialLookup) (*RevalidatedPrincipal, error) {
	var principal *RevalidatedPrincipal
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		verified, err := s.RevalidateCredentialTx(ctx, tx, lookup)
		if err != nil {
			return err
		}
		principal = verified
		return nil
	})
	if err != nil {
		return nil, err
	}
	return principal, nil
}

// Executor is the shared transaction/snapshot executor type (an alias of
// platformdb.Executor). Both *sql.Tx (a caller's WithWriteTx) and the
// executor handed to a WithReadSnapshot satisfy it, so the same validator
// runs inside send transactions AND read snapshots — the GET history/context
// paths must verify the credential against the same snapshot they read from
// (B contract feedback #6), never a pre-transaction snapshot.
type Executor = platformdb.Executor

// ValidateAgentPrincipalTx is the generic transaction-bound entry B's
// messaging use cases consume (see docs/m5-messaging-worker-contract.md §4):
// it revalidates the credential against ex (write transaction or read
// snapshot) exactly like RevalidateCredentialTx and additionally enforces the
// capability scope. Error mapping for the caller:
//
//   - invalid binding / unknown credential ......... 401 invalid credential
//   - revoked ...................................... 401 credential_revoked
//   - agent gone / server gone ..................... 401 (legacy bodies)
//   - live principal without the capability ........ 403 capability_not_authorized
//
// B's AgentPrincipalValidator interface must declare the ex parameter as
// platformdb.Executor (or an alias of it) for *Store to satisfy it directly;
// channel.Executor is currently a distinct interface type with the same
// method set and would NOT match (recorded in
// docs/m5-lifecycle-worker-contract.md §2.3).
func (s *Store) ValidateAgentPrincipalTx(ctx context.Context, ex Executor, principal CredentialLookup, capability string) error {
	tx, ok := ex.(*sql.Tx)
	if !ok {
		// A read snapshot executor: the same checks against the caller's
		// snapshot; nothing is written, so no transaction is opened.
		verified, err := s.validateCredentialOn(ctx, ex, principal)
		if err != nil {
			return err
		}
		return requireCapability(verified, capability)
	}
	verified, err := s.RevalidateCredentialTx(ctx, tx, principal)
	if err != nil {
		return err
	}
	return requireCapability(verified, capability)
}

func requireCapability(p *RevalidatedPrincipal, capability string) error {
	if capability == "" {
		return nil
	}
	if p.HasScope(capability) {
		return nil
	}
	return errf(403, "capability_not_authorized",
		"The `"+capability+"` capability is required for this operation")
}

// validateCredentialOn is RevalidateCredentialTx against a bare executor
// (read-snapshot form). Identical rules; shared by the generic entry.
func (s *Store) validateCredentialOn(ctx context.Context, ex Executor, lookup CredentialLookup) (*RevalidatedPrincipal, error) {
	if lookup.CredentialID == "" || lookup.AgentID == "" {
		return nil, errf(401, "", "Invalid agent credential")
	}
	var rowAgentID, scopesRaw string
	var revoked sql.NullInt64
	err := ex.QueryRowContext(ctx,
		`SELECT agent_id, scopes, revoked_at FROM agent_credentials WHERE id = ?`,
		lookup.CredentialID).Scan(&rowAgentID, &scopesRaw, &revoked)
	if err == sql.ErrNoRows {
		return nil, errf(401, "", "Invalid agent credential")
	}
	if err != nil {
		// Context cancellations and infrastructure failures are NOT
		// authentication verdicts: they propagate so the caller answers 5xx
		// (or the request's own cancellation) instead of a false 401.
		return nil, fmt.Errorf("agent: revalidate credential read: %w", err)
	}
	if revoked.Valid {
		return nil, ErrCredentialRevoked
	}
	if rowAgentID != lookup.AgentID {
		return nil, errf(401, "", "Invalid agent credential")
	}
	loaded, err := scanAgent(ex.QueryRowContext(ctx,
		`SELECT `+agentColumns+` FROM agents a WHERE a.id = ?`, lookup.AgentID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrAuthenticatedAgentGone
	}
	if err != nil {
		return nil, fmt.Errorf("agent: revalidate agent read: %w", err)
	}
	if loaded.DeletedAt.Valid {
		return nil, ErrAuthenticatedAgentGone
	}
	if lookup.WorkspaceID != "" && loaded.WorkspaceID != lookup.WorkspaceID {
		return nil, errf(401, "", "Invalid agent credential")
	}
	var workspaceDeleted sql.NullInt64
	err = ex.QueryRowContext(ctx,
		`SELECT deleted_at FROM workspaces WHERE id = ?`, loaded.WorkspaceID).
		Scan(&workspaceDeleted)
	if err == sql.ErrNoRows || (err == nil && workspaceDeleted.Valid) {
		return nil, ErrAuthenticatedServerGone
	}
	if err != nil {
		return nil, fmt.Errorf("revalidate workspace: %w", err)
	}
	current, err := decodeScopes(scopesRaw)
	if err != nil {
		return nil, err
	}
	var role *string
	var roleValue string
	err = ex.QueryRowContext(ctx,
		`SELECT role FROM agent_members WHERE workspace_id = ? AND agent_id = ?`,
		loaded.WorkspaceID, lookup.AgentID).Scan(&roleValue)
	if err == nil {
		role = &roleValue
	} else if err != sql.ErrNoRows {
		return nil, fmt.Errorf("revalidate agent role: %w", err)
	}
	return &RevalidatedPrincipal{
		CredentialID: lookup.CredentialID,
		AgentID:      lookup.AgentID,
		WorkspaceID:  loaded.WorkspaceID,
		Scopes:       current,
		Agent:        loaded,
		Role:         role,
	}, nil
}
