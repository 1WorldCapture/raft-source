package app

// M4 realtime publication composition: this file owns the transactional-outbox
// publisher that turns durable realtime.Publication references into gateway
// deliveries. Every intent is reprojected from CURRENT facts, its authorized
// audience is resolved from CURRENT policy, and both are BOUND to the
// authority serial observed before the reads: the binding is re-checked
// inside the final guarded publish predicate, so a permission change that
// commits between projection and admission stops every further stale send
// (partial sends before the mismatch are allowed; clients dedupe stable ids).
// No database work and no network write ever happens under the admission
// fence or inside a database transaction here.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/realtime"
	"raft.local/server-go/internal/transport/socketio"
	"raft.local/server-go/internal/transport/socketio/core"
)

// unknownParkAttempts is the retry budget for a publication whose
// object/event pair has no projector in this binary. Retrying a permanently
// unprojectable type can never succeed and each row would otherwise occupy
// the bounded backlog forever (MaxPending blocks NEW intents), so after this
// many attempts the row is parked (marked processed) with a loud error log
// and a dedicated counter — an explicit, visible decision, never a silent
// drop, and never applied to transient failures.
const unknownParkAttempts = 8

// errUnknownPublication reports a publication the composition cannot project.
type errUnknownPublication struct {
	objectType, eventType string
}

func (e *errUnknownPublication) Error() string {
	return fmt.Sprintf("m4realtime: no projector for publication %s/%s", e.objectType, e.eventType)
}

// errAudienceStale reports that the authority serial moved between the
// audience/payload snapshot and the final admission. The intent is retained
// and reprojected; frames already admitted under the older snapshot stay
// (stable-id replay on the retry lets clients dedupe).
type errAudienceStale struct{}

func (errAudienceStale) Error() string {
	return "m4realtime: authority serial changed during publication projection"
}

// m4Publisher is the realtime.Publisher callback wired into
// realtime.Store.Start. Contract: nil means processed (published, parked, or
// the referenced fact is gone so there is nothing to deliver); an error means
// deferred — the durable intent is retried later.
type m4Publisher struct {
	db       *sql.DB
	gateway  *socketio.Gateway
	messages *message.Store
	channels *channel.Store
	log      *slog.Logger

	published  atomic.Uint64
	completed  atomic.Uint64 // facts gone: completed without a delivery
	deferred   atomic.Uint64
	unknown    atomic.Uint64 // unprojectable intents seen (deferred or parked)
	parked     atomic.Uint64 // unprojectable intents parked after the budget
	stale      atomic.Uint64 // serial-mismatch reprojections
	summaryHit atomic.Uint64
}

func newM4Publisher(handle *sql.DB, gateway *socketio.Gateway, messages *message.Store, channels *channel.Store, logger *slog.Logger) *m4Publisher {
	if logger == nil {
		logger = slog.Default()
	}
	return &m4Publisher{db: handle, gateway: gateway, messages: messages, channels: channels, log: logger}
}

type publisherStats struct {
	Published, Completed, Deferred, Unknown, Parked, Stale, SummaryInvalidations uint64
}

func (p *m4Publisher) stats() publisherStats {
	return publisherStats{
		Published: p.published.Load(), Completed: p.completed.Load(),
		Deferred: p.deferred.Load(), Unknown: p.unknown.Load(),
		Parked: p.parked.Load(), Stale: p.stale.Load(),
		SummaryInvalidations: p.summaryHit.Load(),
	}
}

// serial is the committed authority watermark: memory-only, safe inside the
// final guarded admission predicate.
func (p *m4Publisher) serial() uint64 { return db.AuthoritySerial(p.db) }

// publish dispatches one durable publication intent. Every branch resolves
// its payload and audience BEFORE any gateway call: the gateway's guard wraps
// only the per-connection fence check, the serial binding and the bounded
// enqueue.
func (p *m4Publisher) publish(ctx context.Context, ref realtime.Publication) error {
	err := p.dispatch(ctx, ref)
	if err != nil {
		p.deferred.Add(1)
		return err
	}
	return nil
}

func (p *m4Publisher) dispatch(ctx context.Context, ref realtime.Publication) error {
	switch {
	case ref.ObjectType == "message" && (ref.EventType == "message:new" || ref.EventType == "message:updated"):
		return p.publishMessageFact(ctx, ref)
	case ref.ObjectType == "reaction_viewer" && ref.EventType == "reaction_viewer:updated":
		return p.publishViewerSnapshot(ctx, ref)
	case ref.EventType == "thread:updated" && (ref.ObjectType == "thread" || ref.ObjectType == "channel"):
		// message worker: per-reply intent (object_type thread); channel
		// worker: durable thread appearance (object_type channel). Both
		// project through the message worker's thread projector.
		return p.publishThreadUpdated(ctx, ref)
	case ref.ObjectType == "channel" && ref.EventType == "dm:new":
		return p.publishDMNew(ctx, ref)
	case ref.ObjectType == "channel" && ref.EventType == channel.PublicationEventChannelUpdated:
		// channel worker's durable channel-state intents (create, rename,
		// visibility/guest policy, archive, unarchive): references only,
		// committed on the same transaction as the fact.
		return p.publishChannelUpdated(ctx, ref)
	case ref.ObjectType == "channel" && ref.EventType == channel.PublicationEventMembersUpdated:
		// channel worker's durable roster intents; SubjectUserID references
		// the human whose membership was gained ("" otherwise).
		return p.publishMembersUpdated(ctx, ref)
	case ref.ObjectType == "thread_follow" && ref.EventType == "thread:followers-updated":
		return p.publishFollowersUpdated(ctx, ref)
	case ref.ObjectType == "read_state" && ref.EventType == "read_state:updated":
		return p.publishReadState(ctx, ref)
	case ref.ObjectType == "read_state_bulk" && ref.EventType == "read_state:updated_bulk":
		return p.publishReadStateBulk(ctx, ref)
	case ref.ObjectType == "unread_summary" && ref.EventType == "unread_summary:changed":
		return p.publishUnreadSummary(ctx, ref)
	case ref.ObjectType == "notification_prefs" && ref.EventType == "notification_prefs:updated":
		return p.publishNotificationPrefs(ctx, ref)
	case ref.ObjectType == "message_display_prefs" && ref.EventType == "message_display_prefs:updated":
		return p.publishDisplayPrefs(ctx, ref)
	default:
		return p.unprojectable(ref)
	}
}

// unprojectable handles permanently invalid references uniformly: both an
// unknown object/event pair and a known private event missing its owner use
// the same explicit retry/parking budget. Transient database, cancellation or
// authority errors never enter this path and always retain their intent.
func (p *m4Publisher) unprojectable(ref realtime.Publication) error {
	p.unknown.Add(1)
	if ref.Attempts >= unknownParkAttempts {
		p.parked.Add(1)
		p.log.Error("m4realtime: unprojectable publication PARKED after retry budget",
			"object_type", ref.ObjectType, "event_type", ref.EventType, "object_id", ref.ObjectID,
			"attempts", ref.Attempts)
		return nil
	}
	p.log.Error("m4realtime: unprojectable publication deferred",
		"object_type", ref.ObjectType, "event_type", ref.EventType, "object_id", ref.ObjectID)
	return &errUnknownPublication{objectType: ref.ObjectType, eventType: ref.EventType}
}

// ---- shared conversation audience -----------------------------------------

// conversationAudience is the CURRENT policy audience of one shared
// conversation fact. live is who may receive live delivery for it (rooms are
// only a subscription index, never the authority); counting is whose unread
// state a new message there can change (threads count followers only).
// serial binds the whole resolution to the authority snapshot it was
// computed under.
type conversationAudience struct {
	channelID    string
	publicThread bool
	channelType  string
	live         map[string]struct{}
	counting     map[string]struct{}
	serial       uint64
}

// resolveConversationAudience applies the approved live rules on one read
// snapshot, captured under serial0:
//
//   - public channel           → live/counting = current workspace members;
//   - private channel          → roster members;
//   - dm                       → participants;
//   - thread on a public parent  → live candidates = current workspace members;
//     message events additionally intersect each socket's thread room,
//     counting = active followers;
//   - thread on private/DM root → live = counting = active followers ONLY;
//   - missing conversation or broken parent chain → exists=false (complete
//     without delivery).
func (p *m4Publisher) resolveConversationAudience(ctx context.Context, workspaceID, channelID string) (conversationAudience, bool, error) {
	serial0 := p.serial()
	out := conversationAudience{channelID: channelID, serial: serial0, live: map[string]struct{}{}, counting: map[string]struct{}{}}
	exists := false
	err := db.WithReadSnapshot(ctx, p.db, func(ex db.Executor) error {
		var chType string
		var parentType sql.NullString
		row := ex.QueryRowContext(ctx, `SELECT c.type,
				(SELECT pc.type FROM messages pm
				 JOIN channels pc ON pc.id = pm.channel_id AND pc.workspace_id = c.workspace_id
				 WHERE pm.id = c.parent_message_id AND pm.workspace_id = c.workspace_id)
			FROM channels c
			WHERE c.id = ? AND c.workspace_id = ? AND c.deleted_at IS NULL`,
			channelID, workspaceID)
		if err := row.Scan(&chType, &parentType); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			return err
		}
		exists = true
		out.channelType = chType
		out.publicThread = chType == "thread" && parentType.Valid && parentType.String == "channel"

		members := func() error {
			rows, err := ex.QueryContext(ctx, `SELECT m.user_id FROM workspace_memberships m
				JOIN workspaces w ON w.id = m.workspace_id
				WHERE m.workspace_id = ? AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`,
				workspaceID)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var userID string
				if err := rows.Scan(&userID); err != nil {
					return err
				}
				out.live[userID] = struct{}{}
				out.counting[userID] = struct{}{}
			}
			return rows.Err()
		}
		roster := func() error {
			rows, err := ex.QueryContext(ctx, `SELECT ch.user_id FROM channel_humans ch
				JOIN channels c ON c.id = ch.channel_id
				WHERE ch.channel_id = ? AND c.workspace_id = ? AND c.deleted_at IS NULL`,
				channelID, workspaceID)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var userID string
				if err := rows.Scan(&userID); err != nil {
					return err
				}
				out.live[userID] = struct{}{}
				out.counting[userID] = struct{}{}
			}
			return rows.Err()
		}
		followers := func() error {
			rows, err := ex.QueryContext(ctx, `SELECT user_id FROM thread_follows
				WHERE workspace_id = ? AND thread_channel_id = ? AND unfollowed_at IS NULL`,
				workspaceID, channelID)
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var userID string
				if err := rows.Scan(&userID); err != nil {
					return err
				}
				out.live[userID] = struct{}{}
				out.counting[userID] = struct{}{}
			}
			return rows.Err()
		}

		var audienceErr error
		switch {
		case chType == "channel":
			audienceErr = members()
		case chType == "private" || chType == "dm":
			audienceErr = roster()
		case chType == "thread":
			switch {
			case !parentType.Valid:
				exists = false // broken parent chain: nothing authorized
				return nil
			case parentType.String == "channel":
				if err := members(); err != nil {
					return err
				}
				// Interest is only a candidate set: a follow cannot grant
				// base content authority or bypass the frozen guest gate.
				out.counting = map[string]struct{}{}
				audienceErr = followersInto(ctx, out.counting, ex, workspaceID, channelID)
			default:
				audienceErr = followers()
			}
		default:
			exists = false
			return nil
		}
		if audienceErr != nil {
			return audienceErr
		}
		return p.authorizeAudienceSetsTx(ctx, ex, workspaceID, channelID, out.live, out.counting)
	})
	if err != nil {
		return conversationAudience{}, false, err
	}
	return out, exists, nil
}

// authorizeAudienceSetsTx narrows subscription/roster candidates through the
// SAME base content policy used by HTTP/history/join. It runs on the caller's
// snapshot, before guarded queue admission. In particular, a residual follow
// after private-parent removal, a guest with the feature gate disabled, or a
// malformed/deleted thread parent can never acquire live content authority.
// Infrastructure errors propagate so the durable intent remains retryable.
func (p *m4Publisher) authorizeAudienceSetsTx(ctx context.Context, ex db.Executor, workspaceID, channelID string, sets ...map[string]struct{}) error {
	checked := map[string]bool{}
	for _, users := range sets {
		for userID := range users {
			allowed, seen := checked[userID]
			if !seen {
				conversation, err := p.channels.AuthorizeConversationTx(ctx, ex, workspaceID, channelID, userID, false)
				if err != nil && channel.AsDomainError(err) == nil {
					return err
				}
				allowed = err == nil && conversation != nil
				checked[userID] = allowed
			}
			if !allowed {
				delete(users, userID)
			}
		}
	}
	return nil
}

func followersInto(ctx context.Context, target map[string]struct{}, ex db.Executor, workspaceID, threadID string) error {
	rows, err := ex.QueryContext(ctx, `SELECT user_id FROM thread_follows
		WHERE workspace_id = ? AND thread_channel_id = ? AND unfollowed_at IS NULL`,
		workspaceID, threadID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return err
		}
		target[userID] = struct{}{}
	}
	return rows.Err()
}

// audienceStale reports whether the authority serial moved past the
// audience's binding. Checked after every read set and inside every guarded
// predicate.
func (p *m4Publisher) audienceStale(a conversationAudience) bool { return p.serial() != a.serial }

// deliver sends one sealed payload to the audience's live set. The predicate
// runs inside the gateway's admission guard: workspace binding, current
// policy membership AND an unchanged authority serial — so a permission
// change that commits after the snapshot silently stops every further send
// without admitting a stale audience to a newly valid connection.
func (p *m4Publisher) deliver(a conversationAudience, workspaceID, event string, payload any) {
	_ = p.deliverContext(context.Background(), a, workspaceID, event, payload)
}

func (p *m4Publisher) deliverContext(ctx context.Context, a conversationAudience, workspaceID, event string, payload any) error {
	var rooms []string
	if a.publicThread && (event == core.EventMessageNew || event == core.EventMessageUpdated) {
		// Public-thread content is base-readable, not automatically live-
		// subscribed on every workspace socket. Followers joined at the
		// barrier and explicit viewers receive it on their thread room.
		rooms = []string{core.ChannelRoom(a.channelID)}
	}
	return p.deliverSetContext(ctx, a.serial, a.live, workspaceID, event, payload, rooms...)
}

// unreadSummaryPayload is the exact invalidation hint {serverId} — no counts
// are ever fabricated here; receivers re-read their real summary.
type unreadSummaryPayload struct {
	ServerID string `json:"serverId"`
}

// fanoutUnreadSummary delivers unread_summary:changed to every counting
// audience member except the acting sender (a user's own message never
// counts as their unread). Admission failures remain retryable through the
// durable owner; clients deduplicate any already-admitted message replay.
func (p *m4Publisher) fanoutUnreadSummary(ctx context.Context, a conversationAudience, workspaceID, senderID string) error {
	users := make(map[string]struct{}, len(a.counting))
	for userID := range a.counting {
		if userID != senderID {
			users[userID] = struct{}{}
		}
	}
	if len(users) == 0 {
		return nil
	}
	payload := unreadSummaryPayload{ServerID: workspaceID}
	if err := p.deliverSetContext(ctx, a.serial, users, workspaceID, core.EventUnreadSummary, payload); err != nil {
		return err
	}
	p.summaryHit.Add(1)
	return nil
}

// ---- message facts ---------------------------------------------------------

func (p *m4Publisher) publishMessageFact(ctx context.Context, ref realtime.Publication) error {
	serial0 := p.serial()
	projection, err := p.messages.ProjectPublication(ctx, message.PublicationRef{
		WorkspaceID: ref.WorkspaceID, ObjectType: ref.ObjectType, ObjectID: ref.ObjectID,
		EventType: ref.EventType, Revision: ref.Revision, SubjectUserID: ref.SubjectUserID,
	})
	if err != nil {
		return err
	}
	if projection == nil || projection.Message == nil {
		p.completed.Add(1)
		return nil
	}
	audience, exists, err := p.resolveConversationAudience(ctx, ref.WorkspaceID, projection.ChannelID)
	if err != nil {
		return err
	}
	if !exists {
		p.completed.Add(1)
		return nil
	}
	if p.serial() != serial0 || audience.serial != serial0 {
		p.stale.Add(1)
		return errAudienceStale{}
	}

	var payload any
	switch ref.EventType {
	case core.EventMessageNew:
		// The sealed creation payload: full shared DTO minus storage-only
		// columns, plus the creation-time conversation context. Built ONLY
		// through the message worker's socket projection seam.
		channelType, parent := "channel", &message.ThreadParentRef{}
		if cc := projection.ConversationContext; cc != nil {
			if cc.ChannelType != "" {
				channelType = cc.ChannelType
			}
			parent.ParentMessageID = cc.ParentMessageID
			parent.ParentChannelID = cc.ParentChannelID
			parent.ParentChannelType = cc.ParentChannelType
		}
		payload = message.SocketMessageNew(projection.Message, channelType, parent)
	case core.EventMessageUpdated:
		// The original reaction/aggregate emit attaches the same frontend
		// conversation context as message:new (messageService.ts:5715-5721):
		// without it, a thread reaction's message:updated loses its thread
		// scope on the client.
		payload = message.SocketMessageUpdatedInContext(projection.Message, projection.ConversationContext)
	default:
		return p.unprojectable(ref)
	}
	if err := p.deliverContext(ctx, audience, ref.WorkspaceID, ref.EventType, payload); err != nil {
		return err
	}
	p.published.Add(1)

	if ref.EventType == core.EventMessageNew {
		// DM message activity also re-announces the conversation itself: a
		// passive peer (sidebar-hidden, socket admitted before the DM
		// existed, never in any room for it) refreshes on {channelId}
		// exactly like the original pipeline (messageService.ts).
		if audience.channelType == "dm" {
			if err := p.deliverContext(ctx, audience, ref.WorkspaceID, core.EventDMNew, dmNewPayload{ChannelID: projection.ChannelID}); err != nil {
				return err
			}
		}
		// Unread invalidation for every other counting audience member.
		if err := p.fanoutUnreadSummary(ctx, audience, ref.WorkspaceID, projection.Message.SenderID); err != nil {
			return err
		}
	}
	return nil
}

// ---- viewer-private reaction snapshot --------------------------------------

func (p *m4Publisher) publishViewerSnapshot(ctx context.Context, ref realtime.Publication) error {
	if ref.SubjectUserID == "" {
		return p.unprojectable(ref)
	}
	serial0 := p.serial()
	projection, err := p.messages.ProjectPublication(ctx, message.PublicationRef{
		WorkspaceID: ref.WorkspaceID, ObjectType: ref.ObjectType, ObjectID: ref.ObjectID,
		EventType: ref.EventType, Revision: ref.Revision, SubjectUserID: ref.SubjectUserID,
	})
	if err != nil {
		return err
	}
	if projection == nil || projection.Viewer == nil {
		p.completed.Add(1)
		return nil
	}
	if p.serial() != serial0 {
		p.stale.Add(1)
		return errAudienceStale{}
	}
	// Viewer-private state goes ONLY to the subject's user+workspace
	// intersection room — never a shared channel room, whatever the
	// projection's ChannelID is.
	if err := p.deliverSetContext(ctx, serial0, map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, core.EventReactionViewer, projection.Viewer); err != nil {
		return err
	}
	p.published.Add(1)
	return nil
}

// ---- thread facts -----------------------------------------------------------

func (p *m4Publisher) publishThreadUpdated(ctx context.Context, ref realtime.Publication) error {
	serial0 := p.serial()
	projection, err := p.messages.ProjectPublication(ctx, message.PublicationRef{
		WorkspaceID: ref.WorkspaceID, ObjectType: "thread", ObjectID: ref.ObjectID,
		EventType: core.EventThreadUpdated, Revision: ref.Revision, SubjectUserID: ref.SubjectUserID,
	})
	if err != nil {
		return err
	}
	if projection == nil || projection.Thread == nil {
		p.completed.Add(1)
		return nil
	}
	audience, exists, err := p.resolveConversationAudience(ctx, ref.WorkspaceID, ref.ObjectID)
	if err != nil {
		return err
	}
	if !exists {
		p.completed.Add(1)
		return nil
	}
	if p.serial() != serial0 || audience.serial != serial0 {
		p.stale.Add(1)
		return errAudienceStale{}
	}
	// The projector carries the shared thread summary facts only — no
	// receiver-private unreadCount/firstUnreadMessageId/readState ever rides
	// this event; the workspace identity is the publication's own.
	thread := *projection.Thread
	thread.ServerID = ref.WorkspaceID
	if err := p.deliverContext(ctx, audience, ref.WorkspaceID, core.EventThreadUpdated, thread); err != nil {
		return err
	}
	p.published.Add(1)
	return nil
}

// ---- DM appearance -----------------------------------------------------------

// dmNewPayload is the exact wire shape {channelId} — never a channel DTO.
type dmNewPayload struct {
	ChannelID string `json:"channelId"`
}

func (p *m4Publisher) publishDMNew(ctx context.Context, ref realtime.Publication) error {
	audience, exists, err := p.resolveConversationAudience(ctx, ref.WorkspaceID, ref.ObjectID)
	if err != nil {
		return err
	}
	if !exists || audience.channelType != "dm" {
		p.completed.Add(1)
		return nil
	}
	if p.audienceStale(audience) {
		p.stale.Add(1)
		return errAudienceStale{}
	}
	if err := p.deliverContext(ctx, audience, ref.WorkspaceID, core.EventDMNew, dmNewPayload{ChannelID: ref.ObjectID}); err != nil {
		return err
	}
	p.published.Add(1)
	return nil
}

// ---- channel state / roster events -------------------------------------------
//
// The channel worker records durable references on the SAME transaction as
// the fact (internal/channel/publications.go): object_type "channel",
// object_id = scope_id = the channel id, revision strictly increasing per
// (workspace, channel, event) key. Intent rows carry no payload; everything
// below is reprojected from CURRENT facts under the authority-serial
// binding, exactly like the TS publishChannelUpdate /
// emitChannelMembersUpdated behaviors (channelRealtimeEvents.ts,
// channels.ts:385-402).

// channelEventFacts is one snapshot's worth of channel-event truth: the
// current channel row plus both policy audiences the two event families
// need. exists=false covers missing, deleted and cross-workspace channels:
// the publisher completes the intent without a delivery (deletion itself is
// fail-closed on the authority side and never rides these notifications).
type channelEventFacts struct {
	channel    *channel.Channel
	serial     uint64
	live       map[string]struct{} // channel:updated audience (base-authorized policy)
	serverRoom map[string]struct{} // members hint audience; private/DM scopes remain roster-only
	members    map[string]struct{} // actual current roster, not merely workspace visibility
}

func (p *m4Publisher) resolveChannelEventFacts(ctx context.Context, workspaceID, channelID string) (channelEventFacts, bool, error) {
	serial0 := p.serial()
	out := channelEventFacts{serial: serial0, live: map[string]struct{}{}, serverRoom: map[string]struct{}{}, members: map[string]struct{}{}}
	exists := false
	err := db.WithReadSnapshot(ctx, p.db, func(ex db.Executor) error {
		ch, err := p.channels.GetChannelTx(ctx, ex, channelID)
		if err != nil {
			return err
		}
		if ch == nil || ch.WorkspaceID != workspaceID {
			return nil // gone, deleted or a foreign workspace: complete silently
		}
		exists = true
		out.channel = ch
		if err := channelRosterInto(ctx, out.members, ex, workspaceID, channelID); err != nil {
			return err
		}

		members := func() error { return workspaceMembersInto(ctx, out.live, ex, workspaceID) }
		roster := func() error { return channelRosterInto(ctx, out.live, ex, workspaceID, channelID) }

		switch ch.Type {
		case channel.TypeChannel, channel.TypeJoint:
			// Public server-wide: both audiences are the workspace.
			if err := members(); err != nil {
				return err
			}
			for uid := range out.live {
				out.serverRoom[uid] = struct{}{}
			}
		case channel.TypePrivate:
			// Roster-only channel: both audiences are the roster.
			if err := roster(); err != nil {
				return err
			}
			for uid := range out.live {
				out.serverRoom[uid] = struct{}{}
			}
		case channel.TypeDM:
			// Generic membership intents must never turn a DM identifier
			// into a workspace-wide hint. Its policy audience is participants.
			if err := roster(); err != nil {
				return err
			}
			for uid := range out.live {
				out.serverRoom[uid] = struct{}{}
			}
		case channel.TypeThread:
			// Thread changes have their own parent-aware event projectors.
			// Do not invent a server-wide fallback for an unexpected generic
			// channel intent that might identify a private-parent thread.
			exists = false
			return nil
		default:
			exists = false
			return nil
		}
		return p.authorizeAudienceSetsTx(ctx, ex, workspaceID, channelID, out.live, out.serverRoom, out.members)
	})
	if err != nil {
		return channelEventFacts{}, false, err
	}
	return out, exists, nil
}

func workspaceMembersInto(ctx context.Context, target map[string]struct{}, ex db.Executor, workspaceID string) error {
	rows, err := ex.QueryContext(ctx, `SELECT m.user_id FROM workspace_memberships m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.workspace_id = ? AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`,
		workspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return err
		}
		target[userID] = struct{}{}
	}
	return rows.Err()
}

func channelRosterInto(ctx context.Context, target map[string]struct{}, ex db.Executor, workspaceID, channelID string) error {
	rows, err := ex.QueryContext(ctx, `SELECT ch.user_id FROM channel_humans ch
		JOIN channels c ON c.id = ch.channel_id
		WHERE ch.channel_id = ? AND c.workspace_id = ? AND c.deleted_at IS NULL`,
		channelID, workspaceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return err
		}
		target[userID] = struct{}{}
	}
	return rows.Err()
}

// deliverSet is deliver() over an explicit user set with the same serial
// binding inside the guarded predicate.
func (p *m4Publisher) deliverSet(serial0 uint64, users map[string]struct{}, workspaceID, event string, payload any) {
	_ = p.deliverSetContext(context.Background(), serial0, users, workspaceID, event, payload)
}

// deliverSetContext propagates acquisition/cancellation failures to the
// durable outbox. The serial is checked INSIDE admission for shared AND
// receiver-private projections; fresh sockets may not consume an old snapshot
// after reauthorization. A moved binding retains the intent for reprojection.
func (p *m4Publisher) deliverSetContext(ctx context.Context, serial0 uint64, users map[string]struct{}, workspaceID, event string, payload any, rooms ...string) error {
	err := p.gateway.PublishFilteredContext(ctx, rooms, event, payload, func(id core.Identity) bool {
		if id.WorkspaceID != workspaceID {
			return false
		}
		if _, ok := users[id.UserID]; !ok {
			return false
		}
		return p.serial() == serial0
	})
	if err != nil {
		return err
	}
	if p.serial() != serial0 {
		p.stale.Add(1)
		return errAudienceStale{}
	}
	return nil
}

// channelUpdatedPayload is the single-argument wire shape {channel} carrying
// the raw channel row projection — never a viewer-private envelope (read
// frontier, mute/display prefs live only in per-user surfaces).
type channelUpdatedPayload struct {
	Channel channel.Wire `json:"channel"`
}

func (p *m4Publisher) publishChannelUpdated(ctx context.Context, ref realtime.Publication) error {
	facts, exists, err := p.resolveChannelEventFacts(ctx, ref.WorkspaceID, ref.ObjectID)
	if err != nil {
		return err
	}
	if !exists {
		p.completed.Add(1)
		return nil
	}
	if p.serial() != facts.serial {
		p.stale.Add(1)
		return errAudienceStale{}
	}
	if err := p.deliverSetContext(ctx, facts.serial, facts.live, ref.WorkspaceID, core.EventChannelUpdated,
		channelUpdatedPayload{Channel: facts.channel.Wire()}); err != nil {
		return err
	}
	p.published.Add(1)
	return nil
}

// membersUpdatedPayload is the exact TS shape {channelId}.
type membersUpdatedPayload struct {
	ChannelID string `json:"channelId"`
}

func (p *m4Publisher) publishMembersUpdated(ctx context.Context, ref realtime.Publication) error {
	facts, exists, err := p.resolveChannelEventFacts(ctx, ref.WorkspaceID, ref.ObjectID)
	if err != nil {
		return err
	}
	if !exists {
		p.completed.Add(1)
		return nil
	}
	if p.serial() != facts.serial {
		p.stale.Add(1)
		return errAudienceStale{}
	}
	payload := membersUpdatedPayload{ChannelID: ref.ObjectID}
	if err := p.deliverSetContext(ctx, facts.serial, facts.serverRoom, ref.WorkspaceID, core.EventChannelMembers, payload); err != nil {
		return err
	}
	p.published.Add(1)

	// The TS pair: when a HUMAN's membership was gained, that user
	// additionally receives a targeted channel:updated carrying the current
	// projection with joined:true (channels.ts:390-392). The subject is a
	// durable reference from the intent, never a payload-supplied identity.
	if ref.SubjectUserID != "" {
		if _, stillMember := facts.members[ref.SubjectUserID]; stillMember {
			joined := struct {
				channel.Wire
				Joined bool `json:"joined"`
			}{Wire: facts.channel.Wire(), Joined: true}
			if err := p.deliverSetContext(ctx, facts.serial, map[string]struct{}{ref.SubjectUserID: {}},
				ref.WorkspaceID, core.EventChannelUpdated, map[string]any{"channel": joined}); err != nil {
				return err
			}
		}
	}
	return nil
}

// ---- thread follower interest -------------------------------------------------

// followersUpdatedPayload is {threadChannelId} only — follower-private state
// itself is never broadcast.
type followersUpdatedPayload struct {
	ThreadChannelID string `json:"threadChannelId"`
}

func (p *m4Publisher) publishFollowersUpdated(ctx context.Context, ref realtime.Publication) error {
	threadID := ref.ObjectID
	if ref.ScopeID != "" {
		threadID = ref.ScopeID
	}
	audience, exists, err := p.resolveConversationAudience(ctx, ref.WorkspaceID, threadID)
	if err != nil {
		return err
	}
	if !exists {
		p.completed.Add(1)
		return nil
	}
	if p.audienceStale(audience) {
		p.stale.Add(1)
		return errAudienceStale{}
	}
	if err := p.deliverContext(ctx, audience, ref.WorkspaceID, core.EventThreadFollowers,
		followersUpdatedPayload{ThreadChannelID: threadID}); err != nil {
		return err
	}
	p.published.Add(1)
	return nil
}

// privateScopeAllowedTx applies current content authority to a receiver-owned
// state reference. Owning a retained read/prefs row is not permission to the
// conversation; missing/revoked scopes complete silently, while infrastructure
// failures retain the durable intent for retry.
func (p *m4Publisher) privateScopeAllowedTx(ctx context.Context, ex db.Executor, ref realtime.Publication, scopeID string) (bool, error) {
	conversation, err := p.channels.AuthorizeConversationTx(ctx, ex, ref.WorkspaceID, scopeID, ref.SubjectUserID, false)
	if err != nil && channel.AsDomainError(err) != nil {
		return false, nil
	}
	return conversation != nil && err == nil, err
}

// ---- readstate-owned private state --------------------------------------------
//
// The readstate slice does not yet export a ProjectPublication entry; the
// projections below are read-only re-projections of the agreed 0011 tables
// (user_channel_read_states / user_channel_mute_states /
// user_channel_display_prefs) mirroring the wire semantics of the readstate
// store's own GET projections. The integration report records the requested
// readstate API; when it lands, these read sites collapse into it.

// readStatePayload is the original normalized read-state DTO.
type readStatePayload struct {
	ServerID         string `json:"serverId"`
	ScopeID          string `json:"scopeId"`
	MaxReadSeq       int64  `json:"maxReadSeq"`
	ReadStateVersion int64  `json:"readStateVersion"`
}

// readStateBulkPayload is the bulk variant: one event, all scopes.
type readStateBulkPayload struct {
	ServerID string             `json:"serverId"`
	Scopes   []readStatePayload `json:"scopes"`
}

func (p *m4Publisher) publishReadState(ctx context.Context, ref realtime.Publication) error {
	if ref.SubjectUserID == "" {
		p.completed.Add(1)
		return nil
	}
	serial0 := p.serial()
	var state *readStatePayload
	err := db.WithReadSnapshot(ctx, p.db, func(ex db.Executor) error {
		if allowed, err := p.privateScopeAllowedTx(ctx, ex, ref, ref.ObjectID); err != nil || !allowed {
			return err
		}
		var maxRead, version int64
		err := ex.QueryRowContext(ctx, `SELECT last_read_seq, read_state_version
			FROM user_channel_read_states
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			ref.WorkspaceID, ref.SubjectUserID, ref.ObjectID).Scan(&maxRead, &version)
		if errors.Is(err, sql.ErrNoRows) {
			return nil // state gone: complete without a delivery
		}
		if err != nil {
			return err
		}
		state = &readStatePayload{ServerID: ref.WorkspaceID, ScopeID: ref.ObjectID, MaxReadSeq: maxRead, ReadStateVersion: version}
		return nil
	})
	if err != nil {
		return err
	}
	if p.serial() != serial0 {
		p.stale.Add(1)
		return errAudienceStale{}
	}
	if state == nil {
		p.completed.Add(1)
		return nil
	}
	if err := p.deliverSetContext(ctx, serial0, map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, core.EventReadState, state); err != nil {
		return err
	}
	p.published.Add(1)
	return nil
}

func (p *m4Publisher) publishReadStateBulk(ctx context.Context, ref realtime.Publication) error {
	if ref.SubjectUserID == "" {
		p.completed.Add(1)
		return nil
	}
	serial0 := p.serial()
	scopes := []readStatePayload{}
	err := db.WithReadSnapshot(ctx, p.db, func(ex db.Executor) error {
		rows, err := ex.QueryContext(ctx, `SELECT channel_id, last_read_seq, read_state_version
			FROM user_channel_read_states
			WHERE workspace_id = ? AND user_id = ?
			ORDER BY channel_id`, ref.WorkspaceID, ref.SubjectUserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var scope readStatePayload
			if err := rows.Scan(&scope.ScopeID, &scope.MaxReadSeq, &scope.ReadStateVersion); err != nil {
				return err
			}
			scope.ServerID = ref.WorkspaceID
			scopes = append(scopes, scope)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		if err := rows.Close(); err != nil {
			return err
		}
		visible := scopes[:0]
		for _, scope := range scopes {
			allowed, err := p.privateScopeAllowedTx(ctx, ex, ref, scope.ScopeID)
			if err != nil {
				return err
			}
			if allowed {
				visible = append(visible, scope)
			}
		}
		scopes = visible
		return nil
	})
	if err != nil {
		return err
	}
	if p.serial() != serial0 {
		p.stale.Add(1)
		return errAudienceStale{}
	}
	if len(scopes) == 0 {
		p.completed.Add(1)
		return nil
	}
	if err := p.deliverSetContext(ctx, serial0, map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, core.EventReadStateBulk,
		readStateBulkPayload{ServerID: ref.WorkspaceID, Scopes: scopes}); err != nil {
		return err
	}
	p.published.Add(1)
	return nil
}

func (p *m4Publisher) publishUnreadSummary(ctx context.Context, ref realtime.Publication) error {
	if ref.SubjectUserID == "" {
		p.completed.Add(1)
		return nil
	}
	if err := p.deliverSetContext(ctx, p.serial(), map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, core.EventUnreadSummary,
		unreadSummaryPayload{ServerID: ref.WorkspaceID}); err != nil {
		return err
	}
	p.published.Add(1)
	return nil
}

// notificationPrefsPayload is the frozen prefs envelope (never flattened).
type notificationPrefsPayload struct {
	ServerID string `json:"serverId"`
	ScopeID  string `json:"scopeId"`
	Prefs    struct {
		ActivityMuted bool   `json:"activityMuted"`
		MuteFromSeq   *int64 `json:"muteFromSeq"`
	} `json:"prefs"`
	PrefsVersion int64 `json:"prefsVersion"`
}

func (p *m4Publisher) publishNotificationPrefs(ctx context.Context, ref realtime.Publication) error {
	if ref.SubjectUserID == "" {
		p.completed.Add(1)
		return nil
	}
	serial0 := p.serial()
	var payload *notificationPrefsPayload
	err := db.WithReadSnapshot(ctx, p.db, func(ex db.Executor) error {
		if allowed, err := p.privateScopeAllowedTx(ctx, ex, ref, ref.ObjectID); err != nil || !allowed {
			return err
		}
		var muted int64
		var boundary sql.NullInt64
		var version int64
		err := ex.QueryRowContext(ctx, `SELECT activity_muted, mute_from_seq, prefs_version
			FROM user_channel_mute_states
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			ref.WorkspaceID, ref.SubjectUserID, ref.ObjectID).Scan(&muted, &boundary, &version)
		out := &notificationPrefsPayload{ServerID: ref.WorkspaceID, ScopeID: ref.ObjectID}
		if errors.Is(err, sql.ErrNoRows) {
			// No stored row: the effective state is the honest default —
			// announcement channels carry the legacy default mute.
			var systemKind sql.NullString
			kindErr := ex.QueryRowContext(ctx, `SELECT system_kind FROM channels
				WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
				ref.ObjectID, ref.WorkspaceID).Scan(&systemKind)
			if kindErr != nil && !errors.Is(kindErr, sql.ErrNoRows) {
				return kindErr
			}
			if systemKind.Valid && systemKind.String == "announcement" {
				out.Prefs.ActivityMuted = true
				zero := int64(0)
				out.Prefs.MuteFromSeq = &zero
			}
			payload = out
			return nil
		}
		if err != nil {
			return err
		}
		out.PrefsVersion = version
		if muted == 1 && boundary.Valid {
			out.Prefs.ActivityMuted = true
			v := boundary.Int64
			out.Prefs.MuteFromSeq = &v
		}
		payload = out
		return nil
	})
	if err != nil {
		return err
	}
	if p.serial() != serial0 {
		p.stale.Add(1)
		return errAudienceStale{}
	}
	if payload == nil {
		p.completed.Add(1)
		return nil
	}
	if err := p.deliverSetContext(ctx, serial0, map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, core.EventNotifPrefs, payload); err != nil {
		return err
	}
	p.published.Add(1)
	return nil
}

// displayPrefsPayload keeps the display-prefs version domain separate from
// the mute domain, exactly like the wire contract.
type displayPrefsPayload struct {
	ServerID string `json:"serverId"`
	ScopeID  string `json:"scopeId"`
	Prefs    struct {
		CollapseLongMessages bool `json:"collapseLongMessages"`
	} `json:"prefs"`
	PrefsVersion int64 `json:"prefsVersion"`
}

func (p *m4Publisher) publishDisplayPrefs(ctx context.Context, ref realtime.Publication) error {
	if ref.SubjectUserID == "" {
		p.completed.Add(1)
		return nil
	}
	serial0 := p.serial()
	payload := &displayPrefsPayload{ServerID: ref.WorkspaceID, ScopeID: ref.ObjectID}
	payload.Prefs.CollapseLongMessages = true // the honest default
	err := db.WithReadSnapshot(ctx, p.db, func(ex db.Executor) error {
		if allowed, err := p.privateScopeAllowedTx(ctx, ex, ref, ref.ObjectID); err != nil || !allowed {
			payload = nil
			return err
		}
		var collapse int64
		var version int64
		err := ex.QueryRowContext(ctx, `SELECT collapse_long_messages, prefs_version
			FROM user_channel_display_prefs
			WHERE workspace_id = ? AND user_id = ? AND channel_id = ?`,
			ref.WorkspaceID, ref.SubjectUserID, ref.ObjectID).Scan(&collapse, &version)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		payload.Prefs.CollapseLongMessages = collapse == 1
		payload.PrefsVersion = version
		return nil
	})
	if err != nil {
		return err
	}
	if p.serial() != serial0 {
		p.stale.Add(1)
		return errAudienceStale{}
	}
	if payload == nil {
		p.completed.Add(1)
		return nil
	}
	if err := p.deliverSetContext(ctx, serial0, map[string]struct{}{ref.SubjectUserID: {}}, ref.WorkspaceID, core.EventDisplayPrefs, payload); err != nil {
		return err
	}
	p.published.Add(1)
	return nil
}
