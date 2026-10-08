// Package workspace owns the minimal team-space model needed for a REAL
// GET /api/servers membership query. Creation/invite flows are M2 and are
// deliberately absent.
package workspace

import (
	"context"
	"database/sql"
	"time"
)

// Membership is one row of the user's real server list.
type Membership struct {
	ID                    string
	Name                  string
	AvatarURL             *string
	Slug                  string
	OwnerID               string
	OnboardingAgentID     *string
	HideHumansFromMembers bool
	Plan                  string
	PlanDowngradedAt      *time.Time
	Role                  string
	ServerPushMuted       bool
	CreatedAt             time.Time
}

// Store reads workspace tables.
type Store struct{ db *sql.DB }

// NewStore wraps the database.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// ListUserServers returns every non-deleted workspace the user belongs to,
// ordered by join time — the same shape and ordering the legacy server list
// used. An empty result is a real business answer, never a placeholder.
func (s *Store) ListUserServers(ctx context.Context, userID string) ([]Membership, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT w.id, w.name, w.avatar_url, w.slug, w.owner_id, w.onboarding_agent_id,
		       w.hide_humans_from_members, w.plan, w.plan_downgraded_at,
		       m.role, m.server_push_muted, w.created_at
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ? AND w.deleted_at IS NULL
		ORDER BY m.joined_at ASC, w.id ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Membership{}
	for rows.Next() {
		var m Membership
		var avatarURL, onboardingAgent sql.NullString
		var planDowngraded sql.NullInt64
		var hideHumans, pushMuted int
		var createdAt int64
		if err := rows.Scan(&m.ID, &m.Name, &avatarURL, &m.Slug, &m.OwnerID, &onboardingAgent,
			&hideHumans, &m.Plan, &planDowngraded, &m.Role, &pushMuted, &createdAt); err != nil {
			return nil, err
		}
		if avatarURL.Valid {
			v := avatarURL.String
			m.AvatarURL = &v
		}
		if onboardingAgent.Valid {
			v := onboardingAgent.String
			m.OnboardingAgentID = &v
		}
		m.HideHumansFromMembers = hideHumans != 0
		m.ServerPushMuted = pushMuted != 0
		if planDowngraded.Valid {
			t := time.UnixMilli(planDowngraded.Int64).UTC()
			m.PlanDowngradedAt = &t
		}
		m.CreatedAt = time.UnixMilli(createdAt).UTC()
		out = append(out, m)
	}
	return out, rows.Err()
}

// CountMemberships supports readiness/diagnostics.
func (s *Store) CountMemberships(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspace_memberships`).Scan(&n)
	return n, err
}
