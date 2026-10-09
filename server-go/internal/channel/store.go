// Channel persistence: row reads, membership-role resolution, and the list
// use case (including the lazy #all/#announcement guarantees). Writes live in
// service.go/membership.go; all timestamps come from the injected clock.
package channel

import (
	"context"
	"crypto/rand"
	"database/sql"
	"fmt"
	"time"

	"raft.local/server-go/internal/platform/clock"
	platformdb "raft.local/server-go/internal/platform/db"
)

// Executor is satisfied by *sql.DB and *sql.Tx so use cases run inside their
// own transaction without opening a second one. Exported for the transport
// layer and the agent domain (channel roster writes from their transactions).
type Executor interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Options injects the clock.
type Options struct {
	Clock clock.Clock
}

// Store reads and writes channel tables over one SQLite handle.
type Store struct {
	db    *sql.DB
	clock clock.Clock
	// beforeAuthorize, when set, runs inside a write transaction before the
	// callback. Tests use it to demote or unbind the actor on that same
	// transaction so the callback's recheck sees the live rows. Production
	// leaves it nil.
	beforeAuthorize func(context.Context, *sql.Tx)
}

// NewStore uses the real clock.
func NewStore(db *sql.DB) *Store {
	return NewStoreWithOptions(db, Options{Clock: clock.Real{}})
}

// NewStoreWithOptions injects the clock (tests pin it).
func NewStoreWithOptions(db *sql.DB, opts Options) *Store {
	s := &Store{db: db, clock: opts.Clock}
	if s.clock == nil {
		s.clock = clock.Real{}
	}
	return s
}

func (s *Store) now() time.Time { return s.clock.Now() }

// DB exposes the handle for assembly-time wiring (e.g. auth adapters).
func (s *Store) DB() *sql.DB { return s.db }

// AgentExists reports whether the agent identity exists in the workspace,
// reading through the store's own handle (roster-add validation callers no
// longer touch a raw DB accessor).
func (s *Store) AgentExists(ctx context.Context, agentID, workspaceID string) (bool, error) {
	return s.AgentExistsInWorkspace(ctx, s.db, agentID, workspaceID)
}

// withTx runs fn inside one IMMEDIATE transaction and rolls back on error,
// through the shared db.WithWriteTx seam so M4 channel writes hold the
// per-database authority fence through commit (readers using
// db.WithAuthorityRead cannot authorize across that boundary). The optional
// beforeAuthorize hook runs after BEGIN and before fn, on the same
// transaction, so a test demotion is visible to the recheck in fn and rolls
// back with it.
func (s *Store) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	return platformdb.WithWriteTx(ctx, s.db, func(tx *sql.Tx) error {
		if s.beforeAuthorize != nil {
			s.beforeAuthorize(ctx, tx)
		}
		return fn(tx)
	})
}

// newUUID mints the legacy UUIDv4 shape for channel/event ids.
func newUUID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16]), nil
}

// GetChannel reads one live channel row (deleted rows only with
// includeDeleted), regardless of workspace.
func (s *Store) GetChannel(ctx context.Context, id string) (*Channel, error) {
	return s.getChannel(ctx, s.db, id, false)
}

func (s *Store) getChannel(ctx context.Context, ex Executor, id string, includeDeleted bool) (*Channel, error) {
	query := `SELECT ` + channelColumns + ` FROM channels c WHERE c.id = ?`
	if !includeDeleted {
		query += ` AND c.deleted_at IS NULL`
	}
	row := ex.QueryRowContext(ctx, query, id)
	c, err := scanChannel(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read channel %s: %w", id, err)
	}
	return c, nil
}

// GetSystemAllChannel ports getSystemAllChannel: the live #all row of one
// workspace (name=all, type channel|private, not deleted).
func (s *Store) GetSystemAllChannel(ctx context.Context, workspaceID string) (*Channel, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+channelColumns+`
		FROM channels c
		WHERE c.workspace_id = ? AND c.name = ? AND c.type IN (?, ?) AND c.deleted_at IS NULL`,
		workspaceID, systemAllName, TypeChannel, TypePrivate)
	c, err := scanChannel(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read #all channel: %w", err)
	}
	return c, nil
}

// HumanServerRole ports serverService.getMemberRole: the caller's real
// membership role, with deleted workspaces losing their roles. "" = no role.
func (s *Store) HumanServerRole(ctx context.Context, workspaceID, userID string) (string, error) {
	return s.humanServerRole(ctx, s.db, workspaceID, userID)
}

func (s *Store) humanServerRole(ctx context.Context, ex Executor, workspaceID, userID string) (string, error) {
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
		return "", fmt.Errorf("read membership role: %w", err)
	}
	return role, nil
}

// AgentServerRole ports serverService.getAgentMemberRole: the agent's stored
// workspace role; "" = no row (additive projection, never removal).
func (s *Store) AgentServerRole(ctx context.Context, ex Executor, workspaceID, agentID string) (string, error) {
	var role string
	err := ex.QueryRowContext(ctx, `
		SELECT am.role
		FROM agent_members am
		JOIN agents a ON a.id = am.agent_id
		WHERE am.workspace_id = ? AND am.agent_id = ? AND a.workspace_id = ? AND a.deleted_at IS NULL`,
		workspaceID, agentID, workspaceID).Scan(&role)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("read agent membership role: %w", err)
	}
	return role, nil
}

// AgentDirectoryRow is one live agent of a workspace.
type AgentDirectoryRow struct {
	ID          string
	WorkspaceID string
	Name        string
	DisplayName *string
	Status      string
	AvatarURL   *string
}

// AgentExistsInWorkspace ports agentService.getAgent semantics for membership
// validation: the row must exist, be undeleted and belong to this workspace.
func (s *Store) AgentExistsInWorkspace(ctx context.Context, ex Executor, agentID, workspaceID string) (bool, error) {
	var one int
	err := ex.QueryRowContext(ctx, `
		SELECT 1 FROM agents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
		agentID, workspaceID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read agent %s: %w", agentID, err)
	}
	return true, nil
}

// ListItem is one visible channel of the list plus the joined flag.
type ListItem struct {
	Channel Channel
	Joined  bool
}

// ArchivedFilter values for the list route.
const (
	ArchivedExclude = "exclude"
	ArchivedInclude = "include"
	ArchivedOnly    = "only"
)

// ListChannels ports channelService.listChannels for the non-guest paths of
// this policy vector: system channels are lazily ensured (except in "only"
// mode), a hidden #all is omitted, private channels need explicit membership,
// and `joined` derives from the implicit-membership rule plus the roster.
func (s *Store) ListChannels(ctx context.Context, workspaceID, userID, archivedFilter string) ([]ListItem, error) {
	return s.listChannels(ctx, s.db, workspaceID, userID, archivedFilter, true)
}

// ListChannelsTx is the read-only executor variant for callers that pin one
// snapshot for the whole list (and its M4 projections): it performs NO lazy
// system-channel ensure — creating channels inside a caller's read snapshot
// would either fail under query_only or tear the snapshot's consistency.
// Workspaces created since M2 already hold the system rows.
func (s *Store) ListChannelsTx(ctx context.Context, ex Executor, workspaceID, userID, archivedFilter string) ([]ListItem, error) {
	return s.listChannels(ctx, ex, workspaceID, userID, archivedFilter, false)
}

func (s *Store) listChannels(ctx context.Context, ex Executor, workspaceID, userID, archivedFilter string, lazyEnsure bool) ([]ListItem, error) {
	// TS listChannels treats an omitted filter as "exclude".
	if archivedFilter == "" {
		archivedFilter = ArchivedExclude
	}
	conditions := `c.workspace_id = ? AND c.type IN (?, ?, ?) AND c.deleted_at IS NULL`
	args := []any{workspaceID, TypeChannel, TypePrivate, TypeJoint}
	switch archivedFilter {
	case ArchivedExclude:
		conditions += ` AND c.archived_at IS NULL`
	case ArchivedOnly:
		conditions += ` AND c.archived_at IS NOT NULL`
	case ArchivedInclude:
	default:
		return nil, &DomainError{Code: CodeInvalidInput, Message: "archived must be one of: exclude, include, only"}
	}
	rows, err := ex.QueryContext(ctx, `SELECT `+channelColumns+`
		FROM channels c WHERE `+conditions+` ORDER BY c.created_at ASC`, args...)
	if err != nil {
		return nil, fmt.Errorf("list channels: %w", err)
	}
	var list []*Channel
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, c)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	serverRole, err := s.humanServerRole(ctx, ex, workspaceID, userID)
	if err != nil {
		return nil, err
	}

	// "only" never creates channels (the archived view must stay read-only).
	if lazyEnsure && archivedFilter != ArchivedOnly {
		if idx := indexOf(list, func(c *Channel) bool { return IsAllSystemChannel(c) }); idx < 0 {
			all, err := s.ensureAllChannel(ctx, workspaceID)
			if err != nil {
				return nil, err
			}
			list = append(list, all)
		}
		if idx := indexOf(list, func(c *Channel) bool { return IsAnnouncementChannel(c) }); idx < 0 {
			ensured, err := s.ensureAnnouncementChannel(ctx, workspaceID)
			if err != nil {
				return nil, err
			}
			// A user channel that held the reserved name was retired by the
			// ensure; drop it from this response exactly like the TS path.
			filtered := list[:0]
			for _, c := range list {
				if c.Name == announcementName && c.SystemKind == nil {
					continue
				}
				filtered = append(filtered, c)
			}
			list = append(filtered, ensured)
		}
	}

	// A hidden #all is deliberately omitted from ordinary lists.
	visible := make([]*Channel, 0, len(list))
	var allChannel *Channel
	for _, c := range list {
		if IsAllSystemChannel(c) && !IsEnabledAllChannel(c) {
			allChannel = c
			continue
		}
		visible = append(visible, c)
	}
	_ = allChannel

	joinedSet, err := s.humanChannelIDsTx(ctx, ex, userID)
	if err != nil {
		return nil, err
	}

	items := make([]ListItem, 0, len(visible))
	for _, c := range visible {
		// Guests see nothing under the frozen (disabled) guest gate; the
		// implicit-membership channels read as joined for every non-guest.
		if serverRole == RoleGuest {
			continue
		}
		if requiresExplicitMembership(c.Type) && !joinedSet[c.ID] {
			continue
		}
		items = append(items, ListItem{
			Channel: *c,
			Joined:  HasImplicitServerMembership(c) || joinedSet[c.ID],
		})
	}
	return items, nil
}

func indexOf(list []*Channel, pred func(*Channel) bool) int {
	for i, c := range list {
		if pred(c) {
			return i
		}
	}
	return -1
}

// humanChannelIDs reads every channel_humans row of one user (the TS query is
// user-scoped; only same-server channels can intersect the list).
func (s *Store) humanChannelIDs(ctx context.Context, userID string) (map[string]bool, error) {
	return s.humanChannelIDsTx(ctx, s.db, userID)
}

func (s *Store) humanChannelIDsTx(ctx context.Context, ex Executor, userID string) (map[string]bool, error) {
	rows, err := ex.QueryContext(ctx,
		`SELECT channel_id FROM channel_humans WHERE user_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("read channel memberships: %w", err)
	}
	defer rows.Close()
	set := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		set[id] = true
	}
	return set, rows.Err()
}

// ensureAllChannel lazily creates the #all channel for workspaces that
// predate it (M2 creates it eagerly; the lazy path stays for parity).
func (s *Store) ensureAllChannel(ctx context.Context, workspaceID string) (*Channel, error) {
	id, err := newUUID()
	if err != nil {
		return nil, err
	}
	now := s.now().UnixMilli()
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO channels (id, workspace_id, name, description, type, system_kind, created_at)
		VALUES (?, ?, 'all', 'General channel for all members', 'channel', 'all', ?)
		ON CONFLICT DO NOTHING`, id, workspaceID, now); err != nil {
		return nil, fmt.Errorf("ensure #all: %w", err)
	}
	ensured, err := s.GetSystemAllChannel(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	if ensured == nil {
		return nil, fmt.Errorf("failed to ensure the #all channel")
	}
	return ensured, nil
}

// ensureAnnouncementChannel ports channelService.ensureAnnouncementChannel:
// retire a user channel holding the reserved name, then insert the system row
// (the partial unique index arbitrates races).
func (s *Store) ensureAnnouncementChannel(ctx context.Context, workspaceID string) (*Channel, error) {
	live := func() (*Channel, error) {
		row := s.db.QueryRowContext(ctx, `SELECT `+channelColumns+`
			FROM channels c
			WHERE c.workspace_id = ? AND c.system_kind = 'announcement' AND c.deleted_at IS NULL`,
			workspaceID)
		c, err := scanChannel(row)
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return c, err
	}
	existing, err := live()
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing, nil
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE channels SET deleted_at = ?
		WHERE workspace_id = ? AND name = ? AND type IN (?, ?, ?)
		  AND system_kind IS NULL AND deleted_at IS NULL`,
		s.now().UnixMilli(), workspaceID, announcementName, TypeChannel, TypePrivate, TypeJoint); err != nil {
		return nil, fmt.Errorf("retire reserved announcement name: %w", err)
	}
	id, err := newUUID()
	if err != nil {
		return nil, err
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO channels (id, workspace_id, name, description, type, system_kind, created_at)
		VALUES (?, ?, 'announcement', 'Agent progress announcements', 'channel', 'announcement', ?)
		ON CONFLICT DO NOTHING`, id, workspaceID, s.now().UnixMilli()); err != nil {
		return nil, fmt.Errorf("ensure #announcement: %w", err)
	}
	ensured, err := live()
	if err != nil || ensured != nil {
		return ensured, err
	}
	return nil, fmt.Errorf("failed to ensure the #announcement channel")
}
