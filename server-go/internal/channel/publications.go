// Durable realtime intents for the two frozen M4 channel event families
// (docs/m4-compatibility-contract.md §4.2): channel:updated and
// channel:members-updated. M3 channel mutations historically produced no
// intents at all (docs/m4-realtime-integration-report.md §9.3); every
// mutation path now records its intent on the SAME db.WithWriteTx
// transaction, so the fact and its notification reference commit or roll
// back together, and a full publication backlog fails the mutation closed.
//
// Proposed dispatch contract for the composition layer (the parent wires the
// projector; this package only ever produces references):
//
//	channel:updated
//	  object_type "channel", object_id = scope_id = the channel id,
//	  subject_user_id empty. The publisher reprojects the CURRENT channel
//	  row and delivers ONE payload argument `channel:updated`
//	  {channel: <current authorized channel projection>} to every
//	  currently-authorized audience member — the TS publishChannelUpdate
//	  behavior (grant + emit, single DTO).
//
//	channel:members-updated
//	  object_type "channel", object_id = scope_id = the channel id,
//	  subject_user_id = the human whose membership was GAINED (add-member,
//	  role-change) or "" (removals, agent roster changes, self-join). The
//	  publisher delivers `channel:members-updated` {channelId} to the
//	  channel room for private channels, else the server room (TS
//	  emitChannelMembersUpdated); when the subject is set it ADDITIONALLY
//	  delivers the targeted `user:{subject}` channel:updated
//	  {channel: <current projection, joined:true>}.
//
// Intent rows never carry payload: no names, descriptions, roles or member
// lists ride the outbox. The publisher reprojects from current facts and
// re-authorizes every target at delivery time, so a revoked member can never
// receive a stale projection (revocation itself stays fail-closed on the
// realtime side and never depends on these notifications).
package channel

import (
	"context"
	"database/sql"
	"fmt"

	"raft.local/server-go/internal/publication"
)

// Publication event names on the frozen M4 wire (compatibility contract
// §4.2). Shared with the dispatcher through the realtime_publications rows
// only; the app layer must not import this package's private helpers.
const (
	PublicationEventChannelUpdated = "channel:updated"
	PublicationEventMembersUpdated = "channel:members-updated"
)

// nextChannelIntentRevision returns a revision strictly greater than every
// previously committed intent of the same (workspace, channel, event) key:
// max(transition time, committed frontier + 1). Intents written earlier in
// the SAME open transaction are visible to the query, so several membership
// transitions inside one transaction serialize into strictly increasing
// revisions. Rationale: the channels table has no revision/updated_at
// column, and the roster tables only carry per-ROW authority_revision —
// deleted rows lose it and two different members legitimately rest at the
// same row revision, so neither is a stable per-channel version. The
// committed-intent frontier itself is (same strategy as the dm:new intents),
// and it needs NO schema change: 0001-0013 stay frozen.
func (s *Store) nextChannelIntentRevision(ctx context.Context, ex Executor, workspaceID, channelID, eventType string) (int64, error) {
	var previous int64
	if err := ex.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(revision), 0) FROM realtime_publications
		WHERE workspace_id = ? AND object_type = 'channel' AND object_id = ? AND event_type = ?`,
		workspaceID, channelID, eventType).Scan(&previous); err != nil {
		return 0, fmt.Errorf("read channel %s revision frontier: %w", eventType, err)
	}
	revision := s.now().UnixMilli()
	if revision <= previous {
		revision = previous + 1
	}
	return revision, nil
}

// enqueueChannelUpdated records the channel:updated intent for a real
// channel-state transition (create, rename/description/visibility/guest
// policy, archive, unarchive) on the caller's write transaction.
func (s *Store) enqueueChannelUpdated(ctx context.Context, tx *sql.Tx, workspaceID, channelID string) error {
	revision, err := s.nextChannelIntentRevision(ctx, tx, workspaceID, channelID, PublicationEventChannelUpdated)
	if err != nil {
		return err
	}
	return publication.Enqueue(ctx, tx, publication.Publication{
		WorkspaceID: workspaceID,
		ObjectType:  "channel",
		ObjectID:    channelID,
		EventType:   PublicationEventChannelUpdated,
		Revision:    revision,
		ScopeID:     channelID,
	})
}

// enqueueMembersUpdated records the channel:members-updated intent for a
// real roster transition. subjectUserID is the human whose membership was
// gained ("" for removals, agent changes and self-joins) — it is a durable
// reference the publisher uses for the targeted joined-projection delivery,
// never a payload and never a room grant.
func (s *Store) enqueueMembersUpdated(ctx context.Context, tx *sql.Tx, workspaceID, channelID, subjectUserID string) error {
	revision, err := s.nextChannelIntentRevision(ctx, tx, workspaceID, channelID, PublicationEventMembersUpdated)
	if err != nil {
		return err
	}
	return publication.Enqueue(ctx, tx, publication.Publication{
		WorkspaceID:   workspaceID,
		ObjectType:    "channel",
		ObjectID:      channelID,
		EventType:     PublicationEventMembersUpdated,
		Revision:      revision,
		SubjectUserID: subjectUserID,
		ScopeID:       channelID,
	})
}
