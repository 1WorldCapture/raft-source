package workspace

import (
	"context"
	"database/sql"
	"fmt"

	platformdb "raft.local/server-go/internal/platform/db"
)

// DB exposes the fact store's database only for immutable same-database
// construction checks. Application services still use the domain's methods,
// not its tables, for every mutation.
func (s *Store) DB() *sql.DB { return s.db }

// OwnerBriefing is the current, minimal fact set needed to hand an owner to
// the workspace's explicitly configured onboarding Agent. It contains no
// credentials, email address or private survey free text. The notice itself
// is Agent-only; ChannelID is reply context, not permission to publish the
// internal instruction into chat history.
type OwnerBriefing struct {
	WorkspaceID string
	MemberID    string
	AgentID     string
	ChannelID   string
	ChannelName string
	UserName    string
	DisplayName string
	SignupRole  string
	HandoffAt   int64
	ReportedAt  *int64
}

const ownerBriefingColumns = `w.id, w.owner_id, w.onboarding_agent_id,
	c.id, c.name, u.name, COALESCE(u.display_name, u.name),
	COALESCE(u.signup_role, ''), s.handoff_acknowledged_at, p.onboarding_dm_sent_at`

// Both discovery and final dispatch revalidation use this one eligibility
// predicate. An early handoff click is a real fact but not a complete setup;
// it becomes deliverable only after the existing setup transition succeeds.
const ownerBriefingFrom = `
	FROM workspaces w
	JOIN workspace_memberships wm ON wm.workspace_id = w.id AND wm.user_id = w.owner_id
	JOIN workspace_member_setup s ON s.workspace_id = w.id AND s.user_id = w.owner_id
	JOIN workspace_member_preferences p ON p.workspace_id = w.id AND p.user_id = w.owner_id
	JOIN users u ON u.id = w.owner_id
	JOIN agents a ON a.id = w.onboarding_agent_id AND a.workspace_id = w.id
	JOIN channels c ON c.workspace_id = w.id AND c.name = 'all' AND c.type = 'channel'
	WHERE w.deleted_at IS NULL AND w.kind <> 'joint_storage'
	  AND wm.role IN ('owner', 'admin')
	  AND s.status = 'complete' AND s.handoff_acknowledged_at IS NOT NULL
	  AND u.email_verified = 1 AND u.profile_setup_completed_at IS NOT NULL
	  AND a.deleted_at IS NULL
	  AND c.deleted_at IS NULL AND c.archived_at IS NULL`

func scanOwnerBriefing(row interface{ Scan(...any) error }) (*OwnerBriefing, error) {
	var b OwnerBriefing
	var reported sql.NullInt64
	if err := row.Scan(&b.WorkspaceID, &b.MemberID, &b.AgentID,
		&b.ChannelID, &b.ChannelName, &b.UserName, &b.DisplayName,
		&b.SignupRole, &b.HandoffAt, &reported); err != nil {
		return nil, err
	}
	if reported.Valid {
		value := reported.Int64
		b.ReportedAt = &value
	}
	return &b, nil
}

// PendingOwnerBriefingsTx reads bounded candidates on the caller's snapshot
// or write transaction. It never marks delivery successful and does not
// create channels, messages, Agent membership or a completed setup.
func (s *Store) PendingOwnerBriefingsTx(ctx context.Context, ex platformdb.Executor, limit int) ([]OwnerBriefing, error) {
	return s.PendingOwnerBriefingsAfterTx(ctx, ex, "", limit)
}

// PendingOwnerBriefingsAfterTx is the bounded keyset form used by the pump.
// Existing but still unacknowledged intents must not permanently occupy the
// first page and starve newly created workspaces. The cursor is only scan
// acceleration; every source and receipt remains durable in SQLite.
func (s *Store) PendingOwnerBriefingsAfterTx(ctx context.Context, ex platformdb.Executor, afterWorkspaceID string, limit int) ([]OwnerBriefing, error) {
	if ex == nil {
		return nil, fmt.Errorf("workspace: briefing discovery requires an executor")
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	rows, err := ex.QueryContext(ctx, `SELECT `+ownerBriefingColumns+ownerBriefingFrom+`
		AND p.onboarding_dm_sent_at IS NULL AND w.id > ?
		ORDER BY w.id LIMIT ?`, afterWorkspaceID, limit)
	if err != nil {
		return nil, fmt.Errorf("list owner briefing candidates: %w", err)
	}
	defer rows.Close()
	out := make([]OwnerBriefing, 0)
	for rows.Next() {
		b, err := scanOwnerBriefing(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *b)
	}
	return out, rows.Err()
}

// OwnerBriefingTx revalidates the immutable recipient/owner/channel binding
// against CURRENT workspace facts. A changed owner, designated Agent, hidden
// #all or withdrawn membership makes a queued old briefing ineligible. A
// previously reported receipt remains readable for idempotent finalization.
func (s *Store) OwnerBriefingTx(ctx context.Context, ex platformdb.Executor, workspaceID, memberID, agentID, channelID string) (*OwnerBriefing, error) {
	if ex == nil {
		return nil, fmt.Errorf("workspace: briefing lookup requires an executor")
	}
	if workspaceID == "" || memberID == "" || agentID == "" || channelID == "" {
		return nil, nil
	}
	b, err := scanOwnerBriefing(ex.QueryRowContext(ctx, `SELECT `+ownerBriefingColumns+ownerBriefingFrom+`
		AND w.id = ? AND w.owner_id = ? AND w.onboarding_agent_id = ? AND c.id = ?`,
		workspaceID, memberID, agentID, channelID))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("revalidate owner briefing: %w", err)
	}
	return b, nil
}

// MarkOwnerBriefingReportedTx records the existing client-facing delivery
// fields only after the application supplies a matched durable receipt. The
// supplied timestamp is the receipt observation, NOT model consumption or a
// completed task. The first successful report wins; repeated reconciliation
// does not refresh it or change the Agent attribution.
func (s *Store) MarkOwnerBriefingReportedTx(ctx context.Context, tx *sql.Tx, workspaceID, memberID, agentID, channelID string, reportedAt int64) (bool, error) {
	if tx == nil || reportedAt <= 0 {
		return false, fmt.Errorf("workspace: briefing receipt requires a transaction and positive timestamp")
	}
	b, err := s.OwnerBriefingTx(ctx, tx, workspaceID, memberID, agentID, channelID)
	if err != nil || b == nil {
		return false, err
	}
	if b.ReportedAt != nil {
		return false, nil
	}
	if reportedAt < b.HandoffAt {
		return false, fmt.Errorf("workspace: briefing receipt predates its handoff")
	}
	result, err := tx.ExecContext(ctx, `UPDATE workspace_member_preferences
		SET onboarding_dm_sent_at = ?, onboarding_dm_sent_by_agent_id = ?
		WHERE workspace_id = ? AND user_id = ? AND onboarding_dm_sent_at IS NULL`,
		reportedAt, agentID, workspaceID, memberID)
	if err != nil {
		return false, fmt.Errorf("record reported owner briefing: %w", err)
	}
	changed, err := result.RowsAffected()
	return changed > 0, err
}
