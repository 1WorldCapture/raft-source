// Roster reads: channel members (humans + agents), the derived audiences of
// the system channels, and the per-row authority projection the members panel
// renders (projectMemberRole). externalMembers is always empty in this phase
// (no external bridges) and is added by transport.
package channel

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
)

// RosterHuman is one human row of GET /:id/members.
type RosterHuman struct {
	ID                   string
	ServerID             string
	ServerName           string
	ServerSlug           string
	Name                 string
	DisplayName          *string
	Description          *string
	AvatarURL            *string
	GravatarHash         string
	ServerRole           string // projected server role ("role" and "serverRole" on the wire)
	ChannelRole          *string
	EffectiveChannelRole string
	ChannelAdminBasis    *string
	CanChangeChannelRole bool
}

// RosterAgent is one agent row of GET /:id/members and GET /:id/agents.
type RosterAgent struct {
	ID                   string
	ServerID             string
	ServerName           string
	ServerSlug           string
	Name                 string
	DisplayName          *string
	Status               string
	AvatarURL            *string
	ChannelRole          *string
	ServerRole           *string
	EffectiveChannelRole string
	ChannelAdminBasis    *string
	CanChangeChannelRole bool
}

// Roster is the raw member read before the viewer-aware projection.
type Roster struct {
	Agents []RosterAgent
	Humans []RosterHuman
}

// ProjectRoster applies projectMemberRole over the raw roster: normalize the
// server role, derive effectiveChannelRole/channelAdminBasis, and stamp
// canChangeChannelRole (the viewer must hold changeChannelMemberRoles, act on
// someone else, and the target must be an ordinary member).
func (r Roster) Project(viewerCanChangeRoles bool, viewerUserID string) {
	for i := range r.Humans {
		h := &r.Humans[i]
		h.EffectiveChannelRole, h.ChannelAdminBasis = projectRole(h.ServerRole, h.ChannelRole)
		h.CanChangeChannelRole = viewerCanChangeRoles && h.ID != viewerUserID &&
			h.ServerRole != RoleOwner && h.ServerRole != RoleAdmin && h.ServerRole != RoleGuest
	}
	for i := range r.Agents {
		a := &r.Agents[i]
		serverRole := RoleMember
		if a.ServerRole != nil && *a.ServerRole != "" {
			serverRole = *a.ServerRole
		}
		a.EffectiveChannelRole, a.ChannelAdminBasis = projectRole(serverRole, a.ChannelRole)
		// projectMemberRole always writes the normalized server role, including
		// the "member" default for derived #all rows that have no role key.
		a.ServerRole = strPtr(serverRole)
		a.CanChangeChannelRole = viewerCanChangeRoles && a.ID != viewerUserID &&
			serverRole != RoleOwner && serverRole != RoleAdmin && serverRole != RoleGuest
	}
}

// projectRole mirrors the TS effectiveChannelRole/channelAdminBasis math.
func projectRole(serverRole string, channelRole *string) (string, *string) {
	isChannelAdmin := channelRole != nil && *channelRole == ChannelRoleAdmin
	var effective string
	var basis *string
	switch {
	case serverRole == RoleOwner:
		effective = RoleOwner
	case serverRole == RoleAdmin || isChannelAdmin:
		effective = RoleAdmin
	case serverRole == RoleGuest:
		effective = RoleGuest
	default:
		effective = ChannelRoleMember
	}
	if serverRole == RoleOwner || serverRole == RoleAdmin {
		if isChannelAdmin {
			basis = strPtr("both")
		} else {
			basis = strPtr("server_role")
		}
	} else if isChannelAdmin {
		basis = strPtr("channel_role")
	}
	return effective, basis
}

func strPtr(v string) *string { return &v }

// GetChannelMembers ports getChannelMembers for the reachable shapes: threads
// cannot exist (no messages), joint channels have no projections here, so the
// read is the explicit roster or — for #all/#announcement — the derived
// server audience.
func (s *Store) GetChannelMembers(ctx context.Context, channelID string) (*Roster, error) {
	channel, err := s.GetChannel(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel == nil {
		return &Roster{}, nil
	}
	if HasImplicitServerMembership(channel) {
		return s.getServerAudience(ctx, channel.WorkspaceID)
	}
	humans, err := s.channelHumansRaw(ctx, channelID)
	if err != nil {
		return nil, err
	}
	agents, err := s.channelAgentsRaw(ctx, channelID)
	if err != nil {
		return nil, err
	}
	return &Roster{Agents: agents, Humans: humans}, nil
}

// GetChannelAgents ports getChannelAgents (the /:id/agents shape — no
// per-viewer projection).
func (s *Store) GetChannelAgents(ctx context.Context, channelID string) ([]RosterAgent, error) {
	channel, err := s.GetChannel(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel != nil && HasImplicitServerMembership(channel) {
		audience, err := s.getServerAudience(ctx, channel.WorkspaceID)
		if err != nil {
			return nil, err
		}
		return audience.Agents, nil
	}
	return s.channelAgentsRaw(ctx, channelID)
}

// channelHumansRaw ports getChannelHumansRaw: explicit rows, inner-joined to
// live memberships, ordered by joinedAt; email never leaves gravatarHash.
func (s *Store) channelHumansRaw(ctx context.Context, channelID string) ([]RosterHuman, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, c.workspace_id, w.name, w.slug, u.name, u.display_name,
		       u.description, u.avatar_url, u.email, m.role, ch.role
		FROM channel_humans ch
		JOIN channels c ON c.id = ch.channel_id
		JOIN workspaces w ON w.id = c.workspace_id
		JOIN users u ON u.id = ch.user_id
		JOIN workspace_memberships m ON m.workspace_id = c.workspace_id AND m.user_id = u.id
		WHERE ch.channel_id = ?
		ORDER BY ch.joined_at ASC`, channelID)
	if err != nil {
		return nil, fmt.Errorf("read channel humans: %w", err)
	}
	defer rows.Close()
	out := []RosterHuman{}
	for rows.Next() {
		var h RosterHuman
		var displayName, description, avatarURL, email sql.NullString
		var channelRole sql.NullString
		if err := rows.Scan(&h.ID, &h.ServerID, &h.ServerName, &h.ServerSlug, &h.Name,
			&displayName, &description, &avatarURL, &email, &h.ServerRole, &channelRole); err != nil {
			return nil, err
		}
		h.DisplayName = nullStr(displayName)
		h.Description = nullStr(description)
		h.AvatarURL = nullStr(avatarURL)
		h.GravatarHash = gravatarHash(email.String)
		if channelRole.Valid {
			h.ChannelRole = strPtr(channelRole.String)
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// channelAgentsRaw ports getChannelAgentsRaw: explicit rows joined to live
// agents (deleted agents drop out) with the additive agent_members role.
func (s *Store) channelAgentsRaw(ctx context.Context, channelID string) ([]RosterAgent, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT a.id, a.workspace_id, w.name, w.slug, a.name, a.display_name,
		       a.status, a.avatar_url, ca.role, am.role
		FROM channel_agents ca
		JOIN agents a ON a.id = ca.agent_id
		JOIN workspaces w ON w.id = a.workspace_id
		LEFT JOIN agent_members am ON am.workspace_id = a.workspace_id AND am.agent_id = a.id
		WHERE ca.channel_id = ? AND a.deleted_at IS NULL
		ORDER BY ca.added_at ASC`, channelID)
	if err != nil {
		return nil, fmt.Errorf("read channel agents: %w", err)
	}
	defer rows.Close()
	out := []RosterAgent{}
	for rows.Next() {
		var a RosterAgent
		var displayName, avatarURL, channelRole, serverRole sql.NullString
		if err := rows.Scan(&a.ID, &a.ServerID, &a.ServerName, &a.ServerSlug, &a.Name,
			&displayName, &a.Status, &avatarURL, &channelRole, &serverRole); err != nil {
			return nil, err
		}
		a.DisplayName = nullStr(displayName)
		a.AvatarURL = nullStr(avatarURL)
		if channelRole.Valid {
			a.ChannelRole = strPtr(channelRole.String)
		}
		if serverRole.Valid {
			a.ServerRole = strPtr(serverRole.String)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// getServerAudience ports the virtual #all audience: every non-guest human
// member and every live agent, ordered by membership/creation time.
func (s *Store) getServerAudience(ctx context.Context, workspaceID string) (*Roster, error) {
	humanRows, err := s.db.QueryContext(ctx, `
		SELECT u.id, m.workspace_id, w.name, w.slug, u.name, u.display_name,
		       u.description, u.avatar_url, u.email, m.role
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		JOIN users u ON u.id = m.user_id
		WHERE m.workspace_id = ? AND m.role <> 'guest'
		ORDER BY m.joined_at ASC`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("read server audience humans: %w", err)
	}
	humans := []RosterHuman{}
	defer humanRows.Close()
	for humanRows.Next() {
		var h RosterHuman
		var displayName, description, avatarURL, email sql.NullString
		if err := humanRows.Scan(&h.ID, &h.ServerID, &h.ServerName, &h.ServerSlug, &h.Name,
			&displayName, &description, &avatarURL, &email, &h.ServerRole); err != nil {
			return nil, err
		}
		h.DisplayName = nullStr(displayName)
		h.Description = nullStr(description)
		h.AvatarURL = nullStr(avatarURL)
		h.GravatarHash = gravatarHash(email.String)
		humans = append(humans, h)
	}
	if err := humanRows.Err(); err != nil {
		return nil, err
	}

	agentRows, err := s.db.QueryContext(ctx, `
		SELECT a.id, a.workspace_id, w.name, w.slug, a.name, a.display_name,
		       a.status, a.avatar_url
		FROM agents a
		JOIN workspaces w ON w.id = a.workspace_id
		WHERE a.workspace_id = ? AND a.deleted_at IS NULL
		ORDER BY a.created_at ASC`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("read server audience agents: %w", err)
	}
	agents := []RosterAgent{}
	defer agentRows.Close()
	for agentRows.Next() {
		var a RosterAgent
		var displayName, avatarURL sql.NullString
		if err := agentRows.Scan(&a.ID, &a.ServerID, &a.ServerName, &a.ServerSlug, &a.Name,
			&displayName, &a.Status, &avatarURL); err != nil {
			return nil, err
		}
		a.DisplayName = nullStr(displayName)
		a.AvatarURL = nullStr(avatarURL)
		agents = append(agents, a)
	}
	if err := agentRows.Err(); err != nil {
		return nil, err
	}
	return &Roster{Agents: agents, Humans: humans}, nil
}

// ShouldHideHumanDirectory ports shouldHideHumanDirectoryFromRequester:
// hideHumansFromMembers limits an ordinary member's directory view.
func (s *Store) ShouldHideHumanDirectory(ctx context.Context, workspaceID, requesterID string) (bool, error) {
	var hideHumans int
	var role sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT w.hide_humans_from_members, m.role
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
		workspaceID, requesterID).Scan(&hideHumans, &role)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read directory visibility: %w", err)
	}
	return hideHumans != 0 && role.String == RoleMember, nil
}

// ExposeHumanInHiddenDirectory ports shouldExposeHumanInHiddenDirectory: the
// requester themself, plus community-server owners/admins.
func ExposeHumanInHiddenDirectory(human RosterHuman, requesterID string) bool {
	if requesterID != "" && human.ID == requesterID {
		return true
	}
	return (human.ServerSlug == "community" || human.ServerSlug == "community-cn") &&
		(human.ServerRole == RoleOwner || human.ServerRole == RoleAdmin)
}

func nullStr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	return strPtr(v.String)
}

// gravatarHash mirrors sha256(trim+lowercase(email)).
func gravatarHash(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:])
}
