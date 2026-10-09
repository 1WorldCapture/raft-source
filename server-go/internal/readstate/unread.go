package readstate

import (
	"context"
	"database/sql"

	"raft.local/server-go/internal/auth"
)

// ChannelUnreadEntry is the /channels/unread?summary=1 map value: counts
// plus the mention facts plus the #632 SSOT read frontier.
type ChannelUnreadEntry struct {
	UnreadCount   int64
	HasMention    bool
	HasAnyMention bool
	ReadState     *ReadFrontier
}

// UnreadCounts ports GET /channels/unread: per-scope unread counts computed
// from visible message facts (candidate scopes: public channels workspace-
// wide, private/DM by roster/pair membership, actively followed threads with
// readable parents). Never a seq subtraction across scopes; own messages
// never inflate the numbers and Done-suppressed scopes are excluded.
func (s *Store) UnreadCounts(ctx context.Context, claims auth.AccessTokenClaims, workspaceID string) (map[string]int64, error) {
	counts, _, err := s.unreadCountsTx(ctx, claims, workspaceID)
	return counts, err
}

// unreadCountsTx wraps the snapshot computation for the map/summary exits.
func (s *Store) unreadCountsTx(ctx context.Context, claims auth.AccessTokenClaims, workspaceID string) (map[string]int64, map[string]*readStateRow, error) {
	counts := map[string]int64{}
	cursors := map[string]*readStateRow{}
	err := s.readSnapshot(ctx, s.db, func(ex Executor) error {
		counts2, cursors2, err := s.unreadCountsInSnapshot(ctx, ex, claims, workspaceID)
		if err != nil {
			return err
		}
		for k, v := range counts2 {
			counts[k] = v
		}
		for k, v := range cursors2 {
			cursors[k] = v
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return counts, cursors, nil
}

// UnreadSummary ports GET /channels/unread?summary=1.
func (s *Store) UnreadSummary(ctx context.Context, claims auth.AccessTokenClaims, workspaceID string) (map[string]ChannelUnreadEntry, error) {
	summary := map[string]ChannelUnreadEntry{}
	err := s.readSnapshot(ctx, s.db, func(ex Executor) error {
		counts, cursors, err := s.unreadCountsInSnapshot(ctx, ex, claims, workspaceID)
		if err != nil {
			return err
		}
		for scopeID, count := range counts {
			summary[scopeID] = ChannelUnreadEntry{UnreadCount: count}
		}
		// Mention facts enrich the summary entries (any notifiable mention
		// plus the unread-scoped first mention). Done suppression applies:
		// a scope Done up to its frontier carries no mention badge, and the
		// durable mention-suppression boundary caps which Done'd mentions
		// still count.
		rows, err := ex.QueryContext(ctx, `
			SELECT mm2.channel_id,
			       MIN(CASE WHEN mm2.seq > COALESCE(rc.last_read_seq, 0) THEN mm2.seq END),
			       MAX(mm2.seq)
			FROM (
			    SELECT mm.message_id, mm.workspace_id, m.channel_id, m.seq
			    FROM message_mentions mm
			    JOIN messages m ON m.id = mm.message_id AND m.workspace_id = mm.workspace_id
			    WHERE mm.workspace_id = ?1 AND mm.user_id = ?2
			      AND m.seq > COALESCE((SELECT ms.done_through_seq
			                             FROM user_mention_suppressions ms
			                             WHERE ms.workspace_id = mm.workspace_id
			               AND ms.user_id = ?2 AND ms.channel_id = m.channel_id
			               AND ms.target_kind IN ('channel', 'dm')), 0)
			) mm2
			JOIN channels mc ON mc.id = mm2.channel_id AND mc.workspace_id = mm2.workspace_id
			LEFT JOIN user_channel_read_states rc
			  ON rc.workspace_id = mm2.workspace_id AND rc.channel_id = mm2.channel_id AND rc.user_id = ?2
			WHERE NOT EXISTS (
			    SELECT 1 FROM user_channel_done_states d
			    WHERE d.workspace_id = mm2.workspace_id AND d.user_id = ?2
			      AND d.channel_id = mm2.channel_id AND d.done_at IS NOT NULL
			      AND d.done_through_activity_seq >=
			          COALESCE((SELECT MAX(dm2.seq) FROM messages dm2
			                    WHERE dm2.workspace_id = mm2.workspace_id
			                    AND dm2.channel_id = mm2.channel_id), 0)
			)
			GROUP BY mm2.channel_id`,
			workspaceID, claims.Subject)
		if err != nil {
			return err
		}
		for rows.Next() {
			var channelID string
			var firstMention, maxMention sql.NullInt64
			if err := rows.Scan(&channelID, &firstMention, &maxMention); err != nil {
				rows.Close()
				return err
			}
			entry, ok := summary[channelID]
			if !ok {
				entry = ChannelUnreadEntry{UnreadCount: 0}
			}
			entry.HasAnyMention = maxMention.Valid
			entry.HasMention = firstMention.Valid
			summary[channelID] = entry
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		for scopeID, entry := range summary {
			row := cursors[scopeID]
			if row == nil {
				entry.ReadState = &ReadFrontier{Kind: "absent"}
			} else {
				entry.ReadState = &ReadFrontier{Kind: "present", Version: row.version, MaxReadSeq: row.lastReadSeq}
			}
			summary[scopeID] = entry
		}
		return nil
	})
	return summary, err
}

// unreadCountsInSnapshot computes counts+cursors on an existing snapshot
// executor. Numbered parameters (?1 user, ?2 workspace) keep the binding
// order obvious across the UNION branches.
func (s *Store) unreadCountsInSnapshot(ctx context.Context, ex Executor, claims auth.AccessTokenClaims, workspaceID string) (map[string]int64, map[string]*readStateRow, error) {
	counts := map[string]int64{}
	cursors := map[string]*readStateRow{}
	if err := s.validateHuman(ctx, ex, claims, s.now()); err != nil {
		return nil, nil, err
	}
	role, err := membershipRoleTx(ctx, ex, workspaceID, claims.Subject)
	if err != nil {
		return nil, nil, err
	}
	if role == "" {
		return nil, nil, forbidden("Not a member of this server")
	}
	if role == "guest" {
		return counts, cursors, nil
	}
	rows, err := ex.QueryContext(ctx, `
		SELECT cc.scope_id, cc.last_read_seq, cc.version,
		       (SELECT COUNT(*) FROM messages m
		        WHERE m.workspace_id = cc.workspace_id
		          AND m.channel_id = cc.scope_id
		          AND m.seq > cc.last_read_seq
		          AND NOT (m.sender_type = 'user' AND m.sender_id = ?1))
		FROM (
		    SELECT c.id AS scope_id, c.workspace_id,
		           COALESCE(rc.last_read_seq, 0) AS last_read_seq,
		           rc.read_state_version AS version
		    FROM channels c
		    LEFT JOIN user_channel_read_states rc
		      ON rc.workspace_id = c.workspace_id AND rc.channel_id = c.id AND rc.user_id = ?1
		    WHERE c.workspace_id = ?2
		      AND c.deleted_at IS NULL AND c.archived_at IS NULL
		      AND c.type IN ('channel', 'private', 'dm')
		      AND NOT (c.name = 'all' AND c.type <> 'channel')
		      AND (
		        c.type = 'channel'
		        OR EXISTS (SELECT 1 FROM channel_humans ch
		                   WHERE ch.channel_id = c.id AND ch.user_id = ?1)
		        OR EXISTS (SELECT 1 FROM `+humanDMParticipantsSQL+` dm
		                   WHERE dm.workspace_id = c.workspace_id AND dm.channel_id = c.id
		                 AND (dm.user_low = ?1 OR dm.user_high = ?1))
		      )
		    UNION ALL
		    SELECT t.id AS scope_id, t.workspace_id,
		           COALESCE(rc2.last_read_seq, 0) AS last_read_seq,
		           rc2.read_state_version AS version
		    FROM thread_follows tf
		    JOIN channels t
		      ON t.id = tf.thread_channel_id AND t.workspace_id = tf.workspace_id
		     AND t.type = 'thread' AND t.deleted_at IS NULL
		    JOIN messages pm ON pm.id = t.parent_message_id AND pm.workspace_id = t.workspace_id
		    JOIN channels pc ON pc.id = pm.channel_id AND pc.workspace_id = t.workspace_id
		      AND pc.deleted_at IS NULL AND pc.archived_at IS NULL
		      AND NOT (pc.name = 'all' AND pc.type <> 'channel')
		    LEFT JOIN user_channel_read_states rc2
		      ON rc2.workspace_id = t.workspace_id AND rc2.channel_id = t.id AND rc2.user_id = ?1
		    WHERE tf.workspace_id = ?2 AND tf.user_id = ?1 AND tf.unfollowed_at IS NULL
		      AND (
		        pc.type = 'channel'
		        OR EXISTS (SELECT 1 FROM channel_humans pch
		                   WHERE pch.channel_id = pc.id AND pch.user_id = ?1)
		        OR EXISTS (SELECT 1 FROM `+humanDMParticipantsSQL+` pdm
		                   WHERE pdm.workspace_id = pc.workspace_id AND pdm.channel_id = pc.id
		                 AND (pdm.user_low = ?1 OR pdm.user_high = ?1))
		      )
		) cc
		WHERE NOT EXISTS (
		    SELECT 1 FROM user_channel_done_states d
		    WHERE d.workspace_id = cc.workspace_id AND d.user_id = ?1
		      AND d.channel_id = cc.scope_id AND d.done_at IS NOT NULL
		      AND d.done_through_activity_seq >=
		          COALESCE((SELECT MAX(m2.seq) FROM messages m2
		                    WHERE m2.workspace_id = cc.workspace_id
		                    AND m2.channel_id = cc.scope_id), 0)
		)`,
		claims.Subject, workspaceID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var scopeID string
		var lastRead int64
		var version sql.NullInt64
		var count int64
		if err := rows.Scan(&scopeID, &lastRead, &version, &count); err != nil {
			return nil, nil, err
		}
		if version.Valid {
			// A real cursor row exists (version is NOT NULL on stored rows).
			cursors[scopeID] = &readStateRow{lastReadSeq: lastRead, version: version.Int64}
		}
		if count > 0 {
			counts[scopeID] = count
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return counts, cursors, nil
}

// ServerUnreadEntry is one /servers/unread-summary row.
type ServerUnreadEntry struct {
	ServerID            string
	UnreadCount         int64
	ServerPushMuted     bool
	ActivityUnreadCount int64
	ActivityKnown       bool
}

// ServerUnreadSummary ports GET /servers/unread-summary: the account-level
// per-workspace sidebar totals (joined/implicit channels plus DMs; threads
// only feed the Activity number) with the membership's serverPushMuted flag.
func (s *Store) ServerUnreadSummary(ctx context.Context, claims auth.AccessTokenClaims) ([]ServerUnreadEntry, error) {
	out := []ServerUnreadEntry{}
	err := s.readSnapshot(ctx, s.db, func(ex Executor) error {
		if err := s.validateHuman(ctx, ex, claims, s.now()); err != nil {
			return err
		}
		rows, err := ex.QueryContext(ctx, `
			SELECT m.workspace_id, COALESCE(m.server_push_muted, 0)
			FROM workspace_memberships m
			JOIN workspaces w ON w.id = m.workspace_id
			WHERE m.user_id = ? AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'
			ORDER BY m.workspace_id`,
			claims.Subject)
		if err != nil {
			return err
		}
		type membershipRow struct {
			workspaceID string
			pushMuted   bool
		}
		memberships := []membershipRow{}
		for rows.Next() {
			var mr membershipRow
			var muted int64
			if err := rows.Scan(&mr.workspaceID, &muted); err != nil {
				rows.Close()
				return err
			}
			mr.pushMuted = muted == 1
			memberships = append(memberships, mr)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		for _, membership := range memberships {
			entry := ServerUnreadEntry{
				ServerID:        membership.workspaceID,
				ServerPushMuted: membership.pushMuted,
				ActivityKnown:   true,
			}
			sidebar, err := s.sidebarUnreadTx(ctx, ex, claims, membership.workspaceID)
			if err != nil {
				return err
			}
			activity, err := s.activityUnreadForWorkspace(ctx, ex, claims, membership.workspaceID)
			if err != nil {
				return err
			}
			entry.UnreadCount = sidebar
			entry.ActivityUnreadCount = activity
			out = append(out, entry)
		}
		return nil
	})
	return out, err
}

// sidebarUnreadQuery computes the joined-channels+DMs sidebar total: public
// channels only when joined (or implicit), private/DM by membership.
const sidebarUnreadQuery = `
	SELECT SUM(unread.c)
	FROM (
	    SELECT COUNT(*) AS c
	    FROM messages m
	    JOIN channels ch
	      ON ch.id = m.channel_id AND ch.workspace_id = m.workspace_id
	     AND ch.deleted_at IS NULL AND ch.archived_at IS NULL
	     AND ch.type IN ('channel', 'private', 'dm')
	     AND NOT (ch.name = 'all' AND ch.type <> 'channel')
	    LEFT JOIN user_channel_read_states rc
	      ON rc.workspace_id = m.workspace_id AND rc.channel_id = m.channel_id
	     AND rc.user_id = ?1
	    WHERE m.workspace_id = ?2
	      AND m.seq > COALESCE(rc.last_read_seq, 0)
	      AND NOT (m.sender_type = 'user' AND m.sender_id = ?1)
	      AND (
	        (ch.system_kind = 'all' AND ch.type = 'channel')
	        OR ch.system_kind = 'announcement'
	        OR EXISTS (SELECT 1 FROM channel_humans chh
	                   WHERE chh.channel_id = ch.id AND chh.user_id = ?1)
	        OR EXISTS (SELECT 1 FROM ` + humanDMParticipantsSQL + ` dm
	                   WHERE dm.workspace_id = ch.workspace_id
	                 AND dm.channel_id = ch.id
	                 AND (dm.user_low = ?1 OR dm.user_high = ?1))
	      )
	) unread`

func (s *Store) sidebarUnreadTx(ctx context.Context, ex Executor, claims auth.AccessTokenClaims, workspaceID string) (int64, error) {
	var total sql.NullInt64
	if err := ex.QueryRowContext(ctx, sidebarUnreadQuery, claims.Subject, workspaceID).Scan(&total); err != nil {
		return 0, err
	}
	if total.Valid {
		return total.Int64, nil
	}
	return 0, nil
}

// activityUnreadForWorkspace totals the unread of the caller's active
// Activity rows (chats plus followed threads, Done-suppressed excluded).
func (s *Store) activityUnreadForWorkspace(ctx context.Context, ex Executor, claims auth.AccessTokenClaims, workspaceID string) (int64, error) {
	role, err := membershipRoleTx(ctx, ex, workspaceID, claims.Subject)
	if err != nil {
		return 0, err
	}
	if role == "" || role == "guest" {
		return 0, nil
	}
	var total sql.NullInt64
	err = ex.QueryRowContext(ctx, `
		SELECT SUM(unread.unread_count)
		FROM (
		    SELECT COUNT(*) AS unread_count
		    FROM messages m
		    JOIN channels c
		      ON c.id = m.channel_id AND c.workspace_id = m.workspace_id
		     AND c.deleted_at IS NULL AND c.archived_at IS NULL
		     AND c.type IN ('channel', 'private', 'dm')
		     AND NOT (c.name = 'all' AND c.type <> 'channel')
		    LEFT JOIN user_channel_read_states rc
		      ON rc.workspace_id = m.workspace_id AND rc.channel_id = m.channel_id
		     AND rc.user_id = ?1
		    WHERE m.workspace_id = ?2
		      AND m.seq > COALESCE(rc.last_read_seq, 0)
		      AND NOT (m.sender_type = 'user' AND m.sender_id = ?1)
		      AND `+chatEligibilityPredicate+`
		      AND (
		        (c.system_kind = 'all' AND c.type = 'channel')
		        OR c.system_kind = 'announcement'
		        OR EXISTS (SELECT 1 FROM channel_humans chh
		                   WHERE chh.channel_id = c.id AND chh.user_id = ?1)
		        OR EXISTS (SELECT 1 FROM `+humanDMParticipantsSQL+` dmq
		                   WHERE dmq.workspace_id = c.workspace_id
		                 AND dmq.channel_id = c.id
		                 AND (dmq.user_low = ?1 OR dmq.user_high = ?1))
		      )
		      AND NOT EXISTS (
		        SELECT 1 FROM user_channel_done_states d
		        WHERE d.workspace_id = c.workspace_id AND d.user_id = ?1
		          AND d.channel_id = c.id AND d.done_at IS NOT NULL
		          AND d.done_through_activity_seq >=
		              COALESCE((SELECT MAX(m2.seq) FROM messages m2
		                        WHERE m2.workspace_id = c.workspace_id
		                        AND m2.channel_id = c.id), 0)
		      )
		    UNION ALL
		    SELECT COUNT(*) AS unread_count
		    FROM messages m
		    JOIN channels t
		      ON t.id = m.channel_id AND t.workspace_id = m.workspace_id
		     AND t.type = 'thread' AND t.deleted_at IS NULL
		    JOIN thread_follows tf
		      ON tf.workspace_id = t.workspace_id AND tf.thread_channel_id = t.id
		     AND tf.user_id = ?1 AND tf.unfollowed_at IS NULL
		    LEFT JOIN user_channel_read_states rc2
		      ON rc2.workspace_id = m.workspace_id AND rc2.channel_id = m.channel_id
		     AND rc2.user_id = ?1
		    WHERE m.workspace_id = ?2
		      AND m.seq > COALESCE(rc2.last_read_seq, 0)
		      AND NOT (m.sender_type = 'user' AND m.sender_id = ?1)
		      AND NOT EXISTS (
		        SELECT 1 FROM user_channel_done_states d2
		        WHERE d2.workspace_id = t.workspace_id AND d2.user_id = ?1
		          AND d2.channel_id = t.id AND d2.done_at IS NOT NULL
		          AND d2.done_through_activity_seq >=
		              COALESCE((SELECT MAX(m3.seq) FROM messages m3
		                        WHERE m3.workspace_id = t.workspace_id
		                        AND m3.channel_id = t.id),
		                       (SELECT p2.seq FROM messages p2
		                        WHERE p2.id = t.parent_message_id
		                          AND p2.workspace_id = t.workspace_id), 0)
		      )
		) unread`,
		claims.Subject, workspaceID).Scan(&total)
	if err != nil {
		return 0, err
	}
	if total.Valid {
		return total.Int64, nil
	}
	return 0, nil
}
