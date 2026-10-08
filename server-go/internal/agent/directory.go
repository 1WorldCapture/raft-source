// Directory reads that feed the web/CLI projections: manageable agents,
// workspace metadata, creator summaries and created-agents rosters.
package agent

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// MembershipSummary is one human membership row for the manageable list.
type MembershipSummary struct {
	WorkspaceID string
	Name        string
	Slug        string
	Role        string
}

// Memberships lists a user's live workspace memberships (manageable input).
func (s *Store) Memberships(ctx context.Context, userID string) ([]MembershipSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT m.workspace_id, w.name, w.slug, m.role
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ? AND w.deleted_at IS NULL`, userID)
	if err != nil {
		return nil, fmt.Errorf("list memberships: %w", err)
	}
	defer rows.Close()
	var out []MembershipSummary
	for rows.Next() {
		var row MembershipSummary
		if err := rows.Scan(&row.WorkspaceID, &row.Name, &row.Slug, &row.Role); err != nil {
			return nil, fmt.Errorf("scan membership: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// ManageableAgent is the human-facing manageable-list projection input.
// It is distinct from the handle-only Agent CLI DirectoryAgent projection.
type ManageableAgent struct {
	ID          string
	Name        string
	DisplayName sql.NullString
	Description sql.NullString
	WorkspaceID string
	CreatorType sql.NullString
	CreatorID   sql.NullString
}

// ListAgentsInWorkspaces lists live agents across the given workspaces.
func (s *Store) ListAgentsInWorkspaces(ctx context.Context, workspaceIDs []string) ([]ManageableAgent, error) {
	if len(workspaceIDs) == 0 {
		return nil, nil
	}
	// Bound the IN list; identifiers are server-issued UUIDs.
	query := `SELECT id, name, display_name, description, workspace_id, creator_type, creator_id
		FROM agents WHERE deleted_at IS NULL AND workspace_id IN (`
	args := make([]any, 0, len(workspaceIDs))
	for i, id := range workspaceIDs {
		if i > 0 {
			query += ", "
		}
		query += "?"
		args = append(args, id)
	}
	query += `) ORDER BY workspace_id, created_at`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list agents in workspaces: %w", err)
	}
	defer rows.Close()
	var out []ManageableAgent
	for rows.Next() {
		var row ManageableAgent
		if err := rows.Scan(&row.ID, &row.Name, &row.DisplayName, &row.Description,
			&row.WorkspaceID, &row.CreatorType, &row.CreatorID); err != nil {
			return nil, fmt.Errorf("scan directory agent: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// WorkspaceMeta is the slice of the workspace row the identity surfaces read.
type WorkspaceMeta struct {
	ID                string
	Name              string
	Slug              string
	OwnerID           string
	OnboardingAgentID *string
}

// WorkspaceMeta loads the live workspace row; nil when absent/deleted.
func (s *Store) WorkspaceMeta(ctx context.Context, workspaceID string) (*WorkspaceMeta, error) {
	var meta WorkspaceMeta
	var onboarding sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT id, name, slug, owner_id, onboarding_agent_id
		FROM workspaces WHERE id = ? AND deleted_at IS NULL`, workspaceID).
		Scan(&meta.ID, &meta.Name, &meta.Slug, &meta.OwnerID, &onboarding)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read workspace meta: %w", err)
	}
	if onboarding.Valid && onboarding.String != "" {
		meta.OnboardingAgentID = &onboarding.String
	}
	return &meta, nil
}

// CreatorSummary is the enriched creator projection (TS enrichAgentWithCreatorProfile).
type CreatorSummary struct {
	Type        string  `json:"type"`
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	DisplayName *string `json:"displayName"`
	AvatarURL   *string `json:"avatarUrl"`
	DeletedAt   *string `json:"deletedAt,omitempty"`
}

// Creator resolves the creating human or agent row; nil when unresolvable.
func (s *Store) Creator(ctx context.Context, a *Agent) (*CreatorSummary, error) {
	if !a.CreatorType.Valid || !a.CreatorID.Valid {
		return nil, nil
	}
	switch a.CreatorType.String {
	case "user":
		var name string
		var displayName, avatarURL sql.NullString
		err := s.db.QueryRowContext(ctx, `
			SELECT name, display_name, avatar_url FROM users WHERE id = ?`,
			a.CreatorID.String).Scan(&name, &displayName, &avatarURL)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read creator user: %w", err)
		}
		return &CreatorSummary{
			Type: "human", ID: a.CreatorID.String, Name: name,
			DisplayName: nullString(displayName), AvatarURL: nullString(avatarURL),
		}, nil
	case "agent":
		var name string
		var displayName, avatarURL sql.NullString
		var deletedAt sql.NullInt64
		err := s.db.QueryRowContext(ctx, `
			SELECT name, display_name, avatar_url, deleted_at FROM agents WHERE id = ?`,
			a.CreatorID.String).Scan(&name, &displayName, &avatarURL, &deletedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read creator agent: %w", err)
		}
		summary := &CreatorSummary{
			Type: "agent", ID: a.CreatorID.String, Name: name,
			DisplayName: nullString(displayName), AvatarURL: nullString(avatarURL),
		}
		if deletedAt.Valid {
			summary.DeletedAt = isoStringPtr(deletedAt.Int64)
		}
		return summary, nil
	default:
		return nil, nil
	}
}

// CreatedAgentSummary is one entry of the createdAgents roster.
type CreatedAgentSummary struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	DisplayName *string `json:"displayName"`
	AvatarURL   *string `json:"avatarUrl"`
	Runtime     string  `json:"runtime"`
	External    bool    `json:"external,omitempty"`
	Status      string  `json:"status"`
}

// CreatedAgents lists the agents this agent created (creator_type='agent').
func (s *Store) CreatedAgents(ctx context.Context, agentID string) ([]CreatedAgentSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, display_name, avatar_url, runtime, status FROM agents
		WHERE creator_type = 'agent' AND creator_id = ? AND deleted_at IS NULL
		ORDER BY created_at ASC`, agentID)
	if err != nil {
		return nil, fmt.Errorf("list created agents: %w", err)
	}
	defer rows.Close()
	out := []CreatedAgentSummary{}
	for rows.Next() {
		var row CreatedAgentSummary
		var displayName, avatarURL sql.NullString
		if err := rows.Scan(&row.ID, &row.Name, &displayName, &avatarURL, &row.Runtime, &row.Status); err != nil {
			return nil, fmt.Errorf("scan created agent: %w", err)
		}
		row.DisplayName = nullString(displayName)
		row.AvatarURL = nullString(avatarURL)
		row.External = IsExternalAgentRuntime(row.Runtime)
		out = append(out, row)
	}
	return out, rows.Err()
}

// channelAgentsTablePresent reports whether the CHANNEL worker's 0006
// channel_agents table is applied. Until it is, no agent holds any channel
// membership (there is no membership writer), so roster reads answer the
// empty roster — the true answer, not a degraded one.
func (s *Store) channelAgentsTablePresent(ctx context.Context) bool {
	var count int
	if err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'channel_agents'`).
		Scan(&count); err != nil {
		return false
	}
	return count > 0
}

// GuestVisibleAgentIDs returns the agents a guest can see through local
// channel membership. With no channel_agents rows in this build the answer
// is empty for every guest, which is exactly the roster this schema holds.
func (s *Store) GuestVisibleAgentIDs(ctx context.Context, workspaceID, userID string) (map[string]bool, error) {
	visible := map[string]bool{}
	if !s.channelAgentsTablePresent(ctx) {
		return visible, nil
	}
	// C0 policy vector: a guest is in no channel (the guest join surface is
	// off and no membership rows exist for guests), so the channel-derived
	// roster is empty. The query keeps the real rule — only channels the
	// guest is explicitly a member of — rather than widening to public
	// channels the C0 guest cannot see.
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT ca.agent_id
		FROM channel_agents ca
		JOIN channels c ON c.id = ca.channel_id
		WHERE c.workspace_id = ? AND c.deleted_at IS NULL AND c.archived_at IS NULL
		  AND EXISTS (SELECT 1 FROM channel_humans ch
		              WHERE ch.channel_id = c.id AND ch.user_id = ?)`,
		workspaceID, userID)
	if err != nil {
		return nil, fmt.Errorf("guest visible agents: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan guest visible agent: %w", err)
		}
		visible[id] = true
	}
	return visible, rows.Err()
}
