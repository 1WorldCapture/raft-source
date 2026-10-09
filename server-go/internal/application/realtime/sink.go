package realtime

import "context"

// Semantic event vocabulary shared with the socket transport. These strings
// are the durable publication event_type vocabulary AND the socket event
// names; transport/socketio/bridge maps them onto the gateway's constants
// (a bridge test pins the equality so the two lists cannot drift).
const (
	EventMessageNew      = "message:new"
	EventMessageUpdated  = "message:updated"
	EventDMNew           = "dm:new"
	EventThreadUpdated   = "thread:updated"
	EventThreadFollowers = "thread:followers-updated"
	EventUnreadSummary   = "unread_summary:changed"
	EventReactionViewer  = "reaction_viewer:updated"
	EventChannelUpdated  = "channel:updated"
	EventChannelMembers  = "channel:members-updated"
	EventReadState       = "read_state:updated"
	EventReadStateBulk   = "read_state:updated_bulk"
	EventNotifPrefs      = "notification_prefs:updated"
	EventDisplayPrefs    = "message_display_prefs:updated"
)

// Notification is one verified semantic notification handed to the
// transport sink: the event kind, the typed application payload, the
// workspace, the authorized recipient users, the optional subscription
// interest (semantic channel ids) and the authority serial the facts were
// bound to. Receiver-private payloads carry exactly one user.
type Notification struct {
	WorkspaceID string
	Event       string
	Users       map[string]struct{}
	// ChannelIDs narrows delivery to sockets interested in these channels
	// (thread rooms); nil delivers to every admitted socket of the users.
	ChannelIDs []string
	Serial     uint64
	Payload    any
}

// NotificationSink is the transport port: it validates the notification
// under the real gateway's admission guard (connection identity, workspace,
// subscription interest and the bound authority serial) and performs one
// bounded, non-blocking enqueue. An error means the durable intent must be
// retried; success means processed for THIS transport (never a browser or
// Agent receipt claim). Implementations must not split validation and
// enqueue into two racing steps.
type NotificationSink interface {
	Notify(ctx context.Context, n Notification) error
}

// SerialSource samples the committed authority watermark. It is memory-only
// and safe to call inside an admission predicate.
type SerialSource func() uint64
