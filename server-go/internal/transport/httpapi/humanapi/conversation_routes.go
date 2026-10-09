// Route registration for the M4 P4 conversation surface. The parent calls
// RegisterM4ConversationRoutes from the app assembly; this file does not edit
// routes.go or the existing ChannelHandlers dispatcher. Every pattern sits
// behind the verified-profile gate plus RequireChannelServer. Exact literals
// (dm, threads/followed, …) and longer {id}/threads patterns outrank the
// shared /api/channels/{rest...} dispatcher, so unregistered methods on these
// paths answer an explicit 405 here instead of falling into the deferred 501.
package humanapi

import (
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"strings"

	"raft.local/server-go/internal/channel"
)

// RegisterM4ConversationRoutes mounts the human DM + thread surface on mux.
func RegisterConversationRoutes(mux *http.ServeMux, h *ConversationHandlers, gate *authn.AuthGate) {
	chain := func(next http.HandlerFunc) http.Handler {
		return gate.RequireVerifiedProfileComplete(RequireChannelServer(h.Workspaces, next))
	}
	reject := func(methods ...string) http.HandlerFunc {
		allow := strings.Join(methods, ", ")
		return func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Allow", allow)
			httpx.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
		}
	}

	// DM collection.
	mux.Handle("GET /api/channels/dm", chain(h.ListDMs))
	mux.Handle("POST /api/channels/dm", chain(h.CreateDM))
	mux.Handle("/api/channels/dm", chain(reject(http.MethodGet, http.MethodPost)))

	// Thread interest (literal paths win over /api/channels/{id}/…).
	mux.Handle("GET /api/channels/threads/followed", chain(h.FollowedThreads))
	mux.Handle("/api/channels/threads/followed", chain(reject(http.MethodGet)))
	mux.Handle("POST /api/channels/threads/follow", chain(h.FollowThread))
	mux.Handle("/api/channels/threads/follow", chain(reject(http.MethodPost)))
	mux.Handle("POST /api/channels/threads/unfollow", chain(h.UnfollowThread))
	mux.Handle("/api/channels/threads/unfollow", chain(reject(http.MethodPost)))

	// Per-channel threads.
	mux.Handle("POST /api/channels/{id}/threads", chain(h.CreateThread))
	mux.Handle("GET /api/channels/{id}/threads", chain(h.ThreadSummaries))
	mux.Handle("/api/channels/{id}/threads", chain(reject(http.MethodGet, http.MethodPost)))
	mux.Handle("GET /api/channels/{id}/threads/{messageId}", chain(h.ThreadInfo))
	mux.Handle("/api/channels/{id}/threads/{messageId}", chain(reject(http.MethodGet)))

	// The announcement no-threads refusal is domain-level; keep the constant
	// referenced so transport and domain cannot drift apart silently.
	_ = channel.AnnouncementNoThreadsCode
}
