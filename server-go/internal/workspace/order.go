// Account-level workspace switcher order (TS getServerSwitcherOrder /
// updateServerSwitcherOrder). Stored per user — never per workspace — as a
// JSON array of workspace IDs plus a monotonic version.

package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
)

// GetOrder returns the caller's effective switcher order: saved IDs filtered
// to real eligible memberships (deduped, in saved sequence), then memberships
// missing from the saved list appended in join order. Without a saved row the
// answer is the join order with version 0.
func (s *Store) GetOrder(ctx context.Context, userID string) (WorkspaceOrder, error) {
	ids, err := s.membershipIDs(ctx, s.db, userID)
	if err != nil {
		return WorkspaceOrder{}, err
	}
	saved, version, err := s.readSavedOrder(ctx, s.db, userID)
	if err != nil {
		return WorkspaceOrder{}, err
	}
	return WorkspaceOrder{ServerOrder: orderIDs(ids, saved), ServerOrderVersion: version}, nil
}

// UpdateOrder persists a new order in one transaction. Foreign, unknown and
// duplicate IDs are silently filtered (never a 403), missing memberships are
// appended, and an update whose effective order equals the current one does
// not bump the version. The compare-and-set happens inside the IMMEDIATE
// transaction so concurrent updates cannot lose a version (design D08).
func (s *Store) UpdateOrder(ctx context.Context, userID string, ids []string) (WorkspaceOrder, error) {
	var out WorkspaceOrder
	err := s.withTx(ctx, func(tx *sql.Tx) error {
		memberIDs, err := s.membershipIDs(ctx, tx, userID)
		if err != nil {
			return err
		}
		saved, version, err := s.readSavedOrder(ctx, tx, userID)
		if err != nil {
			return err
		}
		current := orderIDs(memberIDs, saved)
		filtered := orderIDs(memberIDs, ids)
		if stringSlicesEqual(filtered, current) {
			out = WorkspaceOrder{ServerOrder: current, ServerOrderVersion: version}
			return nil
		}
		version++
		encoded, err := json.Marshal(filtered)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO account_workspace_order (user_id, server_order, version, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET
				server_order = excluded.server_order,
				version = excluded.version,
				updated_at = excluded.updated_at`,
			userID, string(encoded), version, s.now().UnixMilli()); err != nil {
			return err
		}
		out = WorkspaceOrder{ServerOrder: filtered, ServerOrderVersion: version}
		return nil
	})
	if err != nil {
		return WorkspaceOrder{}, err
	}
	if out.ServerOrder == nil {
		out.ServerOrder = []string{}
	}
	return out, nil
}

// membershipIDs lists eligible workspace IDs in join order (the same
// tie-breaker drift the list endpoint registers).
func (s *Store) membershipIDs(ctx context.Context, ex executor, userID string) ([]string, error) {
	rows, err := ex.QueryContext(ctx, `
		SELECT m.workspace_id
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ? AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'
		ORDER BY m.joined_at ASC, w.id ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// readSavedOrder parses the persisted order. Corrupt or non-array payloads
// degrade to "no saved order" (TS toStringArray), never to an error.
func (s *Store) readSavedOrder(ctx context.Context, ex executor, userID string) ([]string, int64, error) {
	var raw string
	var version int64
	err := ex.QueryRowContext(ctx,
		`SELECT server_order, version FROM account_workspace_order WHERE user_id = ?`, userID).
		Scan(&raw, &version)
	if err == sql.ErrNoRows {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	return parseOrderIDs(raw), version, nil
}

// parseOrderIDs keeps only string entries (TS toStringArray).
func parseOrderIDs(raw string) []string {
	var mixed []any
	if err := json.Unmarshal([]byte(raw), &mixed); err != nil {
		return nil
	}
	ids := []string{}
	for _, item := range mixed {
		if id, ok := item.(string); ok {
			ids = append(ids, id)
		}
	}
	return ids
}

// orderIDs applies the TS ordering: saved IDs filtered to the eligible set
// (first occurrence wins), then eligible IDs absent from the saved list
// appended in join order.
func orderIDs(memberIDs, saved []string) []string {
	allowed := make(map[string]bool, len(memberIDs))
	for _, id := range memberIDs {
		allowed[id] = true
	}
	inSaved := make(map[string]bool, len(saved))
	for _, id := range saved {
		inSaved[id] = true
	}
	out := make([]string, 0, len(memberIDs))
	seen := make(map[string]bool, len(memberIDs))
	for _, id := range saved {
		if allowed[id] && !seen[id] {
			out = append(out, id)
			seen[id] = true
		}
	}
	for _, id := range memberIDs {
		if !inSaved[id] {
			out = append(out, id)
			seen[id] = true
		}
	}
	return out
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
