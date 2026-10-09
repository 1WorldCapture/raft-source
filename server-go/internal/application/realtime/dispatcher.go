package realtime

// The durable publication dispatcher: it turns publication.Publication
// references into verified semantic notifications. Every intent is
// reprojected from CURRENT facts, its authorized audience is resolved from
// CURRENT policy, and both are BOUND to the authority serial observed before
// the reads; the binding is re-checked by the sink inside the final guarded
// admission, so a permission change that commits between projection and
// admission stops every further stale send (partial sends before the
// mismatch are allowed; clients dedupe stable ids). No database work and no
// network write ever happens under the admission fence or inside a database
// transaction here.

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"sync/atomic"

	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/publication"
)

// unknownParkAttempts is the retry budget for a publication whose
// object/event pair has no projector in this binary. Retrying a permanently
// unprojectable type can never succeed and each row would otherwise occupy
// the bounded backlog forever (MaxPending blocks NEW intents), so after this
// many attempts the row is parked (marked processed) with a loud error log
// and a dedicated counter — an explicit, visible decision, never a silent
// drop, and never applied to transient failures.
// UnknownParkAttempts is the unprojectable-intent retry budget (tests size
// their fixtures against it).
const UnknownParkAttempts = 8

// ErrUnknownPublication reports a publication the composition cannot project.
type ErrUnknownPublication struct {
	objectType, eventType string
}

func (e *ErrUnknownPublication) Error() string {
	return fmt.Sprintf("realtime: no projector for publication %s/%s", e.objectType, e.eventType)
}

// ErrAudienceStale reports that the authority serial moved between the
// audience/payload snapshot and the final admission. The intent is retained
// and reprojected; frames already admitted under the older snapshot stay
// (stable-id replay on the retry lets clients dedupe).
type ErrAudienceStale struct{}

func (ErrAudienceStale) Error() string {
	return "realtime: authority serial changed during publication projection"
}

// Dispatcher is the publication.Publisher callback wired into
// publication.Store.Start. Contract: nil means processed (published, parked,
// or the referenced fact is gone so there is nothing to deliver); an error
// means deferred — the durable intent is retried later.
type Dispatcher struct {
	db       *sql.DB
	gateway  NotificationSink
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

// NewDispatcher validates the required dependencies at construction time.
func NewDispatcher(handle *sql.DB, sink NotificationSink, messages *message.Store, channels *channel.Store, logger *slog.Logger) (*Dispatcher, error) {
	if handle == nil || sink == nil || messages == nil || channels == nil {
		return nil, fmt.Errorf("realtime: db, sink, messages and channels are required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Dispatcher{db: handle, gateway: sink, messages: messages, channels: channels, log: logger}, nil
}

// Stats is the observability snapshot for tests and the report.
type Stats struct {
	Published, Completed, Deferred, Unknown, Parked, Stale, SummaryInvalidations uint64
}

// Stats returns the observability snapshot.
func (d *Dispatcher) Stats() Stats {
	return Stats{
		Published: d.published.Load(), Completed: d.completed.Load(),
		Deferred: d.deferred.Load(), Unknown: d.unknown.Load(),
		Parked: d.parked.Load(), Stale: d.stale.Load(),
		SummaryInvalidations: d.summaryHit.Load(),
	}
}

// serial is the committed authority watermark: memory-only, safe inside the
// final guarded admission predicate.
func (d *Dispatcher) serial() uint64 { return db.AuthoritySerial(d.db) }

// Publish dispatches one durable publication intent. Every branch resolves
// its payload and audience BEFORE any sink call: the transport's guard wraps
// only the per-connection checks, the serial binding and the bounded
// enqueue.
func (d *Dispatcher) Publish(ctx context.Context, ref publication.Publication) error {
	err := d.Dispatch(ctx, ref)
	if err != nil {
		d.deferred.Add(1)
		return err
	}
	return nil
}

// Dispatch routes one publication reference to its projector. It is the
// internal step under Publish, exported for integration tests that drive a
// single intent deterministically.
func (d *Dispatcher) Dispatch(ctx context.Context, ref publication.Publication) error {
	switch {
	case ref.ObjectType == "message" && (ref.EventType == EventMessageNew || ref.EventType == EventMessageUpdated):
		return d.publishMessageFact(ctx, ref)
	case ref.ObjectType == "reaction_viewer" && ref.EventType == EventReactionViewer:
		return d.publishViewerSnapshot(ctx, ref)
	case ref.EventType == EventThreadUpdated && (ref.ObjectType == "thread" || ref.ObjectType == "channel"):
		// message worker: per-reply intent (object_type thread); channel
		// worker: durable thread appearance (object_type channel). Both
		// project through the message worker's thread projector.
		return d.publishThreadUpdated(ctx, ref)
	case ref.ObjectType == "channel" && ref.EventType == EventDMNew:
		return d.publishDMNew(ctx, ref)
	case ref.ObjectType == "channel" && ref.EventType == channel.PublicationEventChannelUpdated:
		// channel worker's durable channel-state intents (create, rename,
		// visibility/guest policy, archive, unarchive): references only,
		// committed on the same transaction as the fact.
		return d.publishChannelUpdated(ctx, ref)
	case ref.ObjectType == "channel" && ref.EventType == channel.PublicationEventMembersUpdated:
		// channel worker's durable roster intents; SubjectUserID references
		// the human whose membership was gained ("" otherwise).
		return d.publishMembersUpdated(ctx, ref)
	case ref.ObjectType == "thread_follow" && ref.EventType == EventThreadFollowers:
		return d.publishFollowersUpdated(ctx, ref)
	case ref.ObjectType == "read_state" && ref.EventType == EventReadState:
		return d.publishReadState(ctx, ref)
	case ref.ObjectType == "read_state_bulk" && ref.EventType == EventReadStateBulk:
		return d.publishReadStateBulk(ctx, ref)
	case ref.ObjectType == "unread_summary" && ref.EventType == EventUnreadSummary:
		return d.publishUnreadSummary(ctx, ref)
	case ref.ObjectType == "notification_prefs" && ref.EventType == EventNotifPrefs:
		return d.publishNotificationPrefs(ctx, ref)
	case ref.ObjectType == "message_display_prefs" && ref.EventType == EventDisplayPrefs:
		return d.publishDisplayPrefs(ctx, ref)
	default:
		return d.unprojectable(ref)
	}
}

// unprojectable handles permanently invalid references uniformly: both an
// unknown object/event pair and a known private event missing its owner use
// the same explicit retry/parking budget. Transient database, cancellation or
// authority errors never enter this path and always retain their intent.
func (d *Dispatcher) unprojectable(ref publication.Publication) error {
	d.unknown.Add(1)
	if ref.Attempts >= UnknownParkAttempts {
		d.parked.Add(1)
		d.log.Error("realtime: unprojectable publication PARKED after retry budget",
			"object_type", ref.ObjectType, "event_type", ref.EventType, "object_id", ref.ObjectID,
			"attempts", ref.Attempts)
		return nil
	}
	d.log.Error("realtime: unprojectable publication deferred",
		"object_type", ref.ObjectType, "event_type", ref.EventType, "object_id", ref.ObjectID)
	return &ErrUnknownPublication{objectType: ref.ObjectType, eventType: ref.EventType}
}

// Deliver sends one sealed payload to an audience's live set through the
// sink; the transport re-checks workspace binding, membership and the
// unchanged authority serial inside its admission guard. Exported for
// integration tests that exercise admission directly.
func (d *Dispatcher) Deliver(a conversationAudience, workspaceID, event string, payload any) error {
	return d.deliverContext(context.Background(), a, workspaceID, event, payload)
}

func (d *Dispatcher) deliverContext(ctx context.Context, a conversationAudience, workspaceID, event string, payload any) error {
	var rooms []string
	if a.PublicThread && (event == EventMessageNew || event == EventMessageUpdated) {
		// Public-thread content is base-readable, not automatically live-
		// subscribed on every workspace socket. Followers joined at the
		// barrier and explicit viewers receive it on their thread room.
		rooms = []string{a.ChannelID}
	}
	return d.deliverSetContext(ctx, a.Serial, a.Live, workspaceID, event, payload, rooms...)
}

// fanoutUnreadSummary delivers the unread summary invalidation to every
// counting audience member except the acting sender (a user's own message
// never counts as their unread). Admission failures remain retryable through
// the durable owner; clients deduplicate any already-admitted replay.
func (d *Dispatcher) fanoutUnreadSummary(ctx context.Context, a conversationAudience, workspaceID, senderID string) error {
	users := make(map[string]struct{}, len(a.Counting))
	for userID := range a.Counting {
		if userID != senderID {
			users[userID] = struct{}{}
		}
	}
	if len(users) == 0 {
		return nil
	}
	payload := UnreadSummaryEventPayload{ServerID: workspaceID}
	if err := d.deliverSetContext(ctx, a.Serial, users, workspaceID, EventUnreadSummary, payload); err != nil {
		return err
	}
	d.summaryHit.Add(1)
	return nil
}

// deliverSet delivers over an explicit user set with the serial binding
// checked by the transport inside its guarded admission.
func (d *Dispatcher) deliverSet(serial0 uint64, users map[string]struct{}, workspaceID, event string, payload any) {
	_ = d.deliverSetContext(context.Background(), serial0, users, workspaceID, event, payload)
}

// deliverSetContext propagates admission/cancellation failures to the
// durable outbox. The serial is re-checked INSIDE the transport admission
// for shared AND receiver-private projections; fresh sockets may not consume
// an old snapshot after reauthorization. A moved binding retains the intent
// for reprojection.
func (d *Dispatcher) deliverSetContext(ctx context.Context, serial0 uint64, users map[string]struct{}, workspaceID, event string, payload any, channelIDs ...string) error {
	err := d.gateway.Notify(ctx, Notification{
		WorkspaceID: workspaceID, Event: event, Users: users,
		ChannelIDs: channelIDs, Serial: serial0, Payload: payload,
	})
	if err != nil {
		return err
	}
	if d.serial() != serial0 {
		d.stale.Add(1)
		return ErrAudienceStale{}
	}
	return nil
}
