package readstate

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"raft.local/server-go/internal/auth"
)

// Inbox filters (InboxFilter in the reference).
const (
	FilterAll            = "all"
	FilterUnread         = "unread"
	FilterMentions       = "mentions"
	FilterUnreadMentions = "unread_mentions"
)

// Inbox paging bounds frozen by the legacy routes.
const (
	InboxDefaultLimit = 30
	InboxMaxLimit     = 100
)

// InboxQuery is the /channels/inbox query contract.
type InboxQuery struct {
	Filter    string // all | unread | mentions | unread_mentions
	Limit     int
	Offset    int
	ChannelID string
	Q         string
	Sort      string // asc | desc
}

// InboxGroup is the per-channel grouping the sidebar consumes.
type InboxGroup struct {
	ChannelID      string
	ChannelName    string
	ChannelType    string
	Count          int
	LastActivityAt string
}

// InboxPage is the InboxItemsResult envelope.
type InboxPage struct {
	Items             []InboxItem
	Groups            []InboxGroup
	HasMore           bool
	TotalCount        int
	TotalUnreadCount  int
	ActiveUnreadCount int
}

// ReadFrontier is the #632 SSOT per-scope read frontier union.
type ReadFrontier struct {
	Kind        string // absent | present
	Version     int64
	MaxReadSeq  int64
	LatestID    string
	LatestSeq   int64
	LatestValid bool
}

// InboxItem is the internal union row; Wire() renders the exact TS shape.
type InboxItem struct {
	Kind        string // channel | dm | thread
	ScopeID     string // channelId for chats, threadChannelId for threads
	ChannelID   string
	ChannelName string
	ChannelType string

	LastMessageID         string
	LatestActivitySeq     *int64
	FirstUnreadMessageID  *string
	FirstMentionMessageID *string
	LastActivityAtMS      int64
	LastMessagePreview    string
	LastSenderType        string
	LastSenderID          string
	LastSenderName        *string
	UnreadCount           int64
	HasMention            bool
	ReadState             *ReadFrontier

	// Thread fields.
	ParentMessageID      string
	ParentChannelID      string
	ParentChannelName    string
	ParentChannelType    string
	ParentMessagePreview string
	ParentSenderType     string
	ParentSenderID       string
	LatestReplyAtMS      *int64
	ReplyCount           int64
	IsFollowing          bool
	UnfollowedAtMS       *int64

	// Completion states (Done/unfollowed history lists).
	DoneAtMS *int64

	// AnyMention is the read-state-independent mention fact (Mentions filter).
	AnyMention bool

	// mentionOnly marks the non-member public mention rows.
	mentionOnly bool
}

// readFrontierOf projects the #632 SSOT union for one cursor row.
func readFrontierOf(row *readStateRow, latestID string, latestSeq *int64) *ReadFrontier {
	if row == nil {
		return &ReadFrontier{Kind: "absent"}
	}
	f := &ReadFrontier{Kind: "present", Version: row.version, MaxReadSeq: row.lastReadSeq}
	if latestID != "" && latestSeq != nil {
		f.LatestID = latestID
		f.LatestSeq = *latestSeq
		f.LatestValid = true
	}
	return f
}

// wireTime renders the legacy ISO-8601 millisecond wire form.
func wireTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// Wire renders the exact TS InboxItem JSON shape (JSON key order is not
// significant to the consumers; Go's map marshaling sorts keys stably).
func (i InboxItem) Wire() map[string]any {
	latestSeq := any(nil)
	if i.LatestActivitySeq != nil {
		latestSeq = formatUint64(uint64(*i.LatestActivitySeq))
	}
	nullString := func(p *string) any {
		if p == nil {
			return nil
		}
		return *p
	}
	readState := any(map[string]any{"kind": "absent"})
	if i.ReadState != nil {
		switch i.ReadState.Kind {
		case "present":
			present := map[string]any{
				"kind":             "present",
				"readStateVersion": i.ReadState.Version,
				"maxReadSeq":       formatUint64(uint64(i.ReadState.MaxReadSeq)),
			}
			if i.ReadState.LatestValid {
				present["latestActivity"] = map[string]any{
					"messageId": i.ReadState.LatestID,
					"seq":       formatUint64(uint64(i.ReadState.LatestSeq)),
				}
			} else {
				present["latestActivity"] = nil
			}
			readState = present
		default:
			readState = map[string]any{"kind": i.ReadState.Kind}
		}
	}
	if i.Kind == "thread" {
		var lastReplyAt any
		if i.LatestReplyAtMS != nil {
			lastReplyAt = wireTime(*i.LatestReplyAtMS)
		}
		item := map[string]any{
			"kind":                     "thread",
			"threadChannelId":          i.ScopeID,
			"parentMessageId":          i.ParentMessageID,
			"parentChannelId":          i.ParentChannelID,
			"parentChannelName":        i.ParentChannelName,
			"parentChannelType":        i.ParentChannelType,
			"parentMessagePreview":     i.ParentMessagePreview,
			"parentMessageSenderType":  i.ParentSenderType,
			"parentMessageSenderId":    i.ParentSenderID,
			"latestActivityPreview":    i.LastMessagePreview,
			"latestActivitySenderKind": i.LastSenderType,
			"latestActivitySenderId":   i.LastSenderID,
			"latestActivitySenderName": nullString(i.LastSenderName),
			"latestActivityMessageId":  i.LastMessageID,
			"latestActivitySeq":        latestSeq,
			"firstUnreadMessageId":     nullString(i.FirstUnreadMessageID),
			"firstMentionMessageId":    nullString(i.FirstMentionMessageID),
			"lastActivityAt":           wireTime(i.LastActivityAtMS),
			"lastReplyAt":              lastReplyAt,
			"replyCount":               i.ReplyCount,
			"unreadCount":              i.UnreadCount,
			"hasMention":               i.HasMention,
			"taskNumber":               nil,
			"taskStatus":               nil,
			"taskClaimedByName":        nil,
			"readState":                readState,
			"isFollowing":              i.IsFollowing,
		}
		if i.UnfollowedAtMS != nil {
			item["unfollowedAt"] = wireTime(*i.UnfollowedAtMS)
		}
		if i.DoneAtMS != nil {
			item["doneAt"] = wireTime(*i.DoneAtMS)
		}
		return item
	}
	item := map[string]any{
		"kind":                  i.Kind,
		"channelId":             i.ChannelID,
		"channelName":           i.ChannelName,
		"channelType":           i.ChannelType,
		"lastMessageId":         i.LastMessageID,
		"latestActivitySeq":     latestSeq,
		"firstUnreadMessageId":  nullString(i.FirstUnreadMessageID),
		"firstMentionMessageId": nullString(i.FirstMentionMessageID),
		"lastMessageAt":         wireTime(i.LastActivityAtMS),
		"lastMessagePreview":    i.LastMessagePreview,
		"lastMessageSenderKind": i.LastSenderType,
		"lastMessageSenderId":   i.LastSenderID,
		"lastMessageSenderName": nullString(i.LastSenderName),
		"unreadCount":           i.UnreadCount,
		"hasMention":            i.HasMention,
		"readState":             readState,
	}
	if i.DoneAtMS != nil {
		item["doneAt"] = wireTime(*i.DoneAtMS)
	}
	return item
}

// hiddenAllPredicate excludes the hidden (private) #all projection.
const hiddenAllPredicate = ` NOT (c.name = 'all' AND c.type <> 'channel') `

// chatEligibilityPredicate is the frozen Activity-fact eligibility of one
// chat message for one viewer (inboxPolicyModel semantics, made durable via
// mute epochs):
//
//	eligible  := personally mentions the viewer (mentions always pierce)
//	          OR NOT suppressed-by-an-epoch-active-when-the-message-committed.
//
// An epoch covers a message when mute_from_seq <= seq <= suppressed_through
// (NULL = still open). Announcement channels carry an implicit epoch from
// seq 0 while the viewer has neither an explicit mute row nor any epoch —
// ordinary announcement traffic never reads as loud unread. Unmuting closes
// the epoch at the then-current max seq, so previously suppressed facts are
// never backfilled. The current activity_muted flag is deliberately NOT
// consulted here: recomputing from it would resurrect history.
//
// Parameters: ?1 = viewer user id; binds `m` (messages) and `c` (channels).
const chatEligibilityPredicate = ` (
	EXISTS (SELECT 1 FROM message_mentions mm
	        WHERE mm.message_id = m.id AND mm.workspace_id = m.workspace_id
	          AND mm.user_id = ?1)
	OR NOT (
	    EXISTS (
	        SELECT 1 FROM user_channel_mute_epochs e
	        WHERE e.workspace_id = m.workspace_id AND e.user_id = ?1
	          AND e.channel_id = m.channel_id
	          AND m.seq >= e.mute_from_seq
	          AND (e.suppressed_through_seq IS NULL OR m.seq <= e.suppressed_through_seq)
	    )
	    OR (
	        COALESCE(c.system_kind, '') = 'announcement'
	        AND NOT EXISTS (SELECT 1 FROM user_channel_mute_states ms
	                        WHERE ms.workspace_id = m.workspace_id AND ms.user_id = ?1
	                          AND ms.channel_id = m.channel_id)
	        AND NOT EXISTS (SELECT 1 FROM user_channel_mute_epochs ee
	                        WHERE ee.workspace_id = m.workspace_id AND ee.user_id = ?1
	                          AND ee.channel_id = m.channel_id)
	    )
	)
) `

// channelParentAccessPredicate answers "is the parent channel readable for
// this user": public channels workspace-wide, private channels and human DMs
// by roster/pair membership.
const channelParentAccessPredicate = ` (
	pc.type = 'channel'
	OR EXISTS (SELECT 1 FROM channel_humans pch
	           WHERE pch.channel_id = pc.id AND pch.user_id = ?)
	OR EXISTS (SELECT 1 FROM direct_messages pdm
	           WHERE pdm.workspace_id = pc.workspace_id
	             AND pdm.channel_id = pc.id
	             AND (pdm.user_low = ? OR pdm.user_high = ?))
) `

// chatCandidate is one eligible chat row from Q1.
type chatCandidate struct {
	id          string
	name        string
	channelType string
	lastRead    int64
	muteFrom    *int64
}

// threadCandidate is one followed/unfollowed thread row from Q2.
type threadCandidate struct {
	threadID          string
	parentMessageID   string
	parentChannelID   string
	parentChannelName string
	parentChannelType string
	parentPreview     string
	parentSenderType  string
	parentSenderID    string
	parentCreatedAt   int64
	parentSeq         int64
	lastRead          int64
	unfollowedAt      *int64
}

// InboxItems computes the unified human Inbox page. All reads share one
// pinned DEFERRED snapshot; counts come from visible message facts (never
// seq subtraction across scopes) and the caller's own projections only.
func (s *Store) InboxItems(ctx context.Context, claims auth.AccessTokenClaims, workspaceID string, query InboxQuery) (InboxPage, error) {
	var page InboxPage
	err := s.readSnapshot(ctx, s.db, func(ex Executor) error {
		if err := s.validateHuman(ctx, ex, claims, s.now()); err != nil {
			return err
		}
		role, err := membershipRoleTx(ctx, ex, workspaceID, claims.Subject)
		if err != nil {
			return err
		}
		if role == "" {
			return forbidden("Not a member of this server")
		}
		includeUnfollowed := query.Filter == FilterAll
		// The frozen guest gate: honestly empty aggregated surfaces.
		if role == "guest" {
			page = InboxPage{Items: []InboxItem{}, Groups: []InboxGroup{}}
			return nil
		}
		items, err := s.assembleInboxItems(ctx, ex, workspaceID, claims.Subject, query.Filter, includeUnfollowed)
		if err != nil {
			return err
		}
		page, err = assembleInboxPage(items, query)
		return err
	})
	return page, err
}

// assembleInboxItems loads every candidate family and enriches it.
func (s *Store) assembleInboxItems(ctx context.Context, ex Executor, workspaceID, userID, filter string, includeUnfollowed bool) ([]InboxItem, error) {
	chats, err := loadChatCandidates(ctx, ex, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	threads, err := loadThreadCandidates(ctx, ex, workspaceID, userID, false)
	if err != nil {
		return nil, err
	}
	var unfollowed []threadCandidate
	if includeUnfollowed {
		unfollowed, err = loadThreadCandidates(ctx, ex, workspaceID, userID, true)
		if err != nil {
			return nil, err
		}
	}
	channelAgg, err := loadChannelAggregates(ctx, ex, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	threadAgg, err := loadThreadAggregates(ctx, ex, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	senderNames, err := loadSenderNames(ctx, ex, workspaceID, userID, chats, threads, unfollowed, channelAgg, threadAgg)
	if err != nil {
		return nil, err
	}

	items := []InboxItem{}
	// Chat rows require a promotion-eligible latest message (the INNER LATERAL
	// of the reference queries): a chat whose every message is muted or own
	// never surfaces, in any filter.
	for _, chat := range chats {
		agg := channelAgg[chat.id]
		if agg == nil {
			// A channel with no message aggregates has no promotion-eligible
			// latest and never surfaces.
			continue
		}
		latest := agg.promotionLatest
		if latest == nil {
			continue
		}
		item := InboxItem{
			Kind:        map[bool]string{true: "dm", false: "channel"}[chat.channelType == "dm"],
			ScopeID:     chat.id,
			ChannelID:   chat.id,
			ChannelName: chat.name,
			ChannelType: chat.channelType,
			ReadState:   readFrontierOf(agg.readState, latest.id, &latest.seq),
		}
		fillChannelItem(&item, chat, agg, latest, senderNames)
		items = append(items, item)
	}
	for _, thread := range threads {
		agg := threadAgg[thread.threadID]
		item, ok := buildThreadItem(thread, agg, senderNames, true)
		if !ok {
			continue
		}
		items = append(items, item)
	}
	for _, thread := range unfollowed {
		agg := threadAgg[thread.threadID]
		item, ok := buildThreadItem(thread, agg, senderNames, false)
		if !ok {
			continue
		}
		items = append(items, item)
	}
	if filter == FilterUnread || filter == FilterMentions || filter == FilterUnreadMentions {
		mentionItems, err := s.buildMentionItems(ctx, ex, workspaceID, userID, channelAgg, threadAgg, senderNames)
		if err != nil {
			return nil, err
		}
		items = append(items, mentionItems...)
	}
	return items, nil
}

// channelAggregate carries the per-channel facts of one viewer.
type channelAggregate struct {
	readState       *readStateRow
	promotionLatest *messageFacts
	anyLatest       *messageFacts
	unreadCount     int64
	firstUnreadID   *string
	firstMentionID  *string
	anyMention      bool
	firstMentionSeq *int64
}

// threadAggregate carries per-thread reply facts. replies keeps the per-reply
// facts (seq asc) so the unfollowed projection can cap activity at the exact
// unfollow boundary instead of falling back past it.
type threadAggregate struct {
	readState      *readStateRow
	replyCount     int64
	lastReply      *messageFacts
	replies        []messageFacts
	firstUnreadID  *string
	unreadCount    int64
	firstMentionID *string
	anyMention     bool
}

type messageFacts struct {
	id         string
	seq        int64
	content    string
	senderType string
	senderID   string
	createdAt  int64
}

func fillChannelItem(item *InboxItem, chat chatCandidate, agg *channelAggregate, latest *messageFacts, names map[string]string) {
	item.LastMessageID = latest.id
	seq := latest.seq
	item.LatestActivitySeq = &seq
	item.LastActivityAtMS = latest.createdAt
	item.LastMessagePreview = latest.content
	item.LastSenderType = latest.senderType
	item.LastSenderID = latest.senderID
	if name, ok := names[latest.senderType+":"+latest.senderID]; ok {
		item.LastSenderName = &name
	}
	item.UnreadCount = agg.unreadCount
	item.FirstUnreadMessageID = agg.firstUnreadID
	item.FirstMentionMessageID = agg.firstMentionID
	item.HasMention = agg.firstMentionID != nil
	item.AnyMention = agg.anyMention
}

// buildThreadItem renders one thread row. followed=false marks the unfollowed
// projection: unread/mention are zeroed and the activity preview is capped at
// the unfollow boundary.
func buildThreadItem(thread threadCandidate, agg *threadAggregate, names map[string]string, followed bool) (InboxItem, bool) {
	item := InboxItem{
		Kind:                 "thread",
		ScopeID:              thread.threadID,
		ChannelName:          thread.parentChannelName,
		ChannelType:          thread.parentChannelType,
		ParentMessageID:      thread.parentMessageID,
		ParentChannelID:      thread.parentChannelID,
		ParentChannelName:    thread.parentChannelName,
		ParentChannelType:    thread.parentChannelType,
		ParentMessagePreview: thread.parentPreview,
		ParentSenderType:     thread.parentSenderType,
		ParentSenderID:       thread.parentSenderID,
		IsFollowing:          followed,
		UnfollowedAtMS:       nil,
	}
	var latest *messageFacts
	if followed {
		latest = agg.lastReply
	} else {
		latest = agg.lastReplyAtOrBefore(unfollowBoundaryOf(thread))
	}
	if latest == nil {
		// Zero replies (or everything after the unfollow): the parent message
		// is the activity frontier.
		latest = &messageFacts{
			id:         thread.parentMessageID,
			seq:        thread.parentSeq,
			content:    thread.parentPreview,
			senderType: thread.parentSenderType,
			senderID:   thread.parentSenderID,
			createdAt:  thread.parentCreatedAt,
		}
	}
	item.LastMessageID = latest.id
	seq := latest.seq
	item.LatestActivitySeq = &seq
	item.LastActivityAtMS = latest.createdAt
	item.LastMessagePreview = latest.content
	item.LastSenderType = latest.senderType
	item.LastSenderID = latest.senderID
	if name, ok := names[latest.senderType+":"+latest.senderID]; ok {
		item.LastSenderName = &name
	}
	if followed {
		item.ReplyCount = agg.replyCount
		item.UnreadCount = agg.unreadCount
		item.FirstUnreadMessageID = agg.firstUnreadID
		item.FirstMentionMessageID = agg.firstMentionID
		item.HasMention = agg.firstMentionID != nil
		item.AnyMention = agg.anyMention
		if agg.lastReply != nil {
			at := agg.lastReply.createdAt
			item.LatestReplyAtMS = &at
		}
		item.ReadState = readFrontierOf(agg.readState, latest.id, &latest.seq)
	} else {
		item.UnreadCount = 0
		item.HasMention = false
		item.IsFollowing = false
		if thread.unfollowedAt != nil {
			at := *thread.unfollowedAt
			item.UnfollowedAtMS = &at
		}
		item.ReadState = readFrontierOf(agg.readState, latest.id, &latest.seq)
	}
	return item, true
}

// lastReplyAtOrBefore caps the unfollowed-thread activity at the unfollow
// boundary. The boundary is derived from the shared unfollowed_at fact: the
// newest reply whose committed timestamp is at or before the unfollow.
func (a *threadAggregate) lastReplyAtOrBefore(boundaryMS int64) *messageFacts {
	if a == nil {
		return nil
	}
	var newest *messageFacts
	for i := range a.replies {
		if a.replies[i].createdAt <= boundaryMS {
			if newest == nil || a.replies[i].seq > newest.seq {
				fact := a.replies[i]
				newest = &fact
			}
		}
	}
	return newest
}

// unfollowBoundaryOf derives the unfollow timestamp boundary in milliseconds.
func unfollowBoundaryOf(thread threadCandidate) int64 {
	if thread.unfollowedAt != nil {
		return *thread.unfollowedAt
	}
	return 0
}

// loadChatCandidates runs Q1 (eligible chats).
func loadChatCandidates(ctx context.Context, ex Executor, workspaceID, userID string) ([]chatCandidate, error) {
	rows, err := ex.QueryContext(ctx, `
		SELECT c.id, COALESCE(c.name, ''), c.type,
		       COALESCE(rc.last_read_seq, 0), mu.mute_from_seq
		FROM channels c
		LEFT JOIN user_channel_read_states rc
		  ON rc.workspace_id = c.workspace_id AND rc.user_id = ? AND rc.channel_id = c.id
		LEFT JOIN user_channel_mute_states mu
		  ON mu.workspace_id = c.workspace_id AND mu.user_id = ? AND mu.channel_id = c.id
		 AND c.type IN ('channel', 'private', 'joint') AND mu.activity_muted = 1
		WHERE c.workspace_id = ?
		  AND c.deleted_at IS NULL AND c.archived_at IS NULL
		  AND c.type IN ('channel', 'private', 'dm')
		  AND `+hiddenAllPredicate+`
		  AND (
		    (c.system_kind = 'all' AND c.type = 'channel')
		    OR c.system_kind = 'announcement'
		    OR EXISTS (SELECT 1 FROM channel_humans ch
		               WHERE ch.channel_id = c.id AND ch.user_id = ?)
		    OR EXISTS (SELECT 1 FROM direct_messages dm
		               WHERE dm.workspace_id = c.workspace_id AND dm.channel_id = c.id
		                 AND (dm.user_low = ? OR dm.user_high = ?))
		  )
		  AND NOT EXISTS (
		    SELECT 1 FROM user_channel_done_states d
		    WHERE d.workspace_id = c.workspace_id AND d.user_id = ? AND d.channel_id = c.id
		      AND d.done_at IS NOT NULL
		      AND d.done_through_activity_seq >=
		          COALESCE((SELECT MAX(m.seq) FROM messages m
		                    WHERE m.workspace_id = c.workspace_id AND m.channel_id = c.id), 0)
		  )
		ORDER BY c.id`,
		userID, userID, workspaceID, userID, userID, userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []chatCandidate{}
	for rows.Next() {
		var c chatCandidate
		var mute sql.NullInt64
		if err := rows.Scan(&c.id, &c.name, &c.channelType, &c.lastRead, &mute); err != nil {
			return nil, err
		}
		if mute.Valid {
			v := mute.Int64
			c.muteFrom = &v
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// loadThreadCandidates runs Q2. unfollowed=false selects active follows
// (effective-done excluded); true selects explicit unfollow history. The
// query and its arguments are built together so every placeholder binds in
// text order regardless of the branch.
func loadThreadCandidates(ctx context.Context, ex Executor, workspaceID, userID string, unfollowed bool) ([]threadCandidate, error) {
	query := `
		SELECT t.id, pm.id, pc.id, COALESCE(pc.name, ''), pc.type,
		       pm.content, pm.sender_type, pm.sender_id, pm.created_at, pm.seq,
		       COALESCE(rc.last_read_seq, 0), tf.unfollowed_at
		FROM thread_follows tf
		JOIN channels t
		  ON t.id = tf.thread_channel_id AND t.workspace_id = tf.workspace_id
		 AND t.type = 'thread' AND t.deleted_at IS NULL
		JOIN messages pm ON pm.id = t.parent_message_id AND pm.workspace_id = t.workspace_id
		JOIN channels pc ON pc.id = pm.channel_id AND pc.workspace_id = t.workspace_id
		  AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
		  AND NOT (pc.name = 'all' AND pc.type <> 'channel')
		  AND (
		    pc.type = 'channel'
		    OR EXISTS (SELECT 1 FROM channel_humans pch
		               WHERE pch.channel_id = pc.id AND pch.user_id = ?1)
		    OR EXISTS (SELECT 1 FROM direct_messages pdm
		               WHERE pdm.workspace_id = pc.workspace_id AND pdm.channel_id = pc.id
		                 AND (pdm.user_low = ?1 OR pdm.user_high = ?1))
		  )
		LEFT JOIN user_channel_read_states rc
		  ON rc.workspace_id = t.workspace_id AND rc.user_id = ?1 AND rc.channel_id = t.id
		WHERE tf.workspace_id = ?2 AND tf.user_id = ?1`
	args := []any{userID, workspaceID}
	if unfollowed {
		query += ` AND tf.unfollowed_at IS NOT NULL`
	} else {
		query += `
		  AND tf.unfollowed_at IS NULL
		  AND NOT EXISTS (
		    SELECT 1 FROM user_channel_done_states d
		    WHERE d.workspace_id = t.workspace_id AND d.user_id = ?1 AND d.channel_id = t.id
		      AND d.done_at IS NOT NULL
		      AND d.done_through_activity_seq >=
		          COALESCE(
		            (SELECT MAX(r.seq) FROM messages r
		             WHERE r.workspace_id = t.workspace_id AND r.channel_id = t.id),
		            (SELECT p2.seq FROM messages p2
		             WHERE p2.id = t.parent_message_id AND p2.workspace_id = t.workspace_id)
		          )
		  )`
	}
	query += ` ORDER BY t.id`
	rows, err := ex.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []threadCandidate{}
	for rows.Next() {
		var t threadCandidate
		var unfollowedAt sql.NullInt64
		if err := rows.Scan(&t.threadID, &t.parentMessageID, &t.parentChannelID,
			&t.parentChannelName, &t.parentChannelType, &t.parentPreview,
			&t.parentSenderType, &t.parentSenderID, &t.parentCreatedAt,
			&t.parentSeq, &t.lastRead, &unfollowedAt); err != nil {
			return nil, err
		}
		if unfollowedAt.Valid {
			v := unfollowedAt.Int64
			t.unfollowedAt = &v
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// loadChannelAggregates computes the per-channel viewer facts in three set
// queries: latest/promotion-eligible latest message, unread window, mentions.
func loadChannelAggregates(ctx context.Context, ex Executor, workspaceID, userID string) (map[string]*channelAggregate, error) {
	out := map[string]*channelAggregate{}

	// Any-latest per channel (SQLite's MAX bare-column rule picks the row
	// holding the maximum, which is the documented behavior we rely on).
	rows, err := ex.QueryContext(ctx, `
		SELECT m.channel_id, m.id, m.content, m.sender_type, m.sender_id, m.created_at, MAX(m.seq)
		FROM messages m
		WHERE m.workspace_id = ?
		GROUP BY m.channel_id`, workspaceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID string
		f := &messageFacts{}
		if err := rows.Scan(&channelID, &f.id, &f.content, &f.senderType, &f.senderID, &f.createdAt, &f.seq); err != nil {
			rows.Close()
			return nil, err
		}
		agg := out[channelID]
		if agg == nil {
			agg = &channelAggregate{}
			out[channelID] = agg
		}
		agg.anyLatest = f
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Promotion-eligible latest: chatEligibilityPredicate decides Activity
	// promotion; own messages never promote. Mute never applies to threads,
	// and this query only feeds chat rows.
	rows, err = ex.QueryContext(ctx, `
		SELECT m.channel_id, m.id, m.content, m.sender_type, m.sender_id, m.created_at, MAX(m.seq)
		FROM messages m
		JOIN channels c ON c.id = m.channel_id AND c.workspace_id = m.workspace_id
		WHERE m.workspace_id = ?2
		  AND NOT (m.sender_type = 'user' AND m.sender_id = ?1)
		  AND `+chatEligibilityPredicate+`
		GROUP BY m.channel_id`,
		userID, workspaceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID string
		f := &messageFacts{}
		if err := rows.Scan(&channelID, &f.id, &f.content, &f.senderType, &f.senderID, &f.createdAt, &f.seq); err != nil {
			rows.Close()
			return nil, err
		}
		agg := out[channelID]
		if agg == nil {
			agg = &channelAggregate{}
			out[channelID] = agg
		}
		agg.promotionLatest = f
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Activity unread window per channel: messages above the caller's cursor
	// that are ELIGIBLE Activity facts (own messages never count; suppressed
	// ordinary messages do not count here even though they stay channel
	// catch-up unread on GET /channels/unread — the two domains are frozen
	// separately by inboxPolicyModel.test.ts:1190-1245). The first unread id
	// resolves in a second pass (SQLite select-list subqueries cannot
	// reference group aggregates portably).
	unreadFirstSeq := map[string]int64{}
	rows, err = ex.QueryContext(ctx, `
		SELECT m.channel_id, COUNT(*), MIN(m.seq)
		FROM messages m
		JOIN channels c ON c.id = m.channel_id AND c.workspace_id = m.workspace_id
		LEFT JOIN user_channel_read_states rc
		  ON rc.workspace_id = m.workspace_id AND rc.channel_id = m.channel_id AND rc.user_id = ?1
		WHERE m.workspace_id = ?2
		  AND m.seq > COALESCE(rc.last_read_seq, 0)
		  AND NOT (m.sender_type = 'user' AND m.sender_id = ?1)
		  AND `+chatEligibilityPredicate+`
		GROUP BY m.channel_id`,
		userID, workspaceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID string
		var count, minSeq int64
		if err := rows.Scan(&channelID, &count, &minSeq); err != nil {
			rows.Close()
			return nil, err
		}
		agg := out[channelID]
		if agg == nil {
			agg = &channelAggregate{}
			out[channelID] = agg
		}
		agg.unreadCount = count
		unreadFirstSeq[channelID] = minSeq
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Mentions per channel: first unread-scoped (the @ badge) plus any
	// notifiable mention (the Mentions filter is read-state independent).
	mentionFirstSeq := map[string]int64{}
	rows, err = ex.QueryContext(ctx, `
		SELECT mm2.channel_id,
		       MIN(CASE WHEN mm2.seq > COALESCE(rc.last_read_seq, 0) THEN mm2.seq END),
		       MAX(mm2.seq)
		FROM (
		    SELECT mm.message_id, mm.workspace_id, m.channel_id, m.seq
		    FROM message_mentions mm
		    JOIN messages m ON m.id = mm.message_id AND m.workspace_id = mm.workspace_id
		    WHERE mm.workspace_id = ? AND mm.user_id = ?
		) mm2
		LEFT JOIN user_channel_read_states rc
		  ON rc.workspace_id = mm2.workspace_id AND rc.channel_id = mm2.channel_id AND rc.user_id = ?
		GROUP BY mm2.channel_id`,
		workspaceID, userID, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID string
		var firstMention sql.NullInt64
		var maxMention sql.NullInt64
		if err := rows.Scan(&channelID, &firstMention, &maxMention); err != nil {
			rows.Close()
			return nil, err
		}
		agg := out[channelID]
		if agg == nil {
			agg = &channelAggregate{}
			out[channelID] = agg
		}
		if maxMention.Valid {
			agg.anyMention = true
		}
		if firstMention.Valid {
			v := firstMention.Int64
			agg.firstMentionSeq = &v
			mentionFirstSeq[channelID] = v
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Resolve the first-unread / first-mention message ids for the seqs
	// collected above.
	idByChannelSeq, err := resolveMessageIDs(ctx, ex, workspaceID, unreadFirstSeq, mentionFirstSeq)
	if err != nil {
		return nil, err
	}
	for channelID, seq := range unreadFirstSeq {
		if id, ok := idByChannelSeq[channelID+"/"+formatUint64(uint64(seq))]; ok {
			v := id
			out[channelID].firstUnreadID = &v
		}
	}
	for channelID, seq := range mentionFirstSeq {
		if agg := out[channelID]; agg != nil {
			if id, ok := idByChannelSeq[channelID+"/"+formatUint64(uint64(seq))]; ok {
				v := id
				agg.firstMentionID = &v
			}
		}
	}

	// Attach the caller's cursor rows for the read-state projection.
	rows, err = ex.QueryContext(ctx, `
		SELECT channel_id, last_read_seq, read_state_version
		FROM user_channel_read_states
		WHERE workspace_id = ? AND user_id = ?`, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID string
		var row readStateRow
		if err := rows.Scan(&channelID, &row.lastReadSeq, &row.version); err != nil {
			rows.Close()
			return nil, err
		}
		agg := out[channelID]
		if agg == nil {
			agg = &channelAggregate{}
			out[channelID] = agg
		}
		agg.readState = &row
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	return out, nil
}

// loadThreadAggregates computes reply facts for every thread channel of the
// workspace (mute never suppresses thread promotion).
func loadThreadAggregates(ctx context.Context, ex Executor, workspaceID, userID string) (map[string]*threadAggregate, error) {
	out := map[string]*threadAggregate{}
	rows, err := ex.QueryContext(ctx, `
		SELECT t.id, COUNT(r.id),
		       (SELECT r2.id FROM messages r2
		        WHERE r2.workspace_id = t.workspace_id AND r2.channel_id = t.id
		        ORDER BY r2.seq DESC LIMIT 1)
		FROM channels t
		LEFT JOIN messages r
		  ON r.workspace_id = t.workspace_id AND r.channel_id = t.id
		WHERE t.workspace_id = ? AND t.type = 'thread'
		GROUP BY t.id`, workspaceID)
	if err != nil {
		return nil, err
	}
	type threadBase struct {
		replyCount  int64
		lastReplyID *string
	}
	bases := map[string]threadBase{}
	for rows.Next() {
		var id string
		var base threadBase
		var lastID sql.NullString
		if err := rows.Scan(&id, &base.replyCount, &lastID); err != nil {
			rows.Close()
			return nil, err
		}
		if lastID.Valid {
			v := lastID.String
			base.lastReplyID = &v
		}
		bases[id] = base
		out[id] = &threadAggregate{replyCount: base.replyCount}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Reply facts per thread: every reply row feeds the boundary-capped
	// unfollowed projection; the newest one is the followed-thread frontier.
	rows, err = ex.QueryContext(ctx, `
		SELECT m.channel_id, m.id, m.content, m.sender_type, m.sender_id, m.created_at, m.seq
		FROM messages m
		JOIN channels t ON t.id = m.channel_id AND t.workspace_id = m.workspace_id AND t.type = 'thread'
		WHERE m.workspace_id = ?
		ORDER BY m.seq ASC`, workspaceID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID string
		var f messageFacts
		if err := rows.Scan(&channelID, &f.id, &f.content, &f.senderType, &f.senderID, &f.createdAt, &f.seq); err != nil {
			rows.Close()
			return nil, err
		}
		agg := out[channelID]
		if agg == nil {
			continue
		}
		agg.replies = append(agg.replies, f)
		fact := f
		agg.lastReply = &fact
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// Unread windows and mentions inside the thread channels.
	threadUnreadFirstSeq := map[string]int64{}
	rows, err = ex.QueryContext(ctx, `
		SELECT m.channel_id, COUNT(*), MIN(m.seq)
		FROM messages m
		JOIN channels t ON t.id = m.channel_id AND t.workspace_id = m.workspace_id AND t.type = 'thread'
		LEFT JOIN user_channel_read_states rc
		  ON rc.workspace_id = m.workspace_id AND rc.channel_id = m.channel_id AND rc.user_id = ?
		WHERE m.workspace_id = ?
		  AND m.seq > COALESCE(rc.last_read_seq, 0)
		  AND NOT (m.sender_type = 'user' AND m.sender_id = ?)
		GROUP BY m.channel_id`,
		userID, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID string
		var count, minSeq int64
		if err := rows.Scan(&channelID, &count, &minSeq); err != nil {
			rows.Close()
			return nil, err
		}
		if agg := out[channelID]; agg != nil {
			agg.unreadCount = count
			threadUnreadFirstSeq[channelID] = minSeq
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	threadMentionFirstSeq := map[string]int64{}
	rows, err = ex.QueryContext(ctx, `
		SELECT mm2.channel_id,
		       MIN(CASE WHEN mm2.seq > COALESCE(rc.last_read_seq, 0) THEN mm2.seq END),
		       MAX(mm2.seq)
		FROM (
		    SELECT mm.message_id, mm.workspace_id, m.channel_id, m.seq
		    FROM message_mentions mm
		    JOIN messages m ON m.id = mm.message_id AND m.workspace_id = mm.workspace_id
		    JOIN channels t ON t.id = m.channel_id AND t.workspace_id = m.workspace_id AND t.type = 'thread'
		    WHERE mm.workspace_id = ? AND mm.user_id = ?
		) mm2
		LEFT JOIN user_channel_read_states rc
		  ON rc.workspace_id = mm2.workspace_id AND rc.channel_id = mm2.channel_id AND rc.user_id = ?
		GROUP BY mm2.channel_id`,
		workspaceID, userID, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID string
		var firstMention, maxMention sql.NullInt64
		if err := rows.Scan(&channelID, &firstMention, &maxMention); err != nil {
			rows.Close()
			return nil, err
		}
		agg := out[channelID]
		if agg == nil {
			continue
		}
		if maxMention.Valid {
			agg.anyMention = true
		}
		if firstMention.Valid {
			threadMentionFirstSeq[channelID] = firstMention.Int64
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	threadIDByChannelSeq, err := resolveMessageIDs(ctx, ex, workspaceID, threadUnreadFirstSeq, threadMentionFirstSeq)
	if err != nil {
		return nil, err
	}
	for channelID, seq := range threadUnreadFirstSeq {
		if agg := out[channelID]; agg != nil {
			if id, ok := threadIDByChannelSeq[channelID+"/"+formatUint64(uint64(seq))]; ok {
				v := id
				agg.firstUnreadID = &v
			}
		}
	}
	for channelID, seq := range threadMentionFirstSeq {
		if agg := out[channelID]; agg != nil {
			if id, ok := threadIDByChannelSeq[channelID+"/"+formatUint64(uint64(seq))]; ok {
				v := id
				agg.firstMentionID = &v
			}
		}
	}

	rows, err = ex.QueryContext(ctx, `
		SELECT channel_id, last_read_seq, read_state_version
		FROM user_channel_read_states
		WHERE workspace_id = ? AND user_id = ?`, workspaceID, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var channelID string
		var row readStateRow
		if err := rows.Scan(&channelID, &row.lastReadSeq, &row.version); err != nil {
			rows.Close()
			return nil, err
		}
		if agg := out[channelID]; agg != nil {
			agg.readState = &row
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	return out, nil
}

// resolveMessageIDs loads message ids for the collected (channel, seq)
// minima using row values, keyed "channelID/seq".
func resolveMessageIDs(ctx context.Context, ex Executor, workspaceID string, sets ...map[string]int64) (map[string]string, error) {
	pairs := map[string]int64{}
	for _, set := range sets {
		for channelID, seq := range set {
			pairs[channelID+"/"+formatUint64(uint64(seq))] = seq
		}
	}
	if len(pairs) == 0 {
		return map[string]string{}, nil
	}
	keys := make([]string, 0, len(pairs))
	for key := range pairs {
		keys = append(keys, key)
	}
	sortStrings(keys)
	valuesClause := make([]string, 0, len(keys))
	args := make([]any, 0, len(keys)*2+1)
	args = append(args, workspaceID)
	for _, key := range keys {
		var channelID string
		var seq int64
		fmtSscanf(key, &channelID, &seq)
		valuesClause = append(valuesClause, "(?, ?)")
		args = append(args, channelID, seq)
	}
	query := `SELECT channel_id, id, seq FROM messages
		WHERE workspace_id = ? AND (channel_id, seq) IN (VALUES ` +
		strings.Join(valuesClause, ", ") + `)`
	rows, err := ex.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var channelID, id string
		var seq int64
		if err := rows.Scan(&channelID, &id, &seq); err != nil {
			return nil, err
		}
		out[channelID+"/"+formatUint64(uint64(seq))] = id
	}
	return out, rows.Err()
}

func sortStrings(list []string) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j] < list[j-1]; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}

// fmtSscanf splits a "channelID/seq" key without pulling fmt's scanner in.
func fmtSscanf(key string, channelID *string, seq *int64) {
	idx := strings.LastIndex(key, "/")
	if idx < 0 {
		return
	}
	*channelID = key[:idx]
	*seq = parseInt64(key[idx+1:])
}

func parseInt64(raw string) int64 {
	var v int64
	negative := false
	for i, c := range raw {
		if i == 0 && c == '-' {
			negative = true
			continue
		}
		if c < '0' || c > '9' {
			return 0
		}
		v = v*10 + int64(c-'0')
	}
	if negative {
		return -v
	}
	return v
}
