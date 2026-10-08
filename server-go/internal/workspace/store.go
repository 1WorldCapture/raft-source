// Package workspace owns the M2 workspace foundation: real creation with the
// legacy side effects, membership reads, account-level ordering and the basic
// profile surface. External clients keep seeing "servers"; workspace is the
// internal domain name only.
package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
)

// executor is satisfied by *sql.DB and *sql.Tx so use cases can run queries
// inside their own transaction without opening a second one.
type executor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// MachineStatusProbe reports live connection state. It must be a bounded
// local read, not a network call: setup may ask while holding a read snapshot.
type MachineStatusProbe func(context.Context, string) (bool, error)

// Options injects the clock, feature policy and this instance's live presence.
type Options struct {
	Clock              clock.Clock
	Policy             Policy
	MachineStatusProbe MachineStatusProbe
	MachineMetadata    MachineMetadataProbe
	// OnComputerRevoked retires an established machine connection after a
	// setup reset commits. Never called while holding the SQLite transaction.
	OnComputerRevoked func(machineID string)
}

// Store reads and writes workspace tables.
type Store struct {
	db                 *sql.DB
	clock              clock.Clock
	policy             Policy
	machineStatusProbe MachineStatusProbe
	machineMetadata    MachineMetadataProbe
	onComputerRevoked  func(string)
}

// NewStore wraps the database with the real clock and the C0 policy (all
// flags false). Production wiring that needs a different vector uses
// NewStoreWithOptions.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db, clock: clock.Real{}, policy: Policy{}}
}

// NewStoreWithOptions wraps the database with an injected clock and policy.
func NewStoreWithOptions(db *sql.DB, opts Options) *Store {
	s := &Store{
		db: db, policy: opts.Policy,
		machineStatusProbe: opts.MachineStatusProbe, machineMetadata: opts.MachineMetadata,
		onComputerRevoked: opts.OnComputerRevoked,
	}
	s.clock = opts.Clock
	if s.clock == nil {
		s.clock = clock.Real{}
	}
	return s
}

// now is the single time source for every workspace write.
func (s *Store) now() time.Time { return s.clock.Now() }

// withTx runs fn inside one transaction (IMMEDIATE via the shared DSN) and
// rolls back on error. Transactions belong to use cases; channel and audit
// writers accept the tx and never open their own.
func (s *Store) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	return platformdb.WithWriteTx(ctx, s.db, fn)
}

// workspaceColumns is the full external ServerRecord column set.
const workspaceColumns = `w.id, w.name, w.avatar_url, w.slug, w.kind, w.owner_id,
	w.onboarding_agent_id, w.agent_all_channel_greeting_enabled, w.hide_humans_from_members,
	w.publicly_visible, w.plan, w.translation_enabled, w.progress_announcements_enabled,
	w.plan_downgraded_at, w.deleted_at, w.created_at, w.updated_at`

// scanWorkspace reads one full row into a ServerRecord.
func scanWorkspace(scanner interface{ Scan(dest ...any) error }) (ServerRecord, error) {
	var r ServerRecord
	var avatarURL, onboardingAgent sql.NullString
	var planDowngraded, deletedAt, updatedAt sql.NullInt64
	var greeting, hideHumans, publiclyVisible, translation, progressAnnouncements int
	var createdAt int64
	if err := scanner.Scan(&r.ID, &r.Name, &avatarURL, &r.Slug, &r.Kind, &r.OwnerID,
		&onboardingAgent, &greeting, &hideHumans, &publiclyVisible, &r.Plan,
		&translation, &progressAnnouncements, &planDowngraded, &deletedAt,
		&createdAt, &updatedAt); err != nil {
		return ServerRecord{}, err
	}
	if avatarURL.Valid {
		v := avatarURL.String
		r.AvatarURL = &v
	}
	if onboardingAgent.Valid {
		v := onboardingAgent.String
		r.OnboardingAgentID = &v
	}
	r.AgentAllChannelGreetingEnabled = greeting != 0
	r.HideHumansFromMembers = hideHumans != 0
	r.PubliclyVisible = publiclyVisible != 0
	r.TranslationEnabled = translation != 0
	r.ProgressAnnouncementsEnabled = progressAnnouncements != 0
	if planDowngraded.Valid {
		t := time.UnixMilli(planDowngraded.Int64).UTC()
		r.PlanDowngradedAt = &t
	}
	if deletedAt.Valid {
		t := time.UnixMilli(deletedAt.Int64).UTC()
		r.DeletedAt = &t
	}
	r.CreatedAt = time.UnixMilli(createdAt).UTC()
	if !updatedAt.Valid {
		return ServerRecord{}, fmt.Errorf("workspace %s has no updated_at", r.ID)
	}
	r.UpdatedAt = time.UnixMilli(updatedAt.Int64).UTC()
	return r, nil
}

// GetWorkspace returns the live workspace row (ID lookup only — no slug
// fallback); joint_storage and deleted rows are not visible.
func (s *Store) GetWorkspace(ctx context.Context, workspaceID string) (ServerRecord, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+workspaceColumns+`
		FROM workspaces w
		WHERE w.id = ? AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`, workspaceID)
	record, err := scanWorkspace(row)
	if err == sql.ErrNoRows {
		return ServerRecord{}, &DomainError{Code: CodeNotFound, Message: "Server not found"}
	}
	return record, err
}

// membershipColumns is the list-item projection from the membership join.
const membershipColumns = `w.id, w.name, w.avatar_url, w.slug, w.owner_id, w.onboarding_agent_id,
	w.hide_humans_from_members, w.plan, w.plan_downgraded_at,
	m.role, m.server_push_muted, w.created_at`

const membershipJoin = `
	FROM workspace_memberships m
	JOIN workspaces w ON w.id = m.workspace_id
	WHERE m.user_id = ? AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'
	ORDER BY m.joined_at ASC, w.id ASC`

func scanMembership(scanner interface{ Scan(dest ...any) error }) (Membership, error) {
	var m Membership
	var avatarURL, onboardingAgent sql.NullString
	var planDowngraded sql.NullInt64
	var hideHumans, pushMuted int
	var createdAt int64
	if err := scanner.Scan(&m.ID, &m.Name, &avatarURL, &m.Slug, &m.OwnerID, &onboardingAgent,
		&hideHumans, &m.Plan, &planDowngraded, &m.Role, &pushMuted, &createdAt); err != nil {
		return Membership{}, err
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
	return m, nil
}

// ListUserServers returns every eligible workspace the user belongs to
// (deleted and joint_storage excluded), ordered by the account-level saved
// order first and join time second, with the order version stamped on every
// row. An empty result is a real business answer, never a placeholder.
func (s *Store) ListUserServers(ctx context.Context, userID string) ([]Membership, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+membershipColumns+membershipJoin, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	memberships := []Membership{}
	for rows.Next() {
		m, err := scanMembership(rows)
		if err != nil {
			return nil, err
		}
		memberships = append(memberships, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	saved, version, err := s.readSavedOrder(ctx, s.db, userID)
	if err != nil {
		return nil, err
	}
	for i := range memberships {
		memberships[i].ServerOrderVersion = version
	}
	return reorderMemberships(memberships, saved), nil
}

// membershipIDs projects the join order of the memberships.
func membershipIDs(memberships []Membership) []string {
	ids := make([]string, len(memberships))
	for i, m := range memberships {
		ids[i] = m.ID
	}
	return ids
}

// reorderMemberships applies the saved account order (filtered, deduped, then
// join order) to the join-ordered rows and stamps nothing else.
func reorderMemberships(memberships []Membership, saved []string) []Membership {
	byID := make(map[string]Membership, len(memberships))
	for _, m := range memberships {
		byID[m.ID] = m
	}
	orderedIDs := orderIDs(membershipIDs(memberships), saved)
	out := make([]Membership, 0, len(memberships))
	seen := make(map[string]bool, len(memberships))
	for _, id := range orderedIDs {
		if m, ok := byID[id]; ok && !seen[id] {
			out = append(out, m)
			seen[id] = true
		}
	}
	return out
}

// CountMemberships supports readiness/diagnostics.
func (s *Store) CountMemberships(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspace_memberships`).Scan(&n)
	return n, err
}

// GetMembership returns the caller's real membership for the workspace,
// filtering deleted and joint_storage workspaces; lack of an eligible
// membership is FORBIDDEN (the legacy scope middleware answer).
func (s *Store) GetMembership(ctx context.Context, workspaceID, userID string) (Membership, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+membershipColumns+`
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ?
		  AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`, workspaceID, userID)
	membership, err := scanMembership(row)
	if err == sql.ErrNoRows {
		return Membership{}, &DomainError{Code: CodeForbidden, Message: "Not a member of this server"}
	}
	return membership, err
}

// memberRole resolves the caller's role inside a transaction (TS
// getMemberRole: deleted workspaces lose their roles; roles otherwise come
// from the real membership row, never from an ownerId guess).
func (s *Store) memberRole(ctx context.Context, ex executor, workspaceID, userID string) (string, error) {
	var role string
	err := ex.QueryRowContext(ctx, `
		SELECT m.role
		FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
		workspaceID, userID).Scan(&role)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return role, nil
}
