package message

import (
	"context"
	"database/sql"
	"fmt"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
)

// PageQuery is one channel-history page request. Before and After are seq
// cursors and are mutually exclusive (the transport enforces the legacy 400).
type PageQuery struct {
	Limit  int
	Before *int64
	After  *int64
}

// Coverage is the receiver_visible_messages_v1 window attached to every
// MessagePage, ported field-for-field from listMessagesWithCoverage.
type Coverage struct {
	CoveredAfterSeq       int64
	CoveredFromSeq        int64
	CoveredThroughSeq     int64
	RemoteHighWaterSeq    int64
	HasGap                bool
	HasNewer              bool
	CompleteThroughLatest bool
}

// Page is the domain result of one channel-history read: rows, coverage,
// thread summaries AND the enriched DTOs all come from the SAME snapshot, so
// the response can never mix two read boundaries into a false no-gap claim.
type Page struct {
	Messages        []*Message
	Projections     []*Projection
	Coverage        Coverage
	ThreadSummaries map[string]channel.ThreadSummary // keyed by parent message id
}

// Claims couples the verified access-token claims with the acting user id the
// transport derived from them (identical subject by construction).
type Claims struct {
	claims auth.AccessTokenClaims
	userID string
}

// NewClaims builds the domain principal from the verified JWT claims.
func NewClaims(claims auth.AccessTokenClaims) Claims {
	return Claims{claims: claims, userID: claims.Subject}
}

// ListChannelPage reads one channel page plus its coverage from a single
// consistent snapshot, after revalidating the human claims and the base
// content authority for the channel.
func (s *Store) ListChannelPage(ctx context.Context, claims Claims, workspaceID, channelID string, q PageQuery) (*Page, error) {
	var page *Page
	err := s.withReadSnapshot(ctx, func(ex dbExecutor) error {
		if err := s.validateHuman(ctx, ex, claims.claims); err != nil {
			return err
		}
		if _, err := s.authorizeRead(ctx, ex, workspaceID, channelID, claims.userID); err != nil {
			return err
		}
		var err error
		page, err = s.listChannelPage(ctx, ex, workspaceID, channelID, q, claims.userID)
		if err != nil {
			return err
		}
		page.Projections, err = s.ProjectMessages(ctx, ex, workspaceID, page.Messages)
		return err
	})
	if err != nil {
		return nil, err
	}
	return page, nil
}

func (s *Store) listChannelPage(ctx context.Context, ex dbExecutor, workspaceID, channelID string, q PageQuery, viewerID string) (*Page, error) {
	direction := "latest"
	where := "m.workspace_id = ? AND m.channel_id = ?"
	args := []any{workspaceID, channelID}
	order := "m.seq DESC"
	if q.After != nil {
		direction = "after"
		where += " AND m.seq > ?"
		args = append(args, *q.After)
		order = "m.seq"
	} else if q.Before != nil {
		direction = "before"
		where += " AND m.seq < ?"
		args = append(args, *q.Before)
	}
	args = append(args, q.Limit)

	rows, err := ex.QueryContext(ctx, `SELECT `+messageColumns+` FROM messages m
		WHERE `+where+` ORDER BY `+order+` LIMIT ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("history page: %w", err)
	}
	var pageRows []*Message
	for rows.Next() {
		msg, err := scanMessage(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		pageRows = append(pageRows, msg)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// chronological order for the wire: pages always render ascending seq.
	chrono := pageRows
	if direction != "after" {
		chrono = make([]*Message, 0, len(pageRows))
		for i := len(pageRows) - 1; i >= 0; i-- {
			chrono = append(chrono, pageRows[i])
		}
	}

	// Coverage bound runs on the SAME snapshot: remoteHighWater is this
	// channel's committed boundary; coveredAfter is the exact in-channel
	// predecessor of the first returned row (global seq holes from other
	// channels must not look like local gaps).
	var high, after int64
	var query string
	var boundArgs []any
	if len(chrono) > 0 {
		query = `SELECT COALESCE(MAX(m.seq),0),
			COALESCE(MAX(CASE WHEN m.seq < ? THEN m.seq END),0)
			FROM messages m WHERE m.workspace_id = ? AND m.channel_id = ?`
		boundArgs = []any{chrono[0].Seq, workspaceID, channelID}
	} else {
		// empty page: predecessor degenerates to the channel high-water
		query = `SELECT COALESCE(MAX(m.seq),0), COALESCE(MAX(m.seq),0)
			FROM messages m WHERE m.workspace_id = ? AND m.channel_id = ?`
		boundArgs = []any{workspaceID, channelID}
	}
	if err := ex.QueryRowContext(ctx, query, boundArgs...).Scan(&high, &after); err != nil {
		return nil, fmt.Errorf("coverage bound: %w", err)
	}

	cov := Coverage{
		CoveredAfterSeq:    after,
		RemoteHighWaterSeq: high,
		HasGap:             direction != "latest",
		HasNewer:           direction != "latest",
	}
	if len(chrono) > 0 {
		cov.CoveredFromSeq = chrono[0].Seq
		cov.CoveredThroughSeq = chrono[len(chrono)-1].Seq
	} else {
		cov.CoveredFromSeq = high + 1
		cov.CoveredThroughSeq = high
	}
	cov.CompleteThroughLatest = direction == "latest" && cov.CoveredThroughSeq == high

	summaries, err := s.threadSummariesForParents(ctx, ex, workspaceID, channelID, chrono, viewerID)
	if err != nil {
		return nil, err
	}
	return &Page{Messages: chrono, Coverage: cov, ThreadSummaries: summaries}, nil
}

// getMessage reads one message row inside a snapshot/transaction executor.
func (s *Store) getMessage(ctx context.Context, ex dbExecutor, workspaceID, messageID string) (*Message, error) {
	row := ex.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM messages m
		WHERE m.id = ? AND m.workspace_id = ?`, messageID, workspaceID)
	msg, err := scanMessage(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("message read: %w", err)
	}
	return msg, nil
}
