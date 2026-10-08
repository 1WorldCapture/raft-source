package core

import "time"

// Wire constants. Every value that has an original counterpart reproduces
// the TypeScript server exactly (packages/server/src/socket/index.ts); the
// source is noted per constant. Bounds without an original counterpart are
// the phase-4 design's first-load test values (docs/phase-4-messaging.md
// §7.2) and are NOT verified capacity numbers.

// Server-to-client and client-to-server event names. The web client consumes
// only the FIRST payload argument of each event (socketBridge.ts:139-142),
// so every server emit carries exactly one payload value.
const (
	EventRoomsJoined     = "rooms:joined"
	EventMessageNew      = "message:new"
	EventMessageUpdated  = "message:updated"
	EventSyncResume      = "sync:resume"
	EventSyncResumeResp  = "sync:resume:response"
	EventHeartbeat       = "heartbeat"
	EventJoinChannel     = "join:channel"
	EventLeaveChannel    = "leave:channel"
	EventDMNew           = "dm:new"
	EventThreadUpdated   = "thread:updated"
	EventChannelUpdated  = "channel:updated"
	EventChannelMembers  = "channel:members-updated"
	EventReadState       = "read_state:updated"
	EventReadStateBulk   = "read_state:updated_bulk"
	EventUnreadSummary   = "unread_summary:changed"
	EventNotifPrefs      = "notification_prefs:updated"
	EventDisplayPrefs    = "message_display_prefs:updated"
	EventThreadFollowers = "thread:followers-updated"
	EventReactionViewer  = "reaction_viewer:updated"
)

// Handshake rejection reasons. These exact strings surface as the original
// client's connect_error message (socket.io@4.8.3 delivers the middleware
// Error message verbatim) and the web client matches keywords on them to
// decide between a token refresh and giving up (api/socket.ts,
// utils/socketSessionPolicy.ts). Do not reword.
const (
	// ReasonAuthenticationRequired covers malformed auth objects: not an
	// object, missing/blank token, invalid serverId shape, invalid
	// clientKind (TS parseSocketHandshakeAuth failures).
	ReasonAuthenticationRequired = "Authentication required"
	// ReasonInvalidTokenType is returned by the injected authenticator when
	// the token signature decodes but is not an access token.
	ReasonInvalidTokenType = "Invalid token type"
	// ReasonInvalidOrExpiredToken covers failed signature, unknown session,
	// revoked or expired sessions.
	ReasonInvalidOrExpiredToken = "Invalid or expired token"
	// ReasonNotAMember covers a well-formed serverId the authenticated user
	// has no membership for.
	ReasonNotAMember = "Not a member of this server"
	// ReasonAuthChanged rejects connections whose authorization was revoked
	// while their handshake was still pending.
	ReasonAuthChanged = "Authentication changed; reconnect required"
)

// Protocol bounds reproducing the original server.
const (
	// HeartbeatInterval is the original 15s application heartbeat cadence
	// (TS HEARTBEAT_INTERVAL_MS). It is NOT the Engine.IO ping/pong, and it
	// is not a message acknowledgement.
	HeartbeatInterval = 15 * time.Second
	// ResumePageLimit is the original sync:resume page size (TS RESUME_LIMIT).
	ResumePageLimit = 500
	// MaxSafeInteger is the largest exact JavaScript number; every seq the
	// original client can represent is bounded by it (phase-4 design §4.2).
	MaxSafeInteger = int64(1)<<53 - 1
)

// First-load bound defaults (phase-4-messaging.md §7.2). These are initial
// test values to be load-tested, not verified capacity.
const (
	// DefaultMaxEventBytes bounds one inbound event's JSON encoding.
	DefaultMaxEventBytes = 64 * 1024
	// DefaultMaxQueueMessages bounds pending outbound envelopes per
	// connection.
	DefaultMaxQueueMessages = 256
	// DefaultMaxQueueBytes bounds pending outbound bytes per connection.
	DefaultMaxQueueBytes = 1 << 20
	// DefaultMaxConnsPerUser bounds concurrent connections per user across
	// all workspaces.
	DefaultMaxConnsPerUser = 64
	// DefaultEventRatePerSecond and DefaultEventBurst bound inbound events.
	DefaultEventRatePerSecond = 50
	DefaultEventBurst         = 100
)

// ClientKind values the original server accepts (platformScope.ts
// SOCKET_CLIENT_KINDS); an absent clientKind defaults to "web".
const (
	ClientKindWeb    = "web"
	ClientKindMobile = "mobile"
	ClientKindDesk   = "desktop"
	ClientKindCLI    = "cli"
)

// ParseClientKind mirrors parseSocketClientKind: undefined/null -> "web",
// known string -> itself, anything else -> not ok.
func ParseClientKind(v any) (string, bool) {
	switch t := v.(type) {
	case nil:
		return ClientKindWeb, true
	case string:
		switch t {
		case ClientKindWeb, ClientKindMobile, ClientKindDesk, ClientKindCLI:
			return t, true
		}
		return "", false
	default:
		return "", false
	}
}

// Room name builders. Identical strings to platformScope.ts; rooms are the
// adapter's internal delivery index, not an authorization fact.
func UserRoom(userID string) string { return "user:" + userID }

// UserClientKindRoom targets one user's sockets of one platform kind.
func UserClientKindRoom(userID, clientKind string) string {
	return "user:" + userID + ":clientKind:" + clientKind
}

// ServerRoom is the workspace-wide room.
func ServerRoom(workspaceID string) string { return "server:" + workspaceID }

// UserServerRoom is the INTERSECTION room: exactly the sockets of one user
// attached to one workspace. Socket.IO in(a).in(b) semantics are a union,
// so private events (read state, prefs, reaction viewer) must target this
// room rather than user+server separately (platformScope.ts comment).
func UserServerRoom(userID, workspaceID string) string {
	return "user:" + userID + ":server:" + workspaceID
}

// ChannelRoom is the per-conversation subscription room.
func ChannelRoom(channelID string) string { return "channel:" + channelID }
