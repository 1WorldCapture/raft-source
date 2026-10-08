// Cheap principal rechecks for machine callbacks. Argon2id already ran when
// the connection was authenticated; every later agent mutation re-reads the
// proved verifier revision, revocation, and the current machine link inside
// one short write transaction. The check never hashes and never calls the network.
package agent

import (
	"context"
	"database/sql"
	"errors"

	"raft.local/server-go/internal/computer"
)

// errPrincipalStale rolls the transaction back without an infrastructure
// error. The callback treats it as "do not mutate".
var errPrincipalStale = errors.New("agent: principal binding is not live")

// PrincipalBindingLive reports whether this principal may still mutate
// agents on its machine. The check is computer.ValidatePrincipalTx: the
// stored verifier revision proved by Authenticate, revocation, migration,
// workspace, and the current machine binding. A missing revision fails
// closed. The read does not hash.
func (s *Store) PrincipalBindingLive(ctx context.Context, p computer.Principal) (bool, error) {
	live := false
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		ok, err := principalAuthorized(ctx, tx, p)
		live = ok
		return err
	})
	return live, err
}

func principalAuthorized(ctx context.Context, tx *sql.Tx, p computer.Principal) (bool, error) {
	err := computer.ValidatePrincipalTx(ctx, tx, p)
	if err == nil {
		return true, nil
	}
	if computer.AsAuthError(err) != nil {
		return false, nil
	}
	return false, err
}

// WithLivePrincipal runs fn inside one IMMEDIATE transaction after the
// binding recheck. fn is not called when the principal is stale, and nothing
// it wrote can commit in that case. A nil fn still performs the recheck.
func (s *Store) WithLivePrincipal(ctx context.Context, p computer.Principal, fn func(tx *sql.Tx) error) (bool, error) {
	live := false
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		ok, err := principalAuthorized(ctx, tx, p)
		if err != nil {
			return err
		}
		if !ok {
			return errPrincipalStale
		}
		live = true
		if fn == nil {
			return nil
		}
		return fn(tx)
	})
	if errors.Is(err, errPrincipalStale) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return live, nil
}

// WithBoundAgent is WithLivePrincipal plus the current agent binding:
// the row must be live, in the principal's workspace, and assigned to the
// principal's machine. A mismatch commits nothing.
func (s *Store) WithBoundAgent(ctx context.Context, p computer.Principal, agentID string, fn func(tx *sql.Tx, a *Agent) error) (bool, error) {
	if agentID == "" {
		return false, nil
	}
	live, err := s.WithLivePrincipal(ctx, p, func(tx *sql.Tx) error {
		loaded, err := scanAgent(tx.QueryRowContext(ctx,
			`SELECT `+agentColumns+` FROM agents a
			 WHERE a.id = ? AND a.workspace_id = ? AND a.deleted_at IS NULL`,
			agentID, p.WorkspaceID))
		if errors.Is(err, sql.ErrNoRows) {
			return errPrincipalStale
		}
		if err != nil {
			return err
		}
		if !loaded.MachineID.Valid || loaded.MachineID.String != p.MachineID {
			return errPrincipalStale
		}
		return fn(tx, loaded)
	})
	if errors.Is(err, errPrincipalStale) {
		return false, nil
	}
	return live, err
}
