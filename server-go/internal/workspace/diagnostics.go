package workspace

import (
	"context"
	"database/sql"
	"fmt"
)

// Diagnostic is an actionable read-only integrity finding, not authorization
// repair. In particular an upgrade must never grant a missing owner membership
// or clear an unexplained onboarding pointer to make initialization look valid.
type Diagnostic struct {
	WorkspaceID string
	Code        string
}

func (s *Store) Diagnose(ctx context.Context) ([]Diagnostic, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT w.id, m.role, st.user_id, p.user_id,
		       w.onboarding_agent_id, a.id
		FROM workspaces w
		LEFT JOIN workspace_memberships m ON m.workspace_id = w.id AND m.user_id = w.owner_id
		LEFT JOIN workspace_member_setup st ON st.workspace_id = w.id AND st.user_id = w.owner_id
		LEFT JOIN workspace_member_preferences p ON p.workspace_id = w.id AND p.user_id = w.owner_id
		LEFT JOIN agents a ON a.id = w.onboarding_agent_id AND a.workspace_id = w.id AND a.deleted_at IS NULL
		WHERE w.deleted_at IS NULL AND w.kind != 'joint_storage'
		ORDER BY w.id`)
	if err != nil {
		return nil, fmt.Errorf("diagnose workspace data: %w", err)
	}
	defer rows.Close()
	issues := []Diagnostic{}
	for rows.Next() {
		var id string
		var role, setupUser, preferenceUser, pointer, resolvedAgent sql.NullString
		if err := rows.Scan(&id, &role, &setupUser, &preferenceUser, &pointer, &resolvedAgent); err != nil {
			return nil, err
		}
		if !role.Valid || role.String != RoleOwner {
			issues = append(issues, Diagnostic{WorkspaceID: id, Code: "OWNER_MEMBERSHIP_INCONSISTENT"})
		} else {
			if !setupUser.Valid {
				issues = append(issues, Diagnostic{WorkspaceID: id, Code: "OWNER_SETUP_STATE_MISSING"})
			}
			if !preferenceUser.Valid {
				issues = append(issues, Diagnostic{WorkspaceID: id, Code: "OWNER_PREFERENCES_MISSING"})
			}
		}
		if pointer.Valid && !resolvedAgent.Valid {
			issues = append(issues, Diagnostic{WorkspaceID: id, Code: "ONBOARDING_AGENT_REFERENCE_UNRESOLVED"})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return issues, nil
}
