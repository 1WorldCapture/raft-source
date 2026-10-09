package readstate

import (
	"context"
	"database/sql"
	"sort"
	"strings"

	"raft.local/server-go/internal/auth"
)

// loadSenderNames resolves the human/agent display labels for every sender
// referenced by the candidate rows (users first, then agents).
func loadSenderNames(ctx context.Context, ex Executor, workspaceID, userID string, chats []chatCandidate, threads, unfollowed []threadCandidate, channelAgg map[string]*channelAggregate, threadAgg map[string]*threadAggregate) (map[string]string, error) {
	needed := map[string]string{} // "type:id" -> placeholder
	add := func(senderType, senderID string) {
		if senderID == "" {
			return
		}
		needed[senderType+":"+senderID] = senderID
	}
	for _, thread := range append(append([]threadCandidate{}, threads...), unfollowed...) {
		add(thread.parentSenderType, thread.parentSenderID)
		if agg := threadAgg[thread.threadID]; agg != nil && agg.lastReply != nil {
			add(agg.lastReply.senderType, agg.lastReply.senderID)
		}
	}
	for _, chat := range chats {
		agg := channelAgg[chat.id]
		if agg == nil {
			continue
		}
		if agg.promotionLatest != nil {
			add(agg.promotionLatest.senderType, agg.promotionLatest.senderID)
		}
	}
	names := map[string]string{}
	userIDs := collectByPrefix(needed, "user")
	if len(userIDs) > 0 {
		rows, err := ex.QueryContext(ctx, `
			SELECT id, COALESCE(display_name, name) FROM users WHERE id IN (`+
			placeholders(len(userIDs))+`)`, userIDs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, name string
			if err := rows.Scan(&id, &name); err != nil {
				rows.Close()
				return nil, err
			}
			names["user:"+id] = name
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	agentIDs := collectByPrefix(needed, "agent")
	if len(agentIDs) > 0 {
		rows, err := ex.QueryContext(ctx, `
			SELECT id, COALESCE(display_name, name) FROM agents WHERE id IN (`+
			placeholders(len(agentIDs))+`)`, agentIDs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, name string
			if err := rows.Scan(&id, &name); err != nil {
				rows.Close()
				return nil, err
			}
			names["agent:"+id] = name
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return names, nil
}

func collectByPrefix(needed map[string]string, prefix string) []any {
	var out []any
	seen := map[string]bool{}
	for key, id := range needed {
		if strings.HasPrefix(key, prefix+":") && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].(string) < out[j].(string) })
	return out
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// buildMentionItems renders the non-member public-channel mention rows and
// the not-followed public-parent thread mention rows (unread/mentions/
// unread_mentions filters only). Every row's mention seq must exceed the
// durable mention-suppression boundary (Done or explicit unfollow).
func (s *Store) buildMentionItems(ctx context.Context, ex Executor, workspaceID, userID string, channelAgg map[string]*channelAggregate, threadAgg map[string]*threadAggregate, names map[string]string) ([]InboxItem, error) {
	items := []InboxItem{}
	// Public channel mentions for non-members.
	rows, err := ex.QueryContext(ctx, `
		SELECT c.id, COALESCE(c.name, ''), c.type,
		       COALESCE(rc.last_read_seq, 0),
		       m.id, m.seq, m.content, m.sender_type, m.sender_id, m.created_at,
		       MAX(m.seq)
		FROM message_mentions mm
		JOIN messages m ON m.id = mm.message_id AND m.workspace_id = mm.workspace_id
		JOIN channels c ON c.id = m.channel_id AND c.workspace_id = mm.workspace_id
		LEFT JOIN user_channel_read_states rc
		  ON rc.workspace_id = c.workspace_id AND rc.channel_id = c.id AND rc.user_id = ?
		WHERE mm.workspace_id = ? AND mm.user_id = ?
		  AND c.type = 'channel' AND c.deleted_at IS NULL AND c.archived_at IS NULL
		  AND NOT (c.name = 'all' AND c.type <> 'channel')
		  AND NOT EXISTS (SELECT 1 FROM channel_humans ch
		                  WHERE ch.channel_id = c.id AND ch.user_id = ?)
		  AND m.seq > COALESCE((SELECT ms.done_through_seq
		                         FROM user_mention_suppressions ms
		                         WHERE ms.workspace_id = c.workspace_id
		                           AND ms.user_id = ? AND ms.channel_id = c.id
		                           AND ms.target_kind = 'channel'), 0)
		GROUP BY c.id`,
		userID, workspaceID, userID, userID, userID)
	if err != nil {
		return nil, err
	}
	type mentionRow struct {
		channelID, channelName, channelType string
		lastRead                            int64
		message                             messageFacts
	}
	mentionRows := []mentionRow{}
	for rows.Next() {
		var r mentionRow
		var maxSeq sql.NullInt64
		if err := rows.Scan(&r.channelID, &r.channelName, &r.channelType, &r.lastRead,
			&r.message.id, &r.message.seq, &r.message.content, &r.message.senderType,
			&r.message.senderID, &r.message.createdAt, &maxSeq); err != nil {
			rows.Close()
			return nil, err
		}
		mentionRows = append(mentionRows, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for _, r := range mentionRows {
		item := InboxItem{
			Kind:                  "channel",
			ScopeID:               r.channelID,
			ChannelID:             r.channelID,
			ChannelName:           r.channelName,
			ChannelType:           r.channelType,
			LastMessageID:         r.message.id,
			LastActivityAtMS:      r.message.createdAt,
			LastMessagePreview:    r.message.content,
			LastSenderType:        r.message.senderType,
			LastSenderID:          r.message.senderID,
			UnreadCount:           0,
			HasMention:            true,
			AnyMention:            true,
			FirstMentionMessageID: &r.message.id,
			mentionOnly:           true,
		}
		seq := r.message.seq
		item.LatestActivitySeq = &seq
		if name, ok := names[r.message.senderType+":"+r.message.senderID]; ok {
			item.LastSenderName = &name
		}
		agg := channelAgg[r.channelID]
		if agg != nil && agg.readState != nil {
			item.ReadState = readFrontierOf(agg.readState, r.message.id, &r.message.seq)
		} else {
			item.ReadState = readFrontierOf(nil, "", nil)
		}
		items = append(items, item)
	}

	// Public-parent thread mentions for threads without an active follow.
	rows, err = ex.QueryContext(ctx, `
		SELECT t.id, pm.id, pc.id, COALESCE(pc.name, ''), pc.type,
		       pm.content, pm.sender_type, pm.sender_id, pm.created_at, pm.seq,
		       COALESCE(rc.last_read_seq, 0),
		       m.id, m.seq, m.content, m.sender_type, m.sender_id, m.created_at
		FROM message_mentions mm
		JOIN messages m ON m.id = mm.message_id AND m.workspace_id = mm.workspace_id
		JOIN channels t ON t.id = m.channel_id AND t.workspace_id = mm.workspace_id
		  AND t.type = 'thread' AND t.deleted_at IS NULL
		JOIN messages pm ON pm.id = t.parent_message_id AND pm.workspace_id = t.workspace_id
		JOIN channels pc ON pc.id = pm.channel_id AND pc.workspace_id = t.workspace_id
		  AND pc.type = 'channel' AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
		  AND NOT (pc.name = 'all' AND pc.type <> 'channel')
		LEFT JOIN user_channel_read_states rc
		  ON rc.workspace_id = t.workspace_id AND rc.channel_id = t.id AND rc.user_id = ?
		WHERE mm.workspace_id = ? AND mm.user_id = ?
		  AND NOT EXISTS (
		    SELECT 1 FROM thread_follows tf
		    WHERE tf.workspace_id = t.workspace_id AND tf.thread_channel_id = t.id
		      AND tf.user_id = ? AND tf.unfollowed_at IS NULL)
		  AND m.seq > COALESCE((SELECT ms.done_through_seq
		                         FROM user_mention_suppressions ms
		                         WHERE ms.workspace_id = t.workspace_id
		                           AND ms.user_id = ? AND ms.channel_id = t.id
		                           AND ms.target_kind = 'thread'), 0)
		GROUP BY t.id`,
		userID, workspaceID, userID, userID, userID)
	if err != nil {
		return nil, err
	}
	type threadMentionRow struct {
		thread threadCandidate
		last   messageFacts
	}
	threadRows := []threadMentionRow{}
	for rows.Next() {
		var r threadMentionRow
		if err := rows.Scan(&r.thread.threadID, &r.thread.parentMessageID,
			&r.thread.parentChannelID, &r.thread.parentChannelName,
			&r.thread.parentChannelType, &r.thread.parentPreview,
			&r.thread.parentSenderType, &r.thread.parentSenderID,
			&r.thread.parentCreatedAt, &r.thread.parentSeq, &r.thread.lastRead,
			&r.last.id, &r.last.seq, &r.last.content, &r.last.senderType,
			&r.last.senderID, &r.last.createdAt); err != nil {
			rows.Close()
			return nil, err
		}
		threadRows = append(threadRows, r)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for _, r := range threadRows {
		agg := threadAgg[r.thread.threadID]
		if agg == nil {
			agg = &threadAggregate{}
		}
		// The mention row's own latest activity is the mention message.
		item := InboxItem{
			Kind:                  "thread",
			ScopeID:               r.thread.threadID,
			ParentMessageID:       r.thread.parentMessageID,
			ParentChannelID:       r.thread.parentChannelID,
			ParentChannelName:     r.thread.parentChannelName,
			ParentChannelType:     r.thread.parentChannelType,
			ParentMessagePreview:  r.thread.parentPreview,
			ParentSenderType:      r.thread.parentSenderType,
			ParentSenderID:        r.thread.parentSenderID,
			LastMessageID:         r.last.id,
			LastActivityAtMS:      r.last.createdAt,
			LastMessagePreview:    r.last.content,
			LastSenderType:        r.last.senderType,
			LastSenderID:          r.last.senderID,
			UnreadCount:           0,
			HasMention:            true,
			AnyMention:            true,
			FirstMentionMessageID: &r.last.id,
			IsFollowing:           false,
			mentionOnly:           true,
		}
		seq := r.last.seq
		item.LatestActivitySeq = &seq
		if name, ok := names[r.last.senderType+":"+r.last.senderID]; ok {
			item.LastSenderName = &name
		}
		if agg.readState != nil {
			item.ReadState = readFrontierOf(agg.readState, r.last.id, &r.last.seq)
		} else {
			item.ReadState = readFrontierOf(nil, "", nil)
		}
		items = append(items, item)
	}
	return items, nil
}

// assembleInboxPage applies q/channelId/filter, sorts, pages and totals.
func assembleInboxPage(items []InboxItem, query InboxQuery) (InboxPage, error) {
	limit := query.Limit
	if limit <= 0 {
		limit = InboxDefaultLimit
	}
	if limit > InboxMaxLimit {
		limit = InboxMaxLimit
	}
	offset := query.Offset
	if offset < 0 {
		offset = 0
	}
	needle := ""
	if strings.TrimSpace(query.Q) != "" {
		needle = strings.ToLower(strings.TrimSpace(query.Q))
		if len(needle) > 200 {
			needle = needle[:200]
		}
	}
	channelFilter := query.ChannelID

	// q filters the caller's own visible list (never a search API).
	filtered := make([]InboxItem, 0, len(items))
	for _, item := range items {
		if needle != "" && !inboxItemMatches(item, needle) {
			continue
		}
		filtered = append(filtered, item)
	}
	// Group counts run over the q-filtered set, before the channelId filter
	// (the reference computes group_counts before selected).
	groups := groupInboxItems(filtered)

	selected := filtered
	if channelFilter != "" {
		selected = selected[:0:0]
		for _, item := range filtered {
			if item.Kind == "thread" {
				if item.ParentChannelID == channelFilter {
					selected = append(selected, item)
				}
				continue
			}
			if item.ChannelID == channelFilter {
				selected = append(selected, item)
			}
		}
	}

	// The per-filter row predicate.
	final := make([]InboxItem, 0, len(selected))
	for _, item := range selected {
		switch query.Filter {
		case FilterUnread:
			if item.UnreadCount <= 0 {
				continue
			}
		case FilterMentions:
			if !item.AnyMention {
				continue
			}
		case FilterUnreadMentions:
			if item.UnreadCount <= 0 || !item.HasMention {
				continue
			}
		}
		final = append(final, item)
	}

	asc := query.Sort == "asc"
	sort.SliceStable(final, func(i, j int) bool {
		a, b := final[i], final[j]
		if asc {
			a, b = b, a
		}
		if a.LastActivityAtMS != b.LastActivityAtMS {
			return a.LastActivityAtMS > b.LastActivityAtMS
		}
		if a.Kind != b.Kind {
			return a.Kind > b.Kind
		}
		return a.ScopeID > b.ScopeID
	})

	totalUnread := int64(0)
	for _, item := range final {
		totalUnread += item.UnreadCount
	}
	end := offset + limit
	hasMore := false
	if len(final) > end {
		hasMore = true
	} else {
		end = len(final)
	}
	if offset > len(final) {
		offset = len(final)
	}
	return InboxPage{
		Items:             final[offset:end],
		Groups:            groups,
		HasMore:           hasMore,
		TotalCount:        len(final),
		TotalUnreadCount:  int(totalUnread),
		ActiveUnreadCount: int(totalUnread),
	}, nil
}

func inboxItemMatches(item InboxItem, needle string) bool {
	haystacks := []string{
		strings.ToLower(item.ChannelName),
		strings.ToLower(item.ParentChannelName),
		strings.ToLower(item.LastMessagePreview),
		strings.ToLower(item.ParentMessagePreview),
	}
	if item.LastSenderName != nil {
		haystacks = append(haystacks, strings.ToLower(*item.LastSenderName))
	}
	for _, haystack := range haystacks {
		if strings.Contains(haystack, needle) {
			return true
		}
	}
	return false
}

// groupInboxItems aggregates per-channel counts (threads group under their
// parent channel; chats group under themselves).
func groupInboxItems(items []InboxItem) []InboxGroup {
	type groupKey struct{ id string }
	groups := map[string]*InboxGroup{}
	order := []string{}
	for _, item := range items {
		id := item.ChannelID
		if item.Kind == "thread" {
			id = item.ParentChannelID
		}
		g := groups[id]
		if g == nil {
			name := item.ChannelName
			gtype := item.ChannelType
			if item.Kind == "thread" {
				name = item.ParentChannelName
				gtype = item.ParentChannelType
			}
			g = &InboxGroup{ChannelID: id, ChannelName: name, ChannelType: gtype, LastActivityAt: wireTime(item.LastActivityAtMS)}
			groups[id] = g
			order = append(order, id)
		}
		g.Count++
		if item.LastActivityAtMS > 0 && wireTime(item.LastActivityAtMS) > g.LastActivityAt {
			g.LastActivityAt = wireTime(item.LastActivityAtMS)
		}
	}
	out := make([]InboxGroup, 0, len(order))
	sort.Strings(order)
	for _, id := range order {
		out = append(out, *groups[id])
	}
	return out
}

// DoneInboxItems ports GET /channels/inbox/done: the caller's durable Done
// history (channels/DMs plus threads) with permission rechecks so stale
// previews of revoked parents never leak.
func (s *Store) DoneInboxItems(ctx context.Context, claims auth.AccessTokenClaims, workspaceID string, query InboxQuery) (InboxPage, error) {
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
		if role == "guest" {
			page = InboxPage{Items: []InboxItem{}, Groups: []InboxGroup{}}
			return nil
		}
		channelRows, err := ex.QueryContext(ctx, `
			SELECT c.id, COALESCE(c.name, ''), c.type, d.done_at,
			       lm.id, lm.seq, lm.content, lm.sender_type, lm.sender_id, lm.created_at
			FROM user_channel_done_states d
			JOIN channels c ON c.id = d.channel_id AND c.workspace_id = d.workspace_id
			  AND c.type <> 'thread' AND c.deleted_at IS NULL AND c.archived_at IS NULL
			LEFT JOIN messages lm ON lm.id = (
			    SELECT m.id FROM messages m
			    WHERE m.workspace_id = c.workspace_id AND m.channel_id = c.id
			    ORDER BY m.seq DESC LIMIT 1)
			WHERE d.workspace_id = ? AND d.user_id = ? AND d.done_at IS NOT NULL
			  AND d.done_through_activity_seq >=
			      COALESCE((SELECT MAX(dl.seq) FROM messages dl
			                WHERE dl.workspace_id = c.workspace_id
			                  AND dl.channel_id = c.id), 0)
			  AND (c.type = 'channel'
			       OR EXISTS (SELECT 1 FROM channel_humans ch
			                  WHERE ch.channel_id = c.id AND ch.user_id = ?)
			       OR EXISTS (SELECT 1 FROM direct_messages dm
			                  WHERE dm.workspace_id = c.workspace_id AND dm.channel_id = c.id
			            AND (dm.user_low = ? OR dm.user_high = ?)))
			ORDER BY d.done_at DESC, c.id DESC`,
			workspaceID, claims.Subject, claims.Subject, claims.Subject, claims.Subject)
		if err != nil {
			return err
		}
		items := []InboxItem{}
		for channelRows.Next() {
			var channelID, channelName, channelType string
			var doneAt int64
			var lastID sql.NullString
			var lastSeq sql.NullInt64
			var lastContent, lastSenderType, lastSenderID sql.NullString
			var lastCreatedAt sql.NullInt64
			if err := channelRows.Scan(&channelID, &channelName, &channelType, &doneAt,
				&lastID, &lastSeq, &lastContent, &lastSenderType, &lastSenderID, &lastCreatedAt); err != nil {
				channelRows.Close()
				return err
			}
			item := InboxItem{
				Kind:        map[bool]string{true: "dm", false: "channel"}[channelType == "dm"],
				ScopeID:     channelID,
				ChannelID:   channelID,
				ChannelName: channelName,
				ChannelType: channelType,
				DoneAtMS:    &doneAt,
			}
			if lastID.Valid {
				item.LastMessageID = lastID.String
				seq := lastSeq.Int64
				item.LatestActivitySeq = &seq
				item.LastActivityAtMS = lastCreatedAt.Int64
				item.LastMessagePreview = lastContent.String
				item.LastSenderType = lastSenderType.String
				item.LastSenderID = lastSenderID.String
			}
			cursor, err := readStateForScopeTx(ctx, ex, workspaceID, claims.Subject, channelID)
			if err != nil {
				channelRows.Close()
				return err
			}
			var latestSeqPtr *int64
			if item.LatestActivitySeq != nil {
				latestSeqPtr = item.LatestActivitySeq
			}
			item.ReadState = readFrontierOf(cursor, item.LastMessageID, latestSeqPtr)
			items = append(items, item)
		}
		if err := channelRows.Err(); err != nil {
			channelRows.Close()
			return err
		}
		channelRows.Close()

		// Done threads with the parent-chain recheck.
		threadRows, err := ex.QueryContext(ctx, `
			SELECT t.id, pm.id, pc.id, COALESCE(pc.name, ''), pc.type,
			       pm.content, pm.sender_type, pm.sender_id, pm.created_at, pm.seq,
			       d.done_at
			FROM user_channel_done_states d
			JOIN channels t ON t.id = d.channel_id AND t.workspace_id = d.workspace_id
			  AND t.type = 'thread' AND t.deleted_at IS NULL
			JOIN messages pm ON pm.id = t.parent_message_id AND pm.workspace_id = t.workspace_id
			JOIN channels pc ON pc.id = pm.channel_id AND pc.workspace_id = t.workspace_id
			  AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
			WHERE d.workspace_id = ? AND d.user_id = ? AND d.done_at IS NOT NULL
			  AND d.done_through_activity_seq >=
			      COALESCE(
			        (SELECT MAX(dr.seq) FROM messages dr
			         WHERE dr.workspace_id = t.workspace_id AND dr.channel_id = t.id),
			        (SELECT dp.seq FROM messages dp
			         WHERE dp.id = t.parent_message_id AND dp.workspace_id = t.workspace_id), 0)
			ORDER BY d.done_at DESC, t.id DESC`,
			workspaceID, claims.Subject)
		if err != nil {
			return err
		}
		doneThreads := []doneThread{}
		for threadRows.Next() {
			var dt doneThread
			if err := threadRows.Scan(&dt.thread.threadID, &dt.thread.parentMessageID,
				&dt.thread.parentChannelID, &dt.thread.parentChannelName,
				&dt.thread.parentChannelType, &dt.thread.parentPreview,
				&dt.thread.parentSenderType, &dt.thread.parentSenderID,
				&dt.thread.parentCreatedAt, &dt.thread.parentSeq, &dt.doneAt); err != nil {
				threadRows.Close()
				return err
			}
			accessible, err := parentChannelAccessibleTx(ctx, ex, workspaceID, dt.thread.parentChannelID, dt.thread.parentChannelType, claims.Subject)
			if err != nil {
				threadRows.Close()
				return err
			}
			if !accessible {
				continue
			}
			doneThreads = append(doneThreads, dt)
		}
		if err := threadRows.Err(); err != nil {
			threadRows.Close()
			return err
		}
		threadRows.Close()

		threadAgg, err := loadThreadAggregates(ctx, ex, workspaceID, claims.Subject)
		if err != nil {
			return err
		}
		names, err := loadSenderNames(ctx, ex, workspaceID, claims.Subject, nil, threadsOf(doneThreads), nil, nil, threadAgg)
		if err != nil {
			return err
		}
		for _, dt := range doneThreads {
			agg := threadAgg[dt.thread.threadID]
			if agg == nil {
				agg = &threadAggregate{}
			}
			item, ok := buildThreadItem(dt.thread, agg, names, true)
			if !ok {
				continue
			}
			item.DoneAtMS = &dt.doneAt
			item.UnreadCount = 0
			item.HasMention = false
			items = append(items, item)
		}
		sort.SliceStable(items, func(i, j int) bool {
			a, b := items[i], items[j]
			if *a.DoneAtMS != *b.DoneAtMS {
				if query.Sort == "asc" {
					return *a.DoneAtMS < *b.DoneAtMS
				}
				return *a.DoneAtMS > *b.DoneAtMS
			}
			aIdentity := a.Kind + ":" + a.ScopeID
			bIdentity := b.Kind + ":" + b.ScopeID
			if query.Sort == "asc" {
				return aIdentity < bIdentity
			}
			return aIdentity > bIdentity
		})
		limit := query.Limit
		if limit <= 0 {
			limit = InboxDefaultLimit
		}
		if limit > InboxMaxLimit {
			limit = InboxMaxLimit
		}
		offset := query.Offset
		if offset < 0 {
			offset = 0
		}
		end := offset + limit
		if len(items) > end {
			page.HasMore = true
		} else {
			end = len(items)
		}
		if offset > len(items) {
			offset = len(items)
		}
		page.Items = items[offset:end]
		page.TotalCount = 0 // null on the wire: no total for history pages
		return nil
	})
	return page, err
}

// doneThread is one Done-history thread row.
type doneThread struct {
	thread threadCandidate
	doneAt int64
}

func threadsOf(done []doneThread) []threadCandidate {
	out := make([]threadCandidate, 0, len(done))
	for _, dt := range done {
		out = append(out, dt.thread)
	}
	return out
}

// parentChannelAccessibleTx rechecks the thread parent readability for the
// history projections.
func parentChannelAccessibleTx(ctx context.Context, ex Queryer, workspaceID, parentChannelID, parentType, userID string) (bool, error) {
	switch parentType {
	case "channel":
		return true, nil
	case "private":
		return isChannelHumanTx(ctx, ex, parentChannelID, userID)
	case "dm":
		dm, err := isDMParticipantTx(ctx, ex, workspaceID, parentChannelID, userID)
		if err != nil {
			return false, err
		}
		if dm {
			return true, nil
		}
		return isChannelHumanTx(ctx, ex, parentChannelID, userID)
	default:
		return false, nil
	}
}

// UnfollowedInboxItems ports GET /channels/inbox/unfollowed: the caller's
// explicit unfollow history across completion states, with previews capped at
// the unfollow boundary.
func (s *Store) UnfollowedInboxItems(ctx context.Context, claims auth.AccessTokenClaims, workspaceID string, query InboxQuery) (InboxPage, error) {
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
		if role == "guest" {
			page = InboxPage{Items: []InboxItem{}, Groups: []InboxGroup{}}
			return nil
		}
		unfollowed, err := loadThreadCandidates(ctx, ex, workspaceID, claims.Subject, true)
		if err != nil {
			return err
		}
		threadAgg, err := loadThreadAggregates(ctx, ex, workspaceID, claims.Subject)
		if err != nil {
			return err
		}
		names, err := loadSenderNames(ctx, ex, workspaceID, claims.Subject, nil, unfollowed, nil, nil, threadAgg)
		if err != nil {
			return err
		}
		items := []InboxItem{}
		for _, thread := range unfollowed {
			agg := threadAgg[thread.threadID]
			if agg == nil {
				agg = &threadAggregate{}
			}
			item, ok := buildThreadItem(thread, agg, names, false)
			if !ok {
				continue
			}
			items = append(items, item)
		}
		sort.SliceStable(items, func(i, j int) bool {
			a, b := items[i], items[j]
			aAt, bAt := int64(0), int64(0)
			if a.UnfollowedAtMS != nil {
				aAt = *a.UnfollowedAtMS
			}
			if b.UnfollowedAtMS != nil {
				bAt = *b.UnfollowedAtMS
			}
			if aAt != bAt {
				if query.Sort == "asc" {
					return aAt < bAt
				}
				return aAt > bAt
			}
			if query.Sort == "asc" {
				return a.ScopeID < b.ScopeID
			}
			return a.ScopeID > b.ScopeID
		})
		limit := query.Limit
		if limit <= 0 {
			limit = InboxDefaultLimit
		}
		if limit > InboxMaxLimit {
			limit = InboxMaxLimit
		}
		offset := query.Offset
		if offset < 0 {
			offset = 0
		}
		end := offset + limit
		if len(items) > end {
			page.HasMore = true
		} else {
			end = len(items)
		}
		if offset > len(items) {
			offset = len(items)
		}
		page.Items = items[offset:end]
		page.TotalCount = 0
		return nil
	})
	return page, err
}
