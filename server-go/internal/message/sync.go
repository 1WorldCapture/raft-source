package message

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"time"
)

// Sync budgets. The page caps mirror the TS constants (HTTP 200/500, resume
// 500). The HTTP scan has NO fixed row/channel quota: it pre-filters channels
// through the channel worker's reusable subscription SQL (the original
// syncMessages visibility condition — never a second policy copy) and scans
// every needed row until the page fills or the snapshot ends, bounded only
// by a context deadline that may fail explicitly under load. The RESUME
// envelope keeps its row/channel budgets because its cursor contract
// (currentSeq progress) makes budget exhaustion always advanceable.
const (
	SyncDefaultLimit  = 200
	SyncMaxLimit      = 500
	ResumeLimit       = 500
	syncScanRowBudget = 20000
	// SyncScanDeadline bounds one HTTP scan pass. Exceeding it is a
	// transient, retryable failure — never a permanent exclusion of a large
	// but legal history.
	SyncScanDeadline = 15 * time.Second
	// subscriptionChunk keeps the channel_id IN (...) bind list small.
	subscriptionChunk = 500
)

// ErrSyncDeadlineExceeded marks a deadline-bounded HTTP scan that did not
// finish; the transport renders the explicit retryable typed failure.
var ErrSyncDeadlineExceeded = errors.New("sync scan deadline exceeded")

// SyncResult is the visibility-correct message stream slice. Messages are the
// wire array itself on the HTTP surface; CoveredThrough is the seq through
// which every row has been examined (the resume envelope's currentSeq). DTOs
// are projected on the same snapshot as the scan.
type SyncResult struct {
	Messages       []*Message
	Projections    []*Projection
	CoveredThrough int64
	HighWater      int64
	HasMore        bool
	// BudgetExhausted means the scan stopped on its work budget BEFORE
	// filling the page or reaching H. The bare-array HTTP surface must NOT
	// render this as a short success page (the original client stops on a
	// short page and would strand the unscanned visible rows); its transport
	// answers the explicit typed failure instead. The resume envelope keeps
	// making honest progress via CoveredThrough/HasMore.
	BudgetExhausted bool
}

// requireWorkspaceMembership refuses callers with no current membership of
// the workspace, even when the workspace (or the caller's stream) is empty —
// an empty answer must never be indistinguishable from "not a member".
// Read-only existence fact, same shape as the transport scope middleware.
func (s *Store) requireWorkspaceMembership(ctx context.Context, ex dbExecutor, workspaceID, userID string) error {
	var one int
	err := ex.QueryRowContext(ctx, `
		SELECT 1 FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND m.user_id = ?
		  AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`,
		workspaceID, userID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotServerMember
	}
	return err
}

// SyncHTTP serves the bare-array HTTP surface: membership-enforced,
// subscription-prefiltered, deadline-bounded, with NO fixed scan quota. A
// sparse dataset behind tens of thousands of invisible rows or hundreds of
// invisible channels is still fully readable: those channels are excluded by
// the reusable channel authority SQL before the LIMIT, so the scan only ever
// walks rows the viewer may actually stream.
func (s *Store) SyncHTTP(ctx context.Context, claims Claims, workspaceID string, sinceSeq int64, channelID string, limit int) (*SyncResult, error) {
	if limit <= 0 {
		limit = SyncDefaultLimit
	}
	if limit > SyncMaxLimit {
		limit = SyncMaxLimit
	}
	ctx, cancel := context.WithTimeout(ctx, SyncScanDeadline)
	defer cancel()

	var result *SyncResult
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		if err := s.validateHuman(ctx, ex, claims.claims); err != nil {
			return err
		}
		if err := s.requireWorkspaceMembership(ctx, ex, workspaceID, claims.userID); err != nil {
			return err
		}
		if channelID != "" {
			// Channel-scoped path: one bounded single-channel query with the
			// base+interest audience check and the legacy deny split.
			ok, err := s.syncAudience(ctx, ex, workspaceID, channelID, claims.userID)
			if err != nil {
				if errors.Is(err, ErrConversationDenied) {
					return err
				}
				return err
			}
			if !ok {
				if _, err := s.authorizeRead(ctx, ex, workspaceID, channelID, claims.userID); err != nil {
					return err
				}
				result = &SyncResult{Messages: []*Message{}, Projections: []*Projection{}, CoveredThrough: sinceSeq}
				return nil
			}
		}
		var err error
		result, err = s.scanStream(ctx, ex, workspaceID, sinceSeq, channelID, limit, claims.userID, false)
		if err != nil {
			return err
		}
		result.Projections, err = s.ProjectMessages(ctx, ex, workspaceID, result.Messages)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// scanStream is the shared scanner. When budgeted is false (HTTP) there is
// no row/channel quota — only the context deadline; when budgeted is true
// (resume envelope) the classic budgets keep the envelope bounded and the
// cursor always advanceable. Channels are pre-filtered through
// channel.ListSubscriptionsTx (the reusable original visibility SQL); the
// per-channel memo is an LRU-bounded fallback, never the primary filter.
func (s *Store) scanStream(ctx context.Context, ex dbExecutor, workspaceID string, sinceSeq int64, channelID string, limit int, userID string, budgeted bool) (*SyncResult, error) {
	high := int64(0)
	if err := ex.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq),0) FROM messages WHERE workspace_id = ?`,
		workspaceID).Scan(&high); err != nil {
		return nil, fmt.Errorf("sync high-water: %w", err)
	}
	result := &SyncResult{Messages: []*Message{}, CoveredThrough: sinceSeq, HighWater: high}
	if sinceSeq >= high {
		return result, nil
	}

	// The subscription set is the authority filter (channel-worker SQL).
	subscriptions := []string{channelID}
	if channelID == "" {
		var err error
		subscriptions, err = s.channels.ListSubscriptionsTx(ctx, ex, workspaceID, userID)
		if err != nil {
			return nil, normalizeChannelError(err)
		}
	}
	if len(subscriptions) == 0 {
		// Nothing streamable: the range is fully examined by definition.
		result.CoveredThrough = high
		return result, nil
	}

	// The subscription prefilter IS the authority check on this path (the
	// channel worker's SQL set). No per-channel callback loop and therefore
	// no memo is needed; invisible channels never reach the LIMIT at all.
	scanned := 0
	cursor := sinceSeq
	const batch = 500
	for cursor < high {
		if err := ctx.Err(); err != nil {
			return nil, ErrSyncDeadlineExceeded
		}
		if budgeted && scanned >= syncScanRowBudget {
			result.CoveredThrough = cursor
			result.HasMore = true
			result.BudgetExhausted = true
			return result, nil
		}
		// One round: query each subscription chunk, collect the round's rows
		// (subscription channels are pre-authorized for streaming, so no
		// per-channel call is needed on this path).
		round := make([]*Message, 0, batch*2)
		for chunkStart := 0; chunkStart < len(subscriptions); chunkStart += subscriptionChunk {
			chunkEnd := chunkStart + subscriptionChunk
			if chunkEnd > len(subscriptions) {
				chunkEnd = len(subscriptions)
			}
			chunk := subscriptions[chunkStart:chunkEnd]
			args := []any{workspaceID, cursor, high}
			args = append(args, anyStrings(chunk)...)
			args = append(args, batch)
			rows, err := ex.QueryContext(ctx, `SELECT `+messageColumns+` FROM messages m
				WHERE m.workspace_id = ? AND m.seq > ? AND m.seq <= ?
				  AND m.channel_id IN (`+placeholders(len(chunk))+`)
				ORDER BY m.seq LIMIT ?`, args...)
			if err != nil {
				return nil, fmt.Errorf("sync scan: %w", err)
			}
			for rows.Next() {
				msg, err := scanMessage(rows)
				if err != nil {
					rows.Close()
					return nil, err
				}
				round = append(round, msg)
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return nil, err
			}
			rows.Close()
		}
		if len(round) == 0 {
			cursor = high
			break
		}
		sort.Slice(round, func(i, j int) bool { return round[i].Seq < round[j].Seq })
		scanned += len(round)
		for _, msg := range round {
			cursor = msg.Seq
			result.Messages = append(result.Messages, msg)
			if len(result.Messages) >= limit {
				result.CoveredThrough = cursor
				result.HasMore = cursor < high
				return result, nil
			}
		}
	}
	result.CoveredThrough = high
	result.HasMore = false
	return result, nil
}

// SyncVisibleMessages is the RESUME-path scanner (Socket envelope): the
// same subscription-prefiltered stream, with the classic row budget so the
// bounded envelope always leaves an advanceable cursor. The HTTP surface
// uses SyncHTTP (deadline-bounded, no quota).
func (s *Store) SyncVisibleMessages(ctx context.Context, claims Claims, workspaceID string, sinceSeq int64, channelID string, limit int) (*SyncResult, error) {
	if limit <= 0 {
		limit = ResumeLimit
	}
	if limit > ResumeLimit {
		limit = ResumeLimit
	}
	var result *SyncResult
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		if err := s.validateHuman(ctx, ex, claims.claims); err != nil {
			return err
		}
		// Authorize before reading H or taking an empty-range fast path.
		// Subscription absence is an interest decision, not proof that the
		// caller may observe this workspace's coverage/high-water mark.
		if err := s.requireWorkspaceMembership(ctx, ex, workspaceID, claims.userID); err != nil {
			return err
		}
		if channelID != "" {
			ok, err := s.syncAudience(ctx, ex, workspaceID, channelID, claims.userID)
			if err != nil {
				return err
			}
			if !ok {
				if _, err := s.authorizeRead(ctx, ex, workspaceID, channelID, claims.userID); err != nil {
					return err
				}
				result = &SyncResult{Messages: []*Message{}, Projections: []*Projection{}, CoveredThrough: sinceSeq}
				return nil
			}
		}
		var err error
		result, err = s.scanStream(ctx, ex, workspaceID, sinceSeq, channelID, limit, claims.userID, true)
		if err != nil {
			return err
		}
		result.Projections, err = s.ProjectMessages(ctx, ex, workspaceID, result.Messages)
		return err
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func channelClause(channelID string) string {
	if channelID == "" {
		return ""
	}
	return " AND m.channel_id = ?"
}

func syncArgs(workspaceID string, cursor, high int64, channelID string, batch int) []any {
	args := []any{workspaceID, cursor, high}
	if channelID != "" {
		args = append(args, channelID)
	}
	args = append(args, batch)
	return args
}
