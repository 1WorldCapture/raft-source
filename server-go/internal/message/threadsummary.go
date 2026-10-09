package message

import (
	"context"
	"database/sql"
	"fmt"
	"sort"

	"raft.local/server-go/internal/channel"
)

// threadSummariesForParents builds the summary map for the page's parent
// message ids in one snapshot. viewerID is optional: unread fields are only
// meaningful for a signed-in viewer; with no M4 read cursors yet they follow
// the frozen TS formula (last_read_seq defaults to 0), so an actively
// followed thread counts every message as unread. The readstate worker (P5)
// extends this projection with real cursors through the same seam.
func (s *Store) threadSummariesForParents(ctx context.Context, ex dbExecutor, workspaceID, channelID string, page []*Message, viewerID string) (map[string]channel.ThreadSummary, error) {
	if len(page) == 0 {
		return map[string]channel.ThreadSummary{}, nil
	}
	rows, err := ex.QueryContext(ctx, `SELECT c.id, c.parent_message_id,
		(SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.workspace_id = ?),
		(SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id AND m.workspace_id = ?)
		FROM channels c
		WHERE c.type = 'thread' AND c.deleted_at IS NULL
		  AND c.workspace_id = ? AND c.parent_message_id IN (`+placeholders(len(page))+`)`,
		append([]any{workspaceID, workspaceID, workspaceID}, messageIDs(page)...)...)
	if err != nil {
		return nil, fmt.Errorf("thread summary rows: %w", err)
	}
	type threadRow struct {
		id            string
		parentMessage string
		replyCount    int
		lastReplyAtMs *int64
	}
	var threads []threadRow
	for rows.Next() {
		var tr threadRow
		var lastReply sql.NullInt64
		if err := rows.Scan(&tr.id, &tr.parentMessage, &tr.replyCount, &lastReply); err != nil {
			rows.Close()
			return nil, err
		}
		if lastReply.Valid {
			v := lastReply.Int64
			tr.lastReplyAtMs = &v
		}
		threads = append(threads, tr)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(threads) == 0 {
		return map[string]channel.ThreadSummary{}, nil
	}

	out := make(map[string]channel.ThreadSummary, len(threads))
	threadIDs := make([]string, 0, len(threads))
	for _, tr := range threads {
		threadIDs = append(threadIDs, tr.id)
	}

	participants, err := s.threadParticipants(ctx, ex, threadIDs)
	if err != nil {
		return nil, err
	}
	unread, firstUnread, err := s.threadUnread(ctx, ex, workspaceID, threadIDs, viewerID)
	if err != nil {
		return nil, err
	}
	latest, err := s.threadLatestReplies(ctx, ex, threadIDs)
	if err != nil {
		return nil, err
	}

	for _, tr := range threads {
		summary := channel.ThreadSummary{
			ThreadChannelID: tr.id,
			ReplyCount:      tr.replyCount,
			LastReplyAt:     tr.lastReplyAtMs,
			ParticipantIDs:  participants[tr.id],
			UnreadCount:     unread[tr.id],
			LatestReplies:   latest[tr.id],
		}
		if id, ok := firstUnread[tr.id]; ok {
			summary.FirstUnreadMessageID = &id
		}
		out[tr.parentMessage] = summary
	}
	return out, nil
}

func (s *Store) threadParticipants(ctx context.Context, ex dbExecutor, threadIDs []string) (map[string][]string, error) {
	rows, err := ex.QueryContext(ctx, `SELECT channel_id, sender_id FROM messages
		WHERE channel_id IN (`+placeholders(len(threadIDs))+`) GROUP BY channel_id, sender_id`, anyStrings(threadIDs)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var channelID, senderID string
		if err := rows.Scan(&channelID, &senderID); err != nil {
			return nil, err
		}
		out[channelID] = append(out[channelID], senderID)
	}
	return out, rows.Err()
}

// threadUnread applies the frozen TS lateral over the REAL 0011 read cursor
// (user_channel_read_states.last_read_seq, read-only access): rows above the
// viewer's cursor count as unread, and only while the viewer ACTIVELY
// follows the thread. No cursor row means 0 (everything unread), exactly
// like the LEFT JOIN + COALESCE of the reference query.
func (s *Store) threadUnread(ctx context.Context, ex dbExecutor, workspaceID string, threadIDs []string, viewerID string) (map[string]int, map[string]string, error) {
	counts := map[string]int{}
	first := map[string]string{}
	if viewerID == "" {
		return counts, first, nil
	}
	args := append(anyStrings(threadIDs), viewerID, viewerID)
	rows, err := ex.QueryContext(ctx, `SELECT m.channel_id, COUNT(*), MIN(m.id)
		FROM messages m
		WHERE m.channel_id IN (`+placeholders(len(threadIDs))+`)
		  AND EXISTS (
			SELECT 1 FROM thread_follows tf
			WHERE tf.thread_channel_id = m.channel_id AND tf.user_id = ?
			  AND tf.unfollowed_at IS NULL)
		  AND m.seq > COALESCE((
			SELECT rc.last_read_seq FROM user_channel_read_states rc
			WHERE rc.workspace_id = m.workspace_id
			  AND rc.user_id = ?
			  AND rc.channel_id = m.channel_id), 0)
		GROUP BY m.channel_id`, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var channelID, firstID string
		var count int
		if err := rows.Scan(&channelID, &count, &firstID); err != nil {
			return nil, nil, err
		}
		counts[channelID] = count
		first[channelID] = firstID
	}
	return counts, first, rows.Err()
}

func (s *Store) threadLatestReplies(ctx context.Context, ex dbExecutor, threadIDs []string) (map[string][]channel.ThreadReplyPreview, error) {
	args := append([]any{}, anyStrings(threadIDs)...)
	rows, err := ex.QueryContext(ctx, `SELECT m.channel_id, m.id, m.seq, m.content, m.sender_id, m.sender_type, m.created_at
		FROM messages m
		WHERE m.channel_id IN (`+placeholders(len(threadIDs))+`) AND m.message_type <> 'system'
		ORDER BY m.seq DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byThread := map[string][]channel.ThreadReplyPreview{}
	for rows.Next() {
		var channelID string
		var reply channel.ThreadReplyPreview
		var createdAt int64
		if err := rows.Scan(&channelID, &reply.MessageID, &reply.Seq, &reply.Preview,
			&reply.SenderID, &reply.SenderType, &createdAt); err != nil {
			return nil, err
		}
		if len(byThread[channelID]) >= 3 {
			continue
		}
		reply.CreatedAt = createdAt
		byThread[channelID] = append(byThread[channelID], reply)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	senderIDs := map[string]bool{}
	for _, list := range byThread {
		for _, r := range list {
			if r.SenderType == "user" {
				senderIDs[r.SenderID] = true
			}
		}
	}
	names, err := s.userDirectory(ctx, ex, senderIDs)
	if err != nil {
		return nil, err
	}
	// Raw directory facts only: the "User"/"Agent" display defaults are a
	// presenter decision over these facts. The newest-3-ascending selection
	// itself IS the frozen fact rule.
	for _, list := range byThread {
		for i := range list {
			if list[i].SenderType == "user" {
				prof := names[list[i].SenderID]
				list[i].SenderName = prof.Handle
				list[i].SenderDisplayName = prof.Name
			}
		}
		sort.Slice(list, func(i, j int) bool { return list[i].Seq < list[j].Seq })
	}
	return byThread, nil
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func messageIDs(page []*Message) []any {
	out := make([]any, 0, len(page))
	for _, m := range page {
		out = append(out, m.ID)
	}
	return out
}

func anyStrings(ids []string) []any {
	out := make([]any, 0, len(ids))
	for _, id := range ids {
		out = append(out, id)
	}
	return out
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	out := "?"
	for i := 1; i < n; i++ {
		out += ",?"
	}
	return out
}
