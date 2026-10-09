package bridge

import (
	"context"

	apprealtime "raft.local/server-go/internal/application/realtime"
	"raft.local/server-go/internal/transport/presenter"
	"raft.local/server-go/internal/transport/socketio"
	"raft.local/server-go/internal/transport/socketio/core"
)

// coreEvent maps the semantic event vocabulary onto the gateway's event
// names. The equality is pinned by a bridge test so the two vocabularies
// cannot drift.
func coreEvent(event string) string {
	switch event {
	case apprealtime.EventMessageNew:
		return core.EventMessageNew
	case apprealtime.EventMessageUpdated:
		return core.EventMessageUpdated
	case apprealtime.EventDMNew:
		return core.EventDMNew
	case apprealtime.EventThreadUpdated:
		return core.EventThreadUpdated
	case apprealtime.EventThreadFollowers:
		return core.EventThreadFollowers
	case apprealtime.EventUnreadSummary:
		return core.EventUnreadSummary
	case apprealtime.EventReactionViewer:
		return core.EventReactionViewer
	case apprealtime.EventChannelUpdated:
		return core.EventChannelUpdated
	case apprealtime.EventChannelMembers:
		return core.EventChannelMembers
	case apprealtime.EventReadState:
		return core.EventReadState
	case apprealtime.EventReadStateBulk:
		return core.EventReadStateBulk
	case apprealtime.EventNotifPrefs:
		return core.EventNotifPrefs
	case apprealtime.EventDisplayPrefs:
		return core.EventDisplayPrefs
	default:
		return event
	}
}

// Sink implements application/realtime.NotificationSink over the gateway:
// the notification is admitted under the gateway's own admission guard,
// which re-checks the workspace binding, the authorized user set, the
// subscription interest and the bound authority serial, then performs one
// bounded non-blocking enqueue per connection.
type Sink struct {
	gateway *socketio.Gateway
	serial  apprealtime.SerialSource
}

// NewSink builds the gateway-backed notification sink.
func NewSink(gateway *socketio.Gateway, serial apprealtime.SerialSource) *Sink {
	return &Sink{gateway: gateway, serial: serial}
}

// Notify validates and enqueues one semantic notification. Serial changes,
// guard acquisition failures and cancellation propagate as errors so the
// durable intent stays retryable.
func (s *Sink) Notify(ctx context.Context, n apprealtime.Notification) error {
	var rooms []string
	for _, id := range n.ChannelIDs {
		rooms = append(rooms, core.ChannelRoom(id))
	}
	wire := presenter.RealtimePayload(n.Event, n.Payload)
	return s.gateway.PublishFilteredContext(ctx, rooms, coreEvent(n.Event), wire, func(id core.Identity) bool {
		if id.WorkspaceID != n.WorkspaceID {
			return false
		}
		if _, ok := n.Users[id.UserID]; !ok {
			return false
		}
		return s.serial() == n.Serial
	})
}
