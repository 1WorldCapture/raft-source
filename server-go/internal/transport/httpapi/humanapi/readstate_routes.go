// Readstate route registration. The parent calls RegisterReadstateRoutes from
// the httpapi router assembly; this file never edits the router.
//
// Routing notes (frozen by the coordination docs):
//   - Literal patterns like GET /api/channels/activity/snapshot win over the
//     channel dispatcher's method-free /api/channels/{rest...} subtree, so
//     these registrations take effect without touching that dispatcher.
//   - The no-ID literal routes (activity/inbox/threads families, /api/servers/
//     unread-summary, /api/read-mutations) are registered explicitly so they
//     can never be captured by dynamic {id} routing.
//   - /api/channels/{id}/read|read-all|unread and the two prefs pairs extend
//     the channel subtree; today the dispatcher answers them with 501 — once
//     the parent registers this file's patterns, the more specific
//     method-specific literals take precedence.
//   - The read-mutation sequencer domain stays honestly closed: authorized
//     callers get 501 feature_not_implemented, never a fake success.
package humanapi

import "net/http"

// RegisterReadstateRoutes mounts the M4 P5 readstate/Activity surface on mux.
import "raft.local/server-go/internal/transport/httpapi/authn"

func RegisterReadstateRoutes(mux *http.ServeMux, handlers *ReadstateHandlers, gate *authn.AuthGate) {
	scoped := func(next http.HandlerFunc) http.Handler {
		return gate.RequireVerifiedProfileComplete(handlers.RequireServerScope(next))
	}
	userScoped := func(next http.HandlerFunc) http.Handler {
		return gate.RequireVerifiedProfileComplete(next)
	}

	// Activity sync reads.
	mux.Handle("GET /api/channels/activity/snapshot", scoped(handlers.ActivitySnapshot))
	mux.Handle("GET /api/channels/activity/difference", scoped(handlers.ActivityDifference))

	// Unified Inbox and its histories.
	mux.Handle("GET /api/channels/inbox", scoped(handlers.Inbox))
	mux.Handle("GET /api/channels/inbox/done", scoped(handlers.InboxDone))
	mux.Handle("GET /api/channels/inbox/unfollowed", scoped(handlers.InboxUnfollowed))
	mux.Handle("POST /api/channels/inbox/done", scoped(handlers.InboxDonePost))
	mux.Handle("POST /api/channels/inbox/undone", scoped(handlers.InboxUndone))
	mux.Handle("POST /api/channels/inbox/read-all", scoped(handlers.InboxReadAll))

	// Thread Done/undone (follow/unfollow/threads-followed are the channel
	// worker's surface; those registrations live in their own file).
	mux.Handle("POST /api/channels/threads/done", scoped(handlers.ThreadDone))
	mux.Handle("POST /api/channels/threads/undone", scoped(handlers.ThreadUndone))

	// Per-channel read state.
	mux.Handle("POST /api/channels/{id}/read", scoped(handlers.ChannelRead))
	mux.Handle("POST /api/channels/{id}/read-all", scoped(handlers.ChannelReadAll))
	mux.Handle("POST /api/channels/{id}/unread", scoped(handlers.ChannelUnread))
	mux.Handle("GET /api/channels/unread", scoped(handlers.ChannelsUnread))

	// Preferences (two independent version domains).
	mux.Handle("GET /api/channels/{id}/notification-settings", scoped(handlers.NotificationSettings))
	mux.Handle("PATCH /api/channels/{id}/notification-settings", scoped(handlers.SetNotificationSettings))
	mux.Handle("GET /api/channels/{id}/message-display-settings", scoped(handlers.DisplaySettings))
	mux.Handle("PATCH /api/channels/{id}/message-display-settings", scoped(handlers.SetDisplaySettings))

	// Account-level unread summary (user-scoped literal route).
	mux.Handle("GET /api/servers/unread-summary", userScoped(handlers.ServersUnreadSummary))

	// The cross-system read-mutation sequencer stays closed this phase.
	mux.Handle("POST /api/read-mutations", scoped(ReadMutationsNotOpen))
	mux.Handle("GET /api/read-mutations/frontier", scoped(ReadMutationsNotOpen))
}
