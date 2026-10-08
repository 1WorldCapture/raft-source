// Route registration for the M4 P2 message + reaction surface. The parent
// calls RegisterMessageRoutes from the app assembly (or from
// Deps.RegisterAdditional); this file does not edit routes.go or any existing
// dispatcher. Every pattern sits behind the verified-profile gate plus the
// channel RequireChannelServer chain (X-Server-Id + live membership).
//
// Subtree routing is one method-free /api/messages/{rest...} dispatcher for
// the same reason as the channel surface: Go's ServeMux cannot register
// {channelId} and {messageId} wildcards in different positions of sibling
// patterns. The dispatcher keeps literal paths (sync, channel, context, …)
// ahead of {messageId} actions and applies the shared write rate bucket to
// the mutation methods only.
package legacyweb

import (
	"net/http"
	"strings"
)

// RegisterMessageRoutes mounts the message surface on mux.
func RegisterMessageRoutes(mux *http.ServeMux, h *M4MessageHandlers, gate *AuthGate) {
	chain := func(next http.HandlerFunc) http.Handler {
		return gate.RequireVerifiedProfileComplete(h.Channels.RequireChannelServer(next))
	}
	write := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			h.limiter.wrap(userID(r), next)(w, r)
		}
	}
	// v1/v2 sends are exact literals (the no-slash form must not 307 into the
	// subtree); the rest routes through the dispatcher.
	mux.Handle("POST /api/v2/messages", chain(write(h.CreateMessageV2)))
	mux.Handle("/api/v2/messages", chain(methodFree(func(w http.ResponseWriter, _ *http.Request) {
		allow(w, http.MethodPost)
	})))
	mux.Handle("POST /api/messages", chain(write(h.CreateMessageV1)))
	mux.Handle("/api/messages", chain(methodFree(func(w http.ResponseWriter, _ *http.Request) {
		allow(w, http.MethodPost)
	})))
	mux.Handle("/api/messages/{rest...}", chain(h.dispatchMessage(write)))
}

func allow(w http.ResponseWriter, methods ...string) {
	w.Header().Set("Allow", strings.Join(methods, ", "))
	writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
}

func methodFree(fn http.HandlerFunc) http.HandlerFunc { return fn }

func notImplementedRoute(message string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeErrorCode(w, http.StatusNotImplemented, "feature_not_implemented", message)
	}
}

// dispatchMessage routes one /api/messages/{rest...} request. write wraps the
// mutation handlers with the shared rate bucket.
func (h *M4MessageHandlers) dispatchMessage(write func(http.HandlerFunc) http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rest := r.PathValue("rest")
		parts := []string{}
		if rest != "" {
			parts = strings.Split(rest, "/")
		}
		for _, part := range parts {
			if part == "" {
				writeError(w, http.StatusNotFound, "Not found")
				return
			}
		}
		switch {
		case len(parts) == 0:
			if r.Method == http.MethodPost {
				write(h.CreateMessageV1)(w, r)
				return
			}
			allow(w, http.MethodPost)
		case len(parts) == 1 && parts[0] == "sync":
			if r.Method == http.MethodGet {
				h.SyncMessages(w, r)
				return
			}
			allow(w, http.MethodGet)
		case len(parts) == 1 && parts[0] == "search":
			if r.Method == http.MethodGet {
				notImplementedRoute("Message search is not enabled in this server stage")(w, r)
				return
			}
			allow(w, http.MethodGet)
		case len(parts) == 1 && parts[0] == "forward":
			if r.Method == http.MethodPost {
				notImplementedRoute("Forwarding is not enabled in this server stage")(w, r)
				return
			}
			allow(w, http.MethodPost)
		case len(parts) == 2 && parts[0] == "mention-actions" && parts[1] == "execute":
			if r.Method == http.MethodPost {
				notImplementedRoute("Mention actions are not enabled in this server stage")(w, r)
				return
			}
			allow(w, http.MethodPost)
		case len(parts) == 2 && parts[0] == "channel":
			if r.Method == http.MethodGet {
				r.SetPathValue("channelId", parts[1])
				h.ChannelHistory(w, r)
				return
			}
			allow(w, http.MethodGet)
		case len(parts) == 2 && parts[0] == "context":
			if r.Method == http.MethodGet {
				r.SetPathValue("messageId", parts[1])
				h.MessageContext(w, r)
				return
			}
			allow(w, http.MethodGet)
		case len(parts) == 2 && isMessageAction(parts[0]) && parts[1] == "reactions":
			switch r.Method {
			case http.MethodPost:
				r.SetPathValue("messageId", parts[0])
				write(h.AddReaction)(w, r)
			case http.MethodDelete:
				r.SetPathValue("messageId", parts[0])
				write(h.RemoveReaction)(w, r)
			default:
				allow(w, http.MethodPost, http.MethodDelete)
			}
		case len(parts) == 3 && isMessageAction(parts[0]) && parts[1] == "reactions" && parts[2] == "actors":
			if r.Method == http.MethodGet {
				r.SetPathValue("messageId", parts[0])
				h.ReactionActors(w, r)
				return
			}
			allow(w, http.MethodGet)
		case len(parts) == 3 && isMessageAction(parts[0]) && parts[1] == "reactions" && parts[2] == "viewer":
			if r.Method == http.MethodGet {
				r.SetPathValue("messageId", parts[0])
				h.ReactionViewer(w, r)
				return
			}
			allow(w, http.MethodGet)
		default:
			// Unknown subroutes stay 404 — including message text
			// edit/delete and saved-message paths, which the original TS
			// router never registered: inventing a disabled surface for them
			// would imply a feature that does not exist on any backend.
			writeError(w, http.StatusNotFound, "Not found")
		}
	}
}

// isMessageAction reports whether the segment is shaped like a message id
// (message-scoped actions only; literal collection paths matched earlier).
func isMessageAction(segment string) bool {
	return isLegacyUUID(segment)
}
