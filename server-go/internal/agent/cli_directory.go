// Agent-facing directory reads for GET /internal/agent-api/server and
// GET /internal/agent-api/channel-members. Handles are resolved here.
// Callers never supply a principal UUID to name a human or an agent.
package agent

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// DirectoryChannel is one channel row visible to the bound agent.
type DirectoryChannel struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Joined      bool    `json:"joined"`
	Type        string  `json:"type"`
	Description *string `json:"description"`
}

// DirectoryAgent is one agent summary. Role is null for a missing or guest row.
type DirectoryAgent struct {
	Name           string  `json:"name"`
	Description    *string `json:"description"`
	Status         string  `json:"status"`
	Activity       *string `json:"activity"`
	ActivityDetail string  `json:"activityDetail"`
	Role           *string `json:"role"`
}

// DirectoryHuman is one human summary visible to the bound agent.
type DirectoryHuman struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Role        *string `json:"role"`
}

// ServerRuntimeContext is the bound agent's own machine context.
type ServerRuntimeContext struct {
	AgentID            string  `json:"agentId"`
	Runtime            string  `json:"runtime,omitempty"`
	Model              string  `json:"model,omitempty"`
	ReasoningEffort    *string `json:"reasoningEffort"`
	ServerID           string  `json:"serverId"`
	MachineID          *string `json:"machineId"`
	MachineName        *string `json:"machineName"`
	MachineDescription *string `json:"machineDescription"`
	MachineHostname    *string `json:"machineHostname"`
	MachineOS          *string `json:"machineOs"`
	DaemonVersion      *string `json:"daemonVersion"`
	WorkspacePath      *string `json:"workspacePath"`
}

// ServerDirectory is the GET /internal/agent-api/server body.
type ServerDirectory struct {
	RuntimeContext     ServerRuntimeContext `json:"runtimeContext"`
	ServerRole         *string              `json:"serverRole"`
	ServerCapabilities map[string]bool      `json:"serverCapabilities"`
	Channels           []DirectoryChannel   `json:"channels"`
	Agents             []DirectoryAgent     `json:"agents"`
	Humans             []DirectoryHuman     `json:"humans"`
}

// ChannelMemberDirectory is the GET /internal/agent-api/channel-members body.
type ChannelMemberDirectory struct {
	Channel struct {
		Ref  string `json:"ref"`
		Type string `json:"type"`
	} `json:"channel"`
	Agents []DirectoryAgent `json:"agents"`
	Humans []DirectoryHuman `json:"humans"`
}

var messageShortIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}$`)

// ServerDirectoryForAgent lists channels, agents, humans, and the bound
// agent's runtime context inside one workspace. Other workspaces are absent.
func (s *Store) ServerDirectoryForAgent(ctx context.Context, workspaceID, agentID string) (*ServerDirectory, error) {
	loaded, err := s.GetAgent(ctx, agentID, false)
	if err != nil {
		return nil, err
	}
	if loaded == nil || loaded.WorkspaceID != workspaceID {
		return nil, ErrAuthenticatedAgentGone
	}
	role, err := s.AgentMemberRole(ctx, workspaceID, agentID)
	if err != nil {
		return nil, err
	}
	channels, err := s.channelsVisibleToAgent(ctx, workspaceID, agentID)
	if err != nil {
		return nil, err
	}
	agents, err := s.directoryAgents(ctx, workspaceID, "")
	if err != nil {
		return nil, err
	}
	humans, err := s.directoryHumans(ctx, workspaceID, agentID, "")
	if err != nil {
		return nil, err
	}
	runtime := ServerRuntimeContext{
		AgentID:         loaded.ID,
		Runtime:         loaded.Runtime,
		Model:           loaded.Model,
		ReasoningEffort: nullString(loaded.ReasoningEffort),
		ServerID:        loaded.WorkspaceID,
		MachineID:       nullString(loaded.MachineID),
	}
	if loaded.MachineID.Valid {
		machine, err := s.GetMachine(ctx, workspaceID, loaded.MachineID.String)
		if err != nil {
			return nil, err
		}
		if machine != nil {
			name := machine.Name
			runtime.MachineName = &name
			runtime.MachineDescription = nullString(machine.Description)
			runtime.MachineHostname = nullString(machine.Hostname)
			runtime.MachineOS = nullString(machine.OS)
			runtime.DaemonVersion = nullString(machine.DaemonVer)
		}
	}
	roleName := ""
	if role != nil {
		roleName = *role
	}
	if channels == nil {
		channels = []DirectoryChannel{}
	}
	if agents == nil {
		agents = []DirectoryAgent{}
	}
	if humans == nil {
		humans = []DirectoryHuman{}
	}
	return &ServerDirectory{
		RuntimeContext:     runtime,
		ServerRole:         role,
		ServerCapabilities: ServerCapabilities(roleName),
		Channels:           channels,
		Agents:             agents,
		Humans:             humans,
	}, nil
}

// ChannelMembersForAgent resolves a channel handle inside the credential's
// workspace and returns the visible roster. A handle the agent cannot see
// is a not-found, including a same-name channel in another workspace.
func (s *Store) ChannelMembersForAgent(ctx context.Context, workspaceID, agentID, channelRef string) (*ChannelMemberDirectory, error) {
	resolved, err := s.resolveAgentChannel(ctx, workspaceID, agentID, channelRef)
	if err != nil {
		return nil, err
	}
	if resolved == nil {
		return nil, errf(404, "channel_not_found", "Channel not found: "+channelRef)
	}
	agents, err := s.directoryAgents(ctx, workspaceID, resolved.ID)
	if err != nil {
		return nil, err
	}
	humans, err := s.directoryHumans(ctx, workspaceID, agentID, resolved.ID)
	if err != nil {
		return nil, err
	}
	if agents == nil {
		agents = []DirectoryAgent{}
	}
	if humans == nil {
		humans = []DirectoryHuman{}
	}
	out := &ChannelMemberDirectory{Agents: agents, Humans: humans}
	out.Channel.Ref = channelRef
	out.Channel.Type = resolved.Type
	return out, nil
}

type resolvedChannel struct {
	ID   string
	Type string
	Name string
}

func (s *Store) resolveAgentChannel(ctx context.Context, workspaceID, agentID, channelRef string) (*resolvedChannel, error) {
	base, threadShort := parseChannelRef(channelRef)
	if threadShort != "" {
		// Thread anchors need the message table. M3 has no such rows, so a
		// thread handle is not found rather than a parent-channel substitute.
		return nil, nil
	}
	if strings.HasPrefix(channelRef, "DM:@") || strings.HasPrefix(channelRef, "dm:@") {
		return s.resolveDMByPeerName(ctx, workspaceID, agentID, base[4:])
	}
	if strings.HasPrefix(channelRef, "#") {
		return s.resolveNamedChannel(ctx, workspaceID, agentID, base[1:])
	}
	return nil, nil
}

func parseChannelRef(channelRef string) (base, threadShort string) {
	withSuffix := func(prefix, rest string) (string, string) {
		last := strings.LastIndex(rest, ":")
		if last > 0 && messageShortIDPattern.MatchString(rest[last+1:]) {
			return prefix + rest[:last], rest[last+1:]
		}
		return prefix + rest, ""
	}
	if strings.HasPrefix(channelRef, "DM:@") || strings.HasPrefix(channelRef, "dm:@") {
		return withSuffix(channelRef[:4], channelRef[4:])
	}
	if strings.HasPrefix(channelRef, "#") {
		return withSuffix("#", channelRef[1:])
	}
	return channelRef, ""
}

func (s *Store) resolveNamedChannel(ctx context.Context, workspaceID, agentID, name string) (*resolvedChannel, error) {
	var row resolvedChannel
	var systemKind sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT id, type, name, system_kind FROM channels
		WHERE workspace_id = ? AND name = ? AND type IN ('channel', 'private', 'joint')
		  AND deleted_at IS NULL`, workspaceID, name).Scan(&row.ID, &row.Type, &row.Name, &systemKind)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolve channel: %w", err)
	}
	if row.Name == "all" && row.Type != "channel" {
		return nil, nil
	}
	if row.Type == "private" || row.Type == "joint" {
		member, err := s.agentInChannel(ctx, row.ID, agentID)
		if err != nil || !member {
			return nil, err
		}
	}
	return &row, nil
}

func (s *Store) resolveDMByPeerName(ctx context.Context, workspaceID, agentID, peerName string) (*resolvedChannel, error) {
	if peerName == "" {
		return nil, nil
	}
	var userID string
	err := s.db.QueryRowContext(ctx, `
		SELECT u.id FROM users u
		JOIN workspace_memberships m ON m.user_id = u.id
		WHERE m.workspace_id = ? AND u.name = ?`, workspaceID, peerName).Scan(&userID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("resolve dm user: %w", err)
	}
	if err == nil {
		var row resolvedChannel
		err = s.db.QueryRowContext(ctx, `
			SELECT c.id, c.type, c.name FROM channels c
			JOIN channel_agents ca ON ca.channel_id = c.id AND ca.agent_id = ?
			JOIN channel_humans ch ON ch.channel_id = c.id AND ch.user_id = ?
			WHERE c.workspace_id = ? AND c.type = 'dm' AND c.deleted_at IS NULL`,
			agentID, userID, workspaceID).Scan(&row.ID, &row.Type, &row.Name)
		if err == nil {
			return &row, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("resolve user dm: %w", err)
		}
	}
	var peerID string
	err = s.db.QueryRowContext(ctx, `
		SELECT id FROM agents WHERE workspace_id = ? AND name = ? AND deleted_at IS NULL`,
		workspaceID, peerName).Scan(&peerID)
	if errors.Is(err, sql.ErrNoRows) || peerID == "" || peerID == agentID {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolve dm agent: %w", err)
	}
	var row resolvedChannel
	err = s.db.QueryRowContext(ctx, `
		SELECT c.id, c.type, c.name FROM channels c
		JOIN channel_agents self ON self.channel_id = c.id AND self.agent_id = ?
		JOIN channel_agents peer ON peer.channel_id = c.id AND peer.agent_id = ?
		WHERE c.workspace_id = ? AND c.type = 'dm' AND c.deleted_at IS NULL
		  AND NOT EXISTS (SELECT 1 FROM channel_humans h WHERE h.channel_id = c.id)`,
		agentID, peerID, workspaceID).Scan(&row.ID, &row.Type, &row.Name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("resolve agent dm: %w", err)
	}
	return &row, nil
}

func (s *Store) channelsVisibleToAgent(ctx context.Context, workspaceID, agentID string) ([]DirectoryChannel, error) {
	joined, err := s.agentChannelSet(ctx, agentID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, description, type, system_kind FROM channels
		WHERE workspace_id = ? AND deleted_at IS NULL AND archived_at IS NULL
		  AND type IN ('channel', 'private', 'joint')
		ORDER BY created_at ASC`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list agent channels: %w", err)
	}
	defer rows.Close()
	var out []DirectoryChannel
	for rows.Next() {
		var id, name, typ string
		var description, systemKind sql.NullString
		if err := rows.Scan(&id, &name, &description, &typ, &systemKind); err != nil {
			return nil, err
		}
		implicit := channelImplicit(name, typ, systemKind.String)
		if (typ == "private" || typ == "joint") && !joined[id] {
			continue
		}
		if name == "all" && typ != "channel" {
			continue
		}
		out = append(out, DirectoryChannel{
			ID: id, Name: name, Joined: implicit || joined[id], Type: typ,
			Description: nullString(description),
		})
	}
	return out, rows.Err()
}

func channelImplicit(name, typ, systemKind string) bool {
	if name == "all" && typ == "channel" {
		return true
	}
	return systemKind == "announcement" && typ == "channel"
}

func (s *Store) agentChannelSet(ctx context.Context, agentID string) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT channel_id FROM channel_agents WHERE agent_id = ?`, agentID)
	if err != nil {
		return nil, fmt.Errorf("list agent channel membership: %w", err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func (s *Store) agentInChannel(ctx context.Context, channelID, agentID string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1 FROM channel_agents WHERE channel_id = ? AND agent_id = ?`, channelID, agentID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("channel membership: %w", err)
	}
	return true, nil
}

func (s *Store) directoryAgents(ctx context.Context, workspaceID, channelID string) ([]DirectoryAgent, error) {
	query := `
		SELECT a.name, a.description, a.status, am.role
		FROM agents a
		LEFT JOIN agent_members am ON am.agent_id = a.id AND am.workspace_id = a.workspace_id
		WHERE a.workspace_id = ? AND a.deleted_at IS NULL`
	args := []any{workspaceID}
	if channelID != "" && !s.channelHasImplicitAudience(ctx, channelID) {
		query += ` AND EXISTS (SELECT 1 FROM channel_agents ca WHERE ca.channel_id = ? AND ca.agent_id = a.id)`
		args = append(args, channelID)
	}
	query += ` ORDER BY a.created_at ASC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list directory agents: %w", err)
	}
	defer rows.Close()
	var out []DirectoryAgent
	for rows.Next() {
		var row DirectoryAgent
		var description, role sql.NullString
		if err := rows.Scan(&row.Name, &description, &row.Status, &role); err != nil {
			return nil, err
		}
		row.Description = nullString(description)
		row.ActivityDetail = ""
		if role.Valid && role.String != RoleGuest {
			value := role.String
			row.Role = &value
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (s *Store) directoryHumans(ctx context.Context, workspaceID, agentID, channelID string) ([]DirectoryHuman, error) {
	hide, slug, err := s.agentHidesHumanDirectory(ctx, workspaceID, agentID)
	if err != nil {
		return nil, err
	}
	query := `
		SELECT u.id, u.name, u.description, m.role
		FROM workspace_memberships m
		JOIN users u ON u.id = m.user_id
		WHERE m.workspace_id = ?`
	args := []any{workspaceID}
	if channelID != "" && !s.channelHasImplicitAudience(ctx, channelID) {
		query += ` AND EXISTS (SELECT 1 FROM channel_humans ch WHERE ch.channel_id = ? AND ch.user_id = u.id)`
		args = append(args, channelID)
	}
	query += ` ORDER BY u.name ASC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list directory humans: %w", err)
	}
	defer rows.Close()
	var out []DirectoryHuman
	for rows.Next() {
		var id, name, role string
		var description sql.NullString
		if err := rows.Scan(&id, &name, &description, &role); err != nil {
			return nil, err
		}
		if hide && !exposeHiddenHuman(slug, role) {
			continue
		}
		value := role
		out = append(out, DirectoryHuman{
			Name: name, Description: nullString(description), Role: &value,
		})
	}
	return out, rows.Err()
}

func (s *Store) channelHasImplicitAudience(ctx context.Context, channelID string) bool {
	var name, typ string
	var systemKind sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT name, type, system_kind FROM channels WHERE id = ?`, channelID).
		Scan(&name, &typ, &systemKind)
	if err != nil {
		return false
	}
	return channelImplicit(name, typ, systemKind.String)
}

func (s *Store) agentHidesHumanDirectory(ctx context.Context, workspaceID, agentID string) (bool, string, error) {
	var hide int
	var slug string
	var role sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT w.hide_humans_from_members, w.slug, am.role
		FROM workspaces w
		LEFT JOIN agent_members am ON am.workspace_id = w.id AND am.agent_id = ?
		WHERE w.id = ? AND w.deleted_at IS NULL`, agentID, workspaceID).Scan(&hide, &slug, &role)
	if errors.Is(err, sql.ErrNoRows) {
		return true, "", nil
	}
	if err != nil {
		return false, "", fmt.Errorf("read human directory policy: %w", err)
	}
	// Only an exact admin membership bypasses a hidden directory. A missing
	// role fails closed.
	return hide != 0 && role.String != RoleAdmin, slug, nil
}

func exposeHiddenHuman(slug, role string) bool {
	return (slug == "community" || slug == "community-cn") && (role == RoleOwner || role == RoleAdmin)
}
