package delivery

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	platformdb "raft.local/server-go/internal/platform/db"
)

// PlanInput is the locked cross-module planning input (execution lock §3).
// The messaging service calls PlanMessageTx inside the SAME write transaction
// that commits the message and its mention facts, so a failed intent write
// rolls the whole send back. Sender replays never call this method.
type PlanInput struct {
	WorkspaceID string
	MessageID   string
	ChannelID   string
	AgentIDs    []string
}

// PlanMessageTx records one durable logical intent per (message, agent).
//
// Authorization is NOT done here: the messaging use case has already resolved
// the mentions and authorized each recipient. This step performs the fact
// reads that keep the durable rows honest (the message exists in this
// workspace/channel; each agent exists, is not deleted and belongs to this
// workspace) and inserts one pending delivery per deduplicated agent.
//
// Idempotency: the unique key (workspace_id, source_kind, source_id, agent_id)
// makes a repeated row a no-op, so a retried transaction that already planned
// does not duplicate intents.
func (s *Store) PlanMessageTx(ctx context.Context, tx *sql.Tx, input PlanInput) error {
	if tx == nil {
		return fmt.Errorf("%w: nil transaction", ErrInvalidInput)
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.MessageID = strings.TrimSpace(input.MessageID)
	input.ChannelID = strings.TrimSpace(input.ChannelID)
	if input.WorkspaceID == "" || input.MessageID == "" || input.ChannelID == "" {
		return fmt.Errorf("%w: workspace, message and channel are required", ErrInvalidInput)
	}
	agentIDs := dedupeIDs(input.AgentIDs)
	if len(agentIDs) == 0 {
		return fmt.Errorf("%w: at least one agent recipient is required", ErrInvalidInput)
	}

	// Fact read: the message must exist and belong to the claimed channel in
	// the claimed workspace. A mismatch fails the whole send transaction.
	var msgChannel string
	err := tx.QueryRowContext(ctx,
		`SELECT channel_id FROM messages WHERE id = ? AND workspace_id = ?`,
		input.MessageID, input.WorkspaceID).Scan(&msgChannel)
	if err == sql.ErrNoRows {
		return ErrMessageUnknown
	}
	if err != nil {
		return fmt.Errorf("read plan message: %w", err)
	}
	if msgChannel != input.ChannelID {
		return fmt.Errorf("%w: message channel mismatch", ErrMessageUnknown)
	}

	now := s.nowMs()
	for _, agentID := range agentIDs {
		var exists int
		err := tx.QueryRowContext(ctx,
			`SELECT 1 FROM agents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
			agentID, input.WorkspaceID).Scan(&exists)
		if err == sql.ErrNoRows {
			return fmt.Errorf("%w: agent %s not found in workspace", ErrInvalidInput, agentID)
		}
		if err != nil {
			return fmt.Errorf("read plan agent: %w", err)
		}
		if err := s.insertDeliveryTx(ctx, tx, deliveryRow{
			WorkspaceID:    input.WorkspaceID,
			AgentID:        agentID,
			SourceKind:     SourceMessage,
			SourceID:       input.MessageID,
			MessageID:      nullableString(input.MessageID),
			ConversationID: nullableString(input.ChannelID),
			Now:            now,
		}); err != nil {
			return err
		}
	}
	return nil
}

// BriefingPlanInput plans the onboarding briefing hand-off intent. The
// idempotency key is workspace/member/purpose/version: repeated clicks, agent
// activation, machine reconnects and server recovery all collapse into ONE
// durable intent (phase-5-delivery.md §10). The briefing content itself stays
// with the onboarding slice; this row only records "the hand-off still needs
// to be attempted".
type BriefingPlanInput struct {
	WorkspaceID    string
	AgentID        string
	MemberID       string
	Purpose        string
	Version        string
	ConversationID string // may be empty before the DM channel exists
}

// PlanBriefingTx records the briefing control intent (source_kind=briefing).
func (s *Store) PlanBriefingTx(ctx context.Context, tx *sql.Tx, input BriefingPlanInput) error {
	if tx == nil {
		return fmt.Errorf("%w: nil transaction", ErrInvalidInput)
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentID = strings.TrimSpace(input.AgentID)
	input.MemberID = strings.TrimSpace(input.MemberID)
	input.Purpose = strings.TrimSpace(input.Purpose)
	input.Version = strings.TrimSpace(input.Version)
	input.ConversationID = strings.TrimSpace(input.ConversationID)
	if input.WorkspaceID == "" || input.AgentID == "" || input.MemberID == "" ||
		input.Purpose == "" || input.Version == "" {
		return fmt.Errorf("%w: workspace, agent, member, purpose and version are required", ErrInvalidInput)
	}
	if strings.ContainsAny(input.MemberID+input.Purpose+input.Version, "|:") {
		return fmt.Errorf("%w: purpose key characters are reserved", ErrInvalidInput)
	}
	var exists int
	err := tx.QueryRowContext(ctx,
		`SELECT 1 FROM agents WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
		input.AgentID, input.WorkspaceID).Scan(&exists)
	if err == sql.ErrNoRows {
		return fmt.Errorf("%w: agent not found in workspace", ErrInvalidInput)
	}
	if err != nil {
		return fmt.Errorf("read briefing agent: %w", err)
	}
	conversation := sql.NullString{String: input.ConversationID, Valid: input.ConversationID != ""}
	return s.insertDeliveryTx(ctx, tx, deliveryRow{
		WorkspaceID:    input.WorkspaceID,
		AgentID:        input.AgentID,
		SourceKind:     SourceBriefing,
		SourceID:       fmt.Sprintf("briefing:%s:%s:%s", input.MemberID, input.Purpose, input.Version),
		MessageID:      sql.NullString{},
		ConversationID: conversation,
		Now:            s.nowMs(),
	})
}

type deliveryRow struct {
	WorkspaceID    string
	AgentID        string
	SourceKind     string
	SourceID       string
	MessageID      sql.NullString
	ConversationID sql.NullString
	Now            int64
}

// insertDeliveryTx allocates the next delivery_order INSIDE the caller's
// IMMEDIATE transaction (MAX+1 is serialized by the write fence, exactly like
// the messages.seq allocation) and inserts one pending intent. A duplicate
// unique key is a no-op (idempotent re-plan).
func (s *Store) insertDeliveryTx(ctx context.Context, ex platformdb.Executor, row deliveryRow) error {
	var order int64
	if err := ex.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(delivery_order), 0) + 1 FROM agent_deliveries`).Scan(&order); err != nil {
		return fmt.Errorf("allocate delivery order: %w", err)
	}
	id, err := newTokenID()
	if err != nil {
		return fmt.Errorf("mint delivery id: %w", err)
	}
	_, err = ex.ExecContext(ctx, `INSERT INTO agent_deliveries
		(id, delivery_order, workspace_id, agent_id, source_kind, source_id,
		 message_id, conversation_id, scheduling_state, retry_count,
		 next_attempt_at, lease_expires_at, last_error_code, acknowledged_at,
		 revision, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?, 'pending', 0, 0, NULL, NULL, NULL, 1, ?, ?)
		ON CONFLICT (workspace_id, source_kind, source_id, agent_id) DO NOTHING`,
		id, order, row.WorkspaceID, row.AgentID, row.SourceKind, row.SourceID,
		row.MessageID, row.ConversationID, row.Now, row.Now)
	if err != nil {
		return fmt.Errorf("insert delivery: %w", err)
	}
	return nil
}

// dedupeIDs returns trimmed, de-duplicated ids preserving first occurrence.
func dedupeIDs(ids []string) []string {
	seen := make(map[string]bool, len(ids))
	out := make([]string, 0, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}

func nullableString(v string) sql.NullString {
	return sql.NullString{String: v, Valid: v != ""}
}
