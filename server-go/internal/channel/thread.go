// Threads and thread-follow interest. Ports getOrCreateThread(+ForChannel),
// recordThreadFollow/followThread/unfollowThreadForFollower, getThreadSummaries,
// getThreadInfoForChannel and getFollowedThreads' human subset onto the 0010
// schema (channels.type='thread' + parent_message_id, thread_follows with
// explicit unfollow history, messages.thread_id projected onto the parent).
//
// The ensure path never follows the opener (opening a thread panel must not
// pollute the followed list); the only automatic follow it owns is the parent
// author's non-reactivating 'authored' row. Reply/mention reactivation is the
// message slice's SetThreadFollowTx call.
package channel

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strconv"

	"raft.local/server-go/internal/publication"
)

// Legacy thread route sentences (channels.ts / channelService).
const (
	ThreadParentChannelMissing = "Parent channel not found"
	ThreadParentMessageMissing = "Parent message not found"
	ThreadNestedMessage        = "Cannot create a thread inside a thread"
	AnnouncementNoThreadsCode  = "announcement_no_threads"
	AnnouncementNoThreadsMsg   = "The #announcement channel is one-way: replies and threads are not allowed"
	ThreadNotFoundMessage      = "Thread not found"
	// ThreadSummaryCompatParentsLimit bounds the no-parameter compatibility
	// window of GET /channels/{id}/threads (THREAD_SUMMARY_COMPAT_PARENT_IDS_LIMIT).
	ThreadSummaryCompatParentsLimit = 100
	// ParentPreviewLimit / ActivityPreviewLimit are the reference truncation
	// points of the followed-thread projection, measured in UTF-16 code units
	// exactly like the original JS string ops.
	ParentPreviewLimit   = 100
	ActivityPreviewLimit = 140

	// Publication intent identities. thread:followers-updated is keyed to the
	// (thread, follower) relationship — a shared channel-level object would
	// collide in realtime_publications' unique key when different users hold
	// the same revision (two first-time followers both at revision 1). The
	// publisher routes the event by ScopeID (the thread) and reprojects the
	// shared {threadChannelId} hint to the currently-authorized follower
	// audience; follower-private rows never ride the intent.
	PublicationObjectTypeThreadFollow = "thread_follow"
	PublicationEventFollowersUpdated  = "thread:followers-updated"
	// thread:updated marks the durable appearance of a thread channel.
	PublicationEventThreadUpdated = "thread:updated"
)

// enqueueFollowersUpdatedTx records the follower-interest intent on the
// caller's transaction. revision must be the mutated follow row's own
// revision; ObjectID is relationship-specific so concurrent first-follows by
// different users cannot collide.
func enqueueFollowersUpdatedTx(ctx context.Context, tx *sql.Tx, workspaceID, userID, threadID string, revision int64) error {
	return publication.Enqueue(ctx, tx, publication.Publication{
		WorkspaceID:   workspaceID,
		ObjectType:    PublicationObjectTypeThreadFollow,
		ObjectID:      threadID + ":" + userID,
		EventType:     PublicationEventFollowersUpdated,
		Revision:      revision,
		SubjectUserID: userID,
		ScopeID:       threadID,
	})
}

// ReadCursorFunc resolves the viewer's read-through seq for one channel
// inside the caller's transaction/snapshot. The readstate slice owns the
// rows; channel only consumes the agreed projection. A nil func behaves as
// "no read recorded" (cursor 0), which is the truthful value until any read
// mutation exists.
type ReadCursorFunc func(ctx context.Context, ex Executor, workspaceID, userID, channelID string) (int64, error)

func readCursorSeq(ctx context.Context, ex Executor, cursor ReadCursorFunc, workspaceID, userID, channelID string) (int64, error) {
	if cursor == nil {
		return 0, nil
	}
	return cursor(ctx, ex, workspaceID, userID, channelID)
}

// utf16Len counts UTF-16 code units the way JS string.length does.
func utf16Len(s string) int {
	units := 0
	for _, r := range s {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}

// truncateUTF16 mirrors content.slice(0, n) + "…" semantics of the reference
// previews: the cut lands on a UTF-16 unit boundary (an astral pair is kept
// or dropped whole, never split into a lone surrogate).
func truncateUTF16(s string, maxUnits int) string {
	if utf16Len(s) <= maxUnits {
		return s
	}
	units := 0
	out := make([]rune, 0, maxUnits)
	for _, r := range s {
		w := 1
		if r > 0xFFFF {
			w = 2
		}
		if units+w > maxUnits {
			break
		}
		units += w
		out = append(out, r)
	}
	return string(out) + "…"
}

// ThreadReplyPreview is one of the ≤3 newest non-system replies served
// upfront for inline previews (ThreadSummaryLatestReply).
type ThreadReplyPreview struct {
	MessageID         string
	Seq               int64
	Preview           string
	SenderID          string
	SenderType        string // user | agent | system
	SenderName        string
	SenderDisplayName string
	SenderAvatarURL   *string
	CreatedAt         int64 // unix millis
}

// ThreadSummary is the viewer-aware summary of one thread (getThreadSummaries).
// UnreadCount/FirstUnreadMessageID are computed only while the viewer holds
// an active follow, exactly like the original join.
type ThreadSummary struct {
	ThreadChannelID      string
	ReplyCount           int
	LastReplyAt          *int64
	ParticipantIDs       []string
	UnreadCount          int
	FirstUnreadMessageID *string
	LatestReplies        []ThreadReplyPreview
}

// ThreadInfo is the per-parent projection of GET /channels/{id}/threads/{messageId}.
type ThreadInfo struct {
	ThreadChannelID string
	ReplyCount      int
	LastReplyAt     *int64
	ParticipantIDs  []string
}

// FollowedThread is one row of GET /channels/threads/followed (active state),
// human subset: task claimants and external projections do not exist in this
// phase and stay absent rather than faked.
type FollowedThread struct {
	ThreadChannelID          string
	ParentMessageID          string
	ParentChannelID          string
	ParentChannelName        string
	ParentChannelType        string
	ParentMessagePreview     string
	ParentMessageSenderType  string
	ParentMessageSenderID    string
	LatestActivityPreview    string
	LatestActivitySenderType string
	LatestActivitySenderID   string
	LatestActivityMessageID  string
	LatestActivitySeq        *string // canonical decimal string, same-source with MessageID
	FirstUnreadMessageID     *string
	LastActivityAt           int64 // unix millis
	ReplyCount               int
	LastReplyAt              *int64
	UnreadCount              int
	MaxReadSeq               int64
}

// threadName builds the storage name `thread-{first 8 chars}` of the parent
// message id (the unique partial index on parent_message_id is the identity;
// the name is display/compat only).
func threadName(parentMessageID string) string {
	runes := []rune(parentMessageID)
	if len(runes) > 8 {
		runes = runes[:8]
	}
	return "thread-" + string(runes)
}

// parentMessageRow is the verified parent message fact the thread paths need.
type parentMessageRow struct {
	WorkspaceID string
	ChannelID   string
	SenderType  string
	SenderID    string
}

func (s *Store) readParentMessage(ctx context.Context, ex Executor, parentMessageID string) (*parentMessageRow, error) {
	var row parentMessageRow
	err := ex.QueryRowContext(ctx, `
		SELECT workspace_id, channel_id, sender_type, sender_id FROM messages WHERE id = ?`,
		parentMessageID).Scan(&row.WorkspaceID, &row.ChannelID, &row.SenderType, &row.SenderID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read parent message: %w", err)
	}
	return &row, nil
}

// EnsureThreadTx finds or creates the unique thread channel of one parent
// message and records the parent author's non-reactivating 'authored'
// follow. The parent message's thread_id projection is message-owned: the
// application use case attaches it in the same transaction through
// message.AttachThreadToParentTx immediately after this returns. The partial unique index on
// (type='thread', parent_message_id, live) arbitrates concurrent ensures onto
// one channel; the loser re-reads the winner's row. The opener is never
// auto-followed.
//
// Archived parents are NOT refused here: the original ensure allows them and
// only the create-thread route applies the archived guard. Announcement
// channels refuse threads at this choke point, matching getOrCreateThread.
func (s *Store) EnsureThreadTx(ctx context.Context, tx *sql.Tx, workspaceID, channelID, parentMessageID, userID string) (*Channel, error) {
	parent, err := s.getChannel(ctx, tx, channelID, false)
	if err != nil {
		return nil, err
	}
	if parent == nil || parent.WorkspaceID != workspaceID {
		return nil, &DomainError{Code: CodeNotFound, Message: ThreadParentChannelMissing}
	}
	role, err := s.eligibleHumanRole(ctx, tx, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	if role == "" {
		return nil, &DomainError{Code: CodeForbidden, Message: NotServerMemberMessage}
	}
	if parent.Type == TypeThread {
		return nil, &DomainError{Code: CodeInvalidInput, Message: ThreadNestedMessage}
	}
	if IsAnnouncementChannel(parent) {
		return nil, &DomainError{Code: CodeInvalidInput, Message: AnnouncementNoThreadsMsg}
	}
	// Fail-closed read recheck of the base content policy (the route already
	// denied strangers; this keeps the domain safe for every other caller).
	member, err := s.isChannelHuman(ctx, tx, parent.ID, userID)
	if err != nil {
		return nil, err
	}
	if !canReadRoot(role, parent, member) {
		return nil, &DomainError{Code: CodeNotFound, Message: "Channel not found"}
	}

	message, err := s.readParentMessage(ctx, tx, parentMessageID)
	if err != nil {
		return nil, err
	}
	if message == nil || message.ChannelID != channelID || message.WorkspaceID != workspaceID {
		return nil, &DomainError{Code: CodeNotFound, Message: ThreadParentMessageMissing}
	}

	thread, created, err := s.insertThreadChannel(ctx, tx, workspaceID, parentMessageID)
	if err != nil {
		return nil, err
	}
	if created {
		// The durable appearance of the thread channel; revision 1 is unique
		// per thread because a thread can only be created once (soft-deleted
		// threads are not revived by ensure in this phase).
		if err := publication.Enqueue(ctx, tx, publication.Publication{
			WorkspaceID: workspaceID,
			ObjectType:  "channel",
			ObjectID:    thread.ID,
			EventType:   PublicationEventThreadUpdated,
			Revision:    1,
			ScopeID:     thread.ID,
		}); err != nil {
			return nil, err
		}
	}

	// The parent message's thread_id projection is message-owned: the
	// application use case attaches it in this SAME transaction through
	// message.AttachThreadToParentTx right after this ensure returns (the
	// ordering with the author follow below is not constraint-relevant —
	// both write disjoint tables inside one commit).

	// Automatic 'authored' follow for a human parent author: insert-only or
	// refresh-while-active; it must never resurrect an explicit unfollow.
	if message.SenderType == "user" && message.SenderID != "" {
		if err := s.recordAuthorFollowTx(ctx, tx, workspaceID, message.SenderID, thread.ID, parentMessageID); err != nil {
			return nil, err
		}
	}
	return thread, nil
}

// insertThreadChannel resolves or creates the unique thread channel row,
// converging on the winner under concurrency. created reports whether THIS
// call created the row (the loser adopts the winner's channel and reports
// false), so the caller emits the appearance intent exactly once per thread.
func (s *Store) insertThreadChannel(ctx context.Context, tx *sql.Tx, workspaceID, parentMessageID string) (*Channel, bool, error) {
	existing, err := s.getThreadByParent(ctx, tx, workspaceID, parentMessageID)
	if err != nil {
		return nil, false, err
	}
	if existing != nil {
		return existing, false, nil
	}
	id, err := newUUID()
	if err != nil {
		return nil, false, err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO channels (id, workspace_id, name, type, parent_message_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		id, workspaceID, threadName(parentMessageID), TypeThread, parentMessageID, s.now().UnixMilli())
	if err != nil {
		if isUniqueViolation(err) {
			winner, readErr := s.getThreadByParent(ctx, tx, workspaceID, parentMessageID)
			if readErr == nil && winner != nil {
				return winner, false, nil
			}
		}
		return nil, false, fmt.Errorf("insert thread channel: %w", err)
	}
	thread, err := s.getChannel(ctx, tx, id, false)
	if err != nil {
		return nil, true, err
	}
	if thread == nil {
		return nil, true, fmt.Errorf("thread channel %s vanished after insert", id)
	}
	return thread, true, nil
}

func (s *Store) getThreadByParent(ctx context.Context, ex Executor, workspaceID, parentMessageID string) (*Channel, error) {
	row := ex.QueryRowContext(ctx, `SELECT `+channelColumns+`
		FROM channels c
		WHERE c.workspace_id = ? AND c.type = ? AND c.parent_message_id = ? AND c.deleted_at IS NULL`,
		workspaceID, TypeThread, parentMessageID)
	c, err := scanChannel(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read thread by parent: %w", err)
	}
	return c, nil
}

// SetThreadFollowTx records one thread-interest decision. follow=true with
// automatic=false is an explicit/manual follow (reactivates an unfollowed
// row and refreshes an active one); automatic=true is the reply/mention rule
// of the reference (reactivates an unfollowed row but never churns an
// already-active row); follow=false is an explicit unfollow that keeps the
// row as history instead of deleting it.
//
// Every REAL mutation enqueues the thread:followers-updated intent on this
// same transaction (relationship-specific object, the row's own revision);
// a no-op (automatic follow while already active, unfollow while already
// unfollowed) changes nothing and enqueues nothing.
func (s *Store) SetThreadFollowTx(ctx context.Context, tx *sql.Tx, workspaceID, threadID, userID string, follow, automatic bool) error {
	parentMessageID, err := s.threadParentMessageID(ctx, tx, workspaceID, threadID)
	if err != nil {
		return err
	}
	now := s.now().UnixMilli()
	if !follow {
		// Upsert the explicit unfollow, preserving the row as history.
		res, err := tx.ExecContext(ctx, `
			INSERT INTO thread_follows (workspace_id, user_id, thread_channel_id, parent_message_id, followed_at, unfollowed_at, revision)
			VALUES (?, ?, ?, ?, ?, ?, 1)
			ON CONFLICT (workspace_id, user_id, thread_channel_id)
			DO UPDATE SET unfollowed_at = excluded.unfollowed_at, revision = thread_follows.revision + 1
			WHERE thread_follows.unfollowed_at IS NULL`,
			workspaceID, userID, threadID, parentMessageID, now, now)
		if err != nil {
			return fmt.Errorf("record thread unfollow: %w", err)
		}
		return s.enqueueFollowChange(ctx, tx, workspaceID, userID, threadID, res)
	}
	if automatic {
		res, err := tx.ExecContext(ctx, `
			INSERT INTO thread_follows (workspace_id, user_id, thread_channel_id, parent_message_id, followed_at, unfollowed_at, revision)
			VALUES (?, ?, ?, ?, ?, NULL, 1)
			ON CONFLICT (workspace_id, user_id, thread_channel_id)
			DO UPDATE SET followed_at = excluded.followed_at, unfollowed_at = NULL, revision = thread_follows.revision + 1
			WHERE thread_follows.unfollowed_at IS NOT NULL`,
			workspaceID, userID, threadID, parentMessageID, now)
		if err != nil {
			return fmt.Errorf("record automatic thread follow: %w", err)
		}
		return s.enqueueFollowChange(ctx, tx, workspaceID, userID, threadID, res)
	}
	// Explicit follow: refresh or reactivate unconditionally.
	res, err := tx.ExecContext(ctx, `
		INSERT INTO thread_follows (workspace_id, user_id, thread_channel_id, parent_message_id, followed_at, unfollowed_at, revision)
		VALUES (?, ?, ?, ?, ?, NULL, 1)
		ON CONFLICT (workspace_id, user_id, thread_channel_id)
		DO UPDATE SET followed_at = excluded.followed_at, unfollowed_at = NULL, revision = thread_follows.revision + 1`,
		workspaceID, userID, threadID, parentMessageID, now)
	if err != nil {
		return fmt.Errorf("record thread follow: %w", err)
	}
	return s.enqueueFollowChange(ctx, tx, workspaceID, userID, threadID, res)
}

// recordAuthorFollowTx is the automatic 'authored' row: insert-only. It
// never reactivates an explicit unfollow, and it never churns an existing
// active row (a third party opening the thread panel must not touch the
// author's interest or emit an event): the author keeps their original
// followed_at and the mutation is a genuine no-op. The intent is emitted
// only when this call actually created the row.
func (s *Store) recordAuthorFollowTx(ctx context.Context, tx *sql.Tx, workspaceID, userID, threadID, parentMessageID string) error {
	res, err := tx.ExecContext(ctx, `
		INSERT INTO thread_follows (workspace_id, user_id, thread_channel_id, parent_message_id, followed_at, unfollowed_at, revision)
		VALUES (?, ?, ?, ?, ?, NULL, 1)
		ON CONFLICT (workspace_id, user_id, thread_channel_id) DO NOTHING`,
		workspaceID, userID, threadID, parentMessageID, s.now().UnixMilli())
	if err != nil {
		return fmt.Errorf("record authored thread follow: %w", err)
	}
	return s.enqueueFollowChange(ctx, tx, workspaceID, userID, threadID, res)
}

// enqueueFollowChange publishes the follow-interest intent when the upsert
// actually changed a row (RowsAffected > 0), keyed to the row's own new
// revision. A no-op leaves no intent behind.
func (s *Store) enqueueFollowChange(ctx context.Context, tx *sql.Tx, workspaceID, userID, threadID string, res sql.Result) error {
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("read thread follow change: %w", err)
	}
	if affected == 0 {
		return nil
	}
	revision, ok, err := s.ThreadFollowRevisionTx(ctx, tx, workspaceID, userID, threadID)
	if err != nil {
		return err
	}
	if !ok || revision < 1 {
		revision = 1
	}
	return enqueueFollowersUpdatedTx(ctx, tx, workspaceID, userID, threadID, revision)
}

// threadParentMessageID verifies the thread channel and returns its parent
// message id (thread_follows.parent_message_id is NOT NULL and FK-checked).
func (s *Store) threadParentMessageID(ctx context.Context, ex Executor, workspaceID, threadID string) (string, error) {
	var parentMessageID string
	err := ex.QueryRowContext(ctx, `
		SELECT parent_message_id FROM channels
		WHERE id = ? AND workspace_id = ? AND type = ? AND deleted_at IS NULL AND parent_message_id IS NOT NULL`,
		threadID, workspaceID, TypeThread).Scan(&parentMessageID)
	if err == sql.ErrNoRows {
		return "", &DomainError{Code: CodeNotFound, Message: ThreadNotFoundMessage}
	}
	if err != nil {
		return "", fmt.Errorf("read thread channel: %w", err)
	}
	return parentMessageID, nil
}

// HasActiveThreadFollowTx reports an active (non-unfollowed) follow row.
func (s *Store) HasActiveThreadFollowTx(ctx context.Context, ex Executor, workspaceID, userID, threadID string) (bool, error) {
	var one int
	err := ex.QueryRowContext(ctx, `
		SELECT 1 FROM thread_follows
		WHERE workspace_id = ? AND user_id = ? AND thread_channel_id = ? AND unfollowed_at IS NULL`,
		workspaceID, userID, threadID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read thread follow: %w", err)
	}
	return true, nil
}

// ThreadFollowRevisionTx reads the current revision of one follow row for
// transactional publication intents; false when no row exists.
func (s *Store) ThreadFollowRevisionTx(ctx context.Context, ex Executor, workspaceID, userID, threadID string) (int64, bool, error) {
	var revision int64
	err := ex.QueryRowContext(ctx, `
		SELECT revision FROM thread_follows
		WHERE workspace_id = ? AND user_id = ? AND thread_channel_id = ?`,
		workspaceID, userID, threadID).Scan(&revision)
	if err == sql.ErrNoRows {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("read thread follow revision: %w", err)
	}
	return revision, true, nil
}

// RecentThreadParentIDsTx ports listRecentCanonicalThreadParentMessageIds:
// the most recently active thread parents of one channel, bounded by limit.
func (s *Store) RecentThreadParentIDsTx(ctx context.Context, ex Executor, channelID string, limit int) ([]string, error) {
	if limit <= 0 {
		return []string{}, nil
	}
	rows, err := ex.QueryContext(ctx, `
		SELECT c.parent_message_id
		FROM channels c
		JOIN messages pm ON pm.id = c.parent_message_id
		WHERE c.type = ? AND c.deleted_at IS NULL AND pm.channel_id = ?
		GROUP BY c.parent_message_id
		ORDER BY MAX(pm.seq) DESC, c.parent_message_id DESC
		LIMIT ?`, TypeThread, channelID, limit)
	if err != nil {
		return nil, fmt.Errorf("list recent thread parents: %w", err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ThreadInfoTx ports getThreadInfoForChannel: the summary of the thread of
// one parent message within one channel, or nil when there is none.
func (s *Store) ThreadInfoTx(ctx context.Context, ex Executor, channelID, parentMessageID string) (*ThreadInfo, error) {
	thread, err := s.getThreadByParentForChannel(ctx, ex, channelID, parentMessageID)
	if err != nil || thread == nil {
		return nil, err
	}
	stats, err := s.threadStats(ctx, ex, thread.ID)
	if err != nil {
		return nil, err
	}
	participants, err := s.threadParticipants(ctx, ex, thread.ID)
	if err != nil {
		return nil, err
	}
	return &ThreadInfo{
		ThreadChannelID: thread.ID,
		ReplyCount:      stats.replyCount,
		LastReplyAt:     stats.lastReplyAt,
		ParticipantIDs:  participants,
	}, nil
}

func (s *Store) getThreadByParentForChannel(ctx context.Context, ex Executor, channelID, parentMessageID string) (*Channel, error) {
	row := ex.QueryRowContext(ctx, `SELECT `+channelColumns+`
		FROM channels c
		JOIN messages pm ON pm.id = c.parent_message_id
		WHERE c.type = ? AND c.deleted_at IS NULL AND c.parent_message_id = ? AND pm.channel_id = ?`,
		TypeThread, parentMessageID, channelID)
	c, err := scanChannel(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read thread by parent (channel view): %w", err)
	}
	return c, nil
}

type threadStatsRow struct {
	replyCount  int
	lastReplyAt *int64
	latestSeq   sql.NullInt64
}

func (s *Store) threadStats(ctx context.Context, ex Executor, threadID string) (*threadStatsRow, error) {
	var stats threadStatsRow
	var lastReplyAt sql.NullInt64
	err := ex.QueryRowContext(ctx, `
		SELECT COUNT(*), MAX(created_at), MAX(seq) FROM messages WHERE channel_id = ?`, threadID).
		Scan(&stats.replyCount, &lastReplyAt, &stats.latestSeq)
	if err != nil {
		return nil, fmt.Errorf("read thread stats: %w", err)
	}
	if lastReplyAt.Valid {
		v := lastReplyAt.Int64
		stats.lastReplyAt = &v
	}
	return &stats, nil
}

func (s *Store) threadParticipants(ctx context.Context, ex Executor, threadID string) ([]string, error) {
	rows, err := ex.QueryContext(ctx, `
		SELECT sender_id FROM messages WHERE channel_id = ? GROUP BY sender_id ORDER BY MIN(seq)`, threadID)
	if err != nil {
		return nil, fmt.Errorf("read thread participants: %w", err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ThreadSummariesTx ports getThreadSummaries for the human subset: live
// threads whose parent message sits in channelID, restricted to parentIDs
// when non-nil (the nil case resolves the bounded compat window). Unread is
// viewer-aware and only counted while the viewer actively follows the thread.
func (s *Store) ThreadSummariesTx(ctx context.Context, ex Executor, workspaceID, channelID string, parentIDs []string, userID string, cursor ReadCursorFunc) (map[string]ThreadSummary, error) {
	if len(parentIDs) == 0 {
		return map[string]ThreadSummary{}, nil
	}
	threads, err := s.threadsForParentMessages(ctx, ex, channelID, parentIDs)
	if err != nil || len(threads) == 0 {
		return map[string]ThreadSummary{}, err
	}
	out := make(map[string]ThreadSummary, len(threads))
	for _, t := range threads {
		stats, err := s.threadStats(ctx, ex, t.ID)
		if err != nil {
			return nil, err
		}
		participants, err := s.threadParticipants(ctx, ex, t.ID)
		if err != nil {
			return nil, err
		}
		summary := ThreadSummary{
			ThreadChannelID: t.ID,
			ReplyCount:      stats.replyCount,
			LastReplyAt:     stats.lastReplyAt,
			ParticipantIDs:  participants,
		}
		if userID != "" {
			following, err := s.HasActiveThreadFollowTx(ctx, ex, workspaceID, userID, t.ID)
			if err != nil {
				return nil, err
			}
			if following {
				// The summaries rule counts every message past the cursor
				// (own messages included), like the reference join.
				readSeq, err := readCursorSeq(ctx, ex, cursor, workspaceID, userID, t.ID)
				if err != nil {
					return nil, err
				}
				unreadCount, firstUnread, err := s.threadUnread(ctx, ex, t.ID, readSeq, "", false)
				if err != nil {
					return nil, err
				}
				summary.UnreadCount = unreadCount
				summary.FirstUnreadMessageID = firstUnread
			}
		}
		replies, err := s.threadLatestReplies(ctx, ex, t.ID)
		if err != nil {
			return nil, err
		}
		summary.LatestReplies = replies
		out[*t.ParentMessageID] = summary
	}
	return out, nil
}

// threadUnread counts messages beyond the read cursor. excludeViewer excludes
// the viewer's own messages (the followed-list rule); viewerID is only read
// when excludeViewer is set.
func (s *Store) threadUnread(ctx context.Context, ex Executor, threadID string, readSeq int64, viewerID string, excludeViewer bool) (int, *string, error) {
	query := `
		SELECT COUNT(*), MIN(CASE WHEN seq > ? THEN seq END)
		FROM messages
		WHERE channel_id = ? AND seq > ?`
	args := []any{readSeq, threadID, readSeq}
	if excludeViewer {
		query = `
		SELECT COUNT(*), MIN(CASE WHEN seq > ? THEN seq END)
		FROM messages
		WHERE channel_id = ? AND seq > ?
		  AND NOT (sender_type = 'user' AND sender_id = ?)`
		args = []any{readSeq, threadID, readSeq, viewerID}
	}
	var count int
	var firstUnreadSeq sql.NullInt64
	if err := ex.QueryRowContext(ctx, query, args...).Scan(&count, &firstUnreadSeq); err != nil {
		return 0, nil, fmt.Errorf("read thread unread: %w", err)
	}
	if !firstUnreadSeq.Valid || count == 0 {
		return count, nil, nil
	}
	var firstID string
	err := ex.QueryRowContext(ctx, `
		SELECT id FROM messages WHERE channel_id = ? AND seq = ?`, threadID, firstUnreadSeq.Int64).Scan(&firstID)
	if err == sql.ErrNoRows {
		return count, nil, nil
	}
	if err != nil {
		return 0, nil, fmt.Errorf("read first unread message: %w", err)
	}
	return count, &firstID, nil
}

// threadsForParentMessages loads the live thread channels of parent messages
// that belong to channelID.
func (s *Store) threadsForParentMessages(ctx context.Context, ex Executor, channelID string, parentIDs []string) ([]*Channel, error) {
	placeholders := ""
	args := make([]any, 0, len(parentIDs)+2)
	for i, id := range parentIDs {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		args = append(args, id)
	}
	query := `SELECT ` + channelColumns + `
		FROM channels c
		JOIN messages pm ON pm.id = c.parent_message_id
		WHERE c.type = ? AND c.deleted_at IS NULL AND pm.channel_id = ? AND c.parent_message_id IN (` + placeholders + `)
		ORDER BY c.id`
	rows, err := ex.QueryContext(ctx, query, append([]any{TypeThread, channelID}, args...)...)
	if err != nil {
		return nil, fmt.Errorf("list threads for parents: %w", err)
	}
	defer rows.Close()
	var threads []*Channel
	for rows.Next() {
		c, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		threads = append(threads, c)
	}
	return threads, rows.Err()
}

type senderIdentity struct {
	name        string
	displayName string
	avatarURL   *string
}

func (s *Store) senderIdentities(ctx context.Context, ex Executor, senderType string, ids []string) (map[string]*senderIdentity, error) {
	out := map[string]*senderIdentity{}
	if len(ids) == 0 {
		return out, nil
	}
	placeholders := ""
	args := make([]any, 0, len(ids))
	for i, id := range ids {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		args = append(args, id)
	}
	var query string
	switch senderType {
	case "user":
		query = `SELECT id, name, display_name, avatar_url FROM users WHERE id IN (` + placeholders + `)`
	default:
		query = `SELECT id, name, display_name, avatar_url FROM agents WHERE id IN (` + placeholders + `) AND deleted_at IS NULL`
	}
	rows, err := ex.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("read sender identities: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var id senderIdentity
		var displayName, avatarURL sql.NullString
		if err := rows.Scan(&key, &id.name, &displayName, &avatarURL); err != nil {
			return nil, err
		}
		id.displayName = id.name
		if displayName.Valid && displayName.String != "" {
			id.displayName = displayName.String
		}
		if avatarURL.Valid {
			v := avatarURL.String
			id.avatarURL = &v
		}
		out[key] = &id
	}
	return out, rows.Err()
}

// threadLatestReplies loads the ≤3 newest non-system replies (presented
// ascending), with sender identity resolved from the directory (users, then
// agents; unknown rows fall back to the reference labels).
func (s *Store) threadLatestReplies(ctx context.Context, ex Executor, threadID string) ([]ThreadReplyPreview, error) {
	rows, err := ex.QueryContext(ctx, `
		SELECT id, seq, content, sender_id, sender_type, created_at
		FROM messages
		WHERE channel_id = ? AND message_type <> 'system'
		ORDER BY seq DESC LIMIT 3`, threadID)
	if err != nil {
		return nil, fmt.Errorf("read latest thread replies: %w", err)
	}
	defer rows.Close()
	previews := []ThreadReplyPreview{}
	userIDs, agentIDs := []string{}, []string{}
	for rows.Next() {
		var p ThreadReplyPreview
		if err := rows.Scan(&p.MessageID, &p.Seq, &p.Preview, &p.SenderID, &p.SenderType, &p.CreatedAt); err != nil {
			return nil, err
		}
		switch p.SenderType {
		case "user":
			userIDs = append(userIDs, p.SenderID)
		case "agent":
			agentIDs = append(agentIDs, p.SenderID)
		}
		previews = append(previews, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(previews, func(i, j int) bool { return previews[i].Seq < previews[j].Seq })
	users, err := s.senderIdentities(ctx, ex, "user", userIDs)
	if err != nil {
		return nil, err
	}
	agents, err := s.senderIdentities(ctx, ex, "agent", agentIDs)
	if err != nil {
		return nil, err
	}
	for i := range previews {
		switch previews[i].SenderType {
		case "user":
			if id := users[previews[i].SenderID]; id != nil {
				previews[i].SenderName, previews[i].SenderDisplayName, previews[i].SenderAvatarURL = id.name, id.displayName, id.avatarURL
			} else {
				previews[i].SenderName, previews[i].SenderDisplayName = "User", "User"
			}
		case "agent":
			if id := agents[previews[i].SenderID]; id != nil {
				previews[i].SenderName, previews[i].SenderDisplayName, previews[i].SenderAvatarURL = id.name, id.displayName, id.avatarURL
			} else {
				previews[i].SenderName, previews[i].SenderDisplayName = "Agent", "Agent"
			}
		default:
			previews[i].SenderName, previews[i].SenderDisplayName = "System", "System"
		}
	}
	return previews, nil
}

// followedThreadRow is the metadata arm of getFollowedThreads' regular query.
type followedThreadRow struct {
	threadChannelID   string
	parentMessageID   string
	parentChannelID   string
	parentChannelName string
	parentChannelType string
	parentContent     string
	parentSenderType  string
	parentSenderID    string
	parentSeq         int64
	parentCreatedAt   int64
}

// FollowedThreadsTx ports getFollowedThreads' active human subset: active
// follows whose thread channel and parent chain are live, the parent channel
// is not archived/hidden, and readability still holds (public parent or roster
// row). Unread excludes the viewer's own messages; the frontier
// (latestActivitySeq) is always paired with latestActivityMessageId from the
// same source row.
func (s *Store) FollowedThreadsTx(ctx context.Context, ex Executor, workspaceID, userID string, cursor ReadCursorFunc) ([]FollowedThread, error) {
	role, err := s.eligibleHumanRole(ctx, ex, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	if role == "" || role == RoleGuest {
		return []FollowedThread{}, nil
	}
	rows, err := ex.QueryContext(ctx, `
		SELECT c.id, c.parent_message_id,
		       pc.id, pc.name, pc.type,
		       pm.content, pm.sender_type, pm.sender_id, pm.seq, pm.created_at
		FROM thread_follows tf
		JOIN channels c
		  ON c.id = tf.thread_channel_id
		 AND c.workspace_id = tf.workspace_id
		 AND c.type = 'thread'
		 AND c.deleted_at IS NULL
		JOIN messages pm ON pm.id = c.parent_message_id
		JOIN channels pc ON pc.id = pm.channel_id
		LEFT JOIN channel_humans pch
		  ON pch.channel_id = pc.id AND pch.user_id = ?
		WHERE tf.workspace_id = ?
		  AND tf.user_id = ?
		  AND tf.unfollowed_at IS NULL
		  AND pc.workspace_id = ?
		  AND pc.deleted_at IS NULL
		  AND pc.archived_at IS NULL
		  AND NOT (pc.name = 'all' AND pc.type <> 'channel')
		  AND (pc.type = 'channel' OR pch.user_id IS NOT NULL)
		ORDER BY c.id`, userID, workspaceID, userID, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list followed threads: %w", err)
	}
	defer rows.Close()
	metas := []followedThreadRow{}
	for rows.Next() {
		var m followedThreadRow
		if err := rows.Scan(&m.threadChannelID, &m.parentMessageID,
			&m.parentChannelID, &m.parentChannelName, &m.parentChannelType,
			&m.parentContent, &m.parentSenderType, &m.parentSenderID, &m.parentSeq, &m.parentCreatedAt); err != nil {
			return nil, err
		}
		metas = append(metas, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	threads := make([]FollowedThread, 0, len(metas))
	for _, m := range metas {
		t := FollowedThread{
			ThreadChannelID:         m.threadChannelID,
			ParentMessageID:         m.parentMessageID,
			ParentChannelID:         m.parentChannelID,
			ParentChannelName:       m.parentChannelName,
			ParentChannelType:       m.parentChannelType,
			ParentMessagePreview:    truncateUTF16(m.parentContent, ParentPreviewLimit),
			ParentMessageSenderType: m.parentSenderType,
			ParentMessageSenderID:   m.parentSenderID,
			// Parent message is the fallback latest activity (same-source).
			LatestActivityPreview:    truncateUTF16(m.parentContent, ActivityPreviewLimit),
			LatestActivitySenderType: m.parentSenderType,
			LatestActivitySenderID:   m.parentSenderID,
			LatestActivityMessageID:  m.parentMessageID,
			LastActivityAt:           m.parentCreatedAt,
		}
		parentSeq := strconv.FormatInt(m.parentSeq, 10)
		t.LatestActivitySeq = &parentSeq

		stats, err := s.threadStats(ctx, ex, m.threadChannelID)
		if err != nil {
			return nil, err
		}
		t.ReplyCount = stats.replyCount
		t.LastReplyAt = stats.lastReplyAt

		readSeq, err := readCursorSeq(ctx, ex, cursor, workspaceID, userID, m.threadChannelID)
		if err != nil {
			return nil, err
		}
		t.MaxReadSeq = readSeq
		unreadCount, firstUnread, err := s.threadUnread(ctx, ex, m.threadChannelID, readSeq, userID, true)
		if err != nil {
			return nil, err
		}
		t.UnreadCount = unreadCount
		t.FirstUnreadMessageID = firstUnread

		if stats.latestSeq.Valid {
			var latestID, latestContent, latestSenderType, latestSenderID string
			var latestCreatedAt int64
			err := ex.QueryRowContext(ctx, `
				SELECT id, content, sender_type, sender_id, created_at
				FROM messages WHERE channel_id = ? AND seq = ?`,
				m.threadChannelID, stats.latestSeq.Int64).
				Scan(&latestID, &latestContent, &latestSenderType, &latestSenderID, &latestCreatedAt)
			if err != nil && err != sql.ErrNoRows {
				return nil, fmt.Errorf("read latest thread reply: %w", err)
			}
			if err == nil {
				t.LatestActivityPreview = truncateUTF16(latestContent, ActivityPreviewLimit)
				t.LatestActivitySenderType = latestSenderType
				t.LatestActivitySenderID = latestSenderID
				t.LatestActivityMessageID = latestID
				t.LastActivityAt = latestCreatedAt
				seq := strconv.FormatInt(stats.latestSeq.Int64, 10)
				t.LatestActivitySeq = &seq
			}
		}
		threads = append(threads, t)
	}
	// Active follows order by latest activity, most recent first.
	sort.SliceStable(threads, func(i, j int) bool { return threads[i].LastActivityAt > threads[j].LastActivityAt })
	return threads, nil
}

// AuthorizeParentMessageTx verifies a thread parent message the way the
// follow route does: the message must exist, its channel must belong to the
// caller's workspace, and the caller must hold base read access to that
// channel. Every failure collapses into the single NOT_FOUND
// "Message not found" the original route uses, so existence is never an
// oracle. Returns the parent channel for the subsequent ensure.
func (s *Store) AuthorizeParentMessageTx(ctx context.Context, ex Executor, workspaceID, parentMessageID, userID string) (*Channel, error) {
	notFound := &DomainError{Code: CodeNotFound, Message: "Message not found"}
	message, err := s.readParentMessage(ctx, ex, parentMessageID)
	if err != nil {
		return nil, err
	}
	if message == nil {
		return nil, notFound
	}
	parent, err := s.getChannel(ctx, ex, message.ChannelID, false)
	if err != nil {
		return nil, err
	}
	if parent == nil || parent.WorkspaceID != workspaceID {
		return nil, notFound
	}
	conv, err := s.AuthorizeConversationTx(ctx, ex, workspaceID, parent.ID, userID, false)
	if err != nil {
		return nil, notFound
	}
	return conv.Channel, nil
}
