// Channel route registration. Parent calls RegisterChannelRoutes from
// legacyweb.New; this file does not edit routes.go. Every pattern sits behind
// the verified-profile gate and RequireChannelServer. Unregistered methods on
// an implemented path answer JSON 405 after those gates (same policy as the
// workspace method fallbacks). Deferred M4/M5 and joint surfaces answer 501
// feature_not_implemented and never a fake success.
//
// Subtree routing is one method-free /api/channels/{rest...} dispatcher.
// Go's ServeMux panics when a method-specific wildcard is incomparable with
// a method-free literal (GET /{id} vs /dm) or when two wildcards sit in
// different positions (saved/{messageId} vs {id}/archive). The dispatcher
// keeps literal deferred paths ahead of {id} actions.
package legacyweb

import (
	"net/http"
	"strings"
)

// RegisterChannelRoutes mounts the M3A channel surface on mux.
func RegisterChannelRoutes(mux *http.ServeMux, handlers *ChannelHandlers, gate *AuthGate) {
	chain := func(next http.HandlerFunc) http.Handler {
		return gate.RequireVerifiedProfileComplete(handlers.RequireChannelServer(next))
	}
	reject := func(methods ...string) http.HandlerFunc {
		allow := strings.Join(methods, ", ")
		return func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Allow", allow)
			writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		}
	}

	// Collection. The {$} twin accepts the trailing-slash form without
	// becoming a subtree that would swallow /api/channels/{id}.
	mux.Handle("GET /api/channels", chain(handlers.List))
	mux.Handle("POST /api/channels", chain(handlers.Create))
	mux.Handle("/api/channels", chain(reject(http.MethodGet, http.MethodPost)))
	mux.Handle("GET /api/channels/{$}", chain(handlers.List))
	mux.Handle("POST /api/channels/{$}", chain(handlers.Create))
	mux.Handle("/api/channels/{$}", chain(reject(http.MethodGet, http.MethodPost)))

	mux.Handle("/api/channels/{rest...}", chain(handlers.dispatch))
}

func (h *ChannelHandlers) dispatch(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(r.PathValue("rest"), "/")
	for _, part := range parts {
		if part == "" {
			writeError(w, http.StatusNotFound, "Not found")
			return
		}
	}
	if len(parts) >= 3 && parts[0] == "system" && parts[1] == "all" && (parts[2] == "hide" || parts[2] == "restore") && len(parts) == 3 {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		if parts[2] == "hide" {
			h.HideAll(w, r)
			return
		}
		h.RestoreAll(w, r)
		return
	}
	if deferredChannelPath(parts) {
		writeErrorCode(w, http.StatusNotImplemented, "feature_not_implemented",
			"This channel capability is not implemented in this phase")
		return
	}
	h.dispatchChannel(w, r, parts)
}

// deferredChannelPath reports the M4/M5 and joint surfaces that share the
// /api/channels prefix with a real channel id. Starred families (activity,
// inbox, threads, saved, joint-invites) match the whole prefix.
func deferredChannelPath(parts []string) bool {
	switch parts[0] {
	case "dm", "unread", "activity", "inbox", "threads", "saved", "joint-invites":
		return true
	default:
		return false
	}
}

func (h *ChannelHandlers) dispatchChannel(w http.ResponseWriter, r *http.Request, parts []string) {
	r.SetPathValue("id", parts[0])
	switch len(parts) {
	case 1:
		switch r.Method {
		case http.MethodGet:
			h.Get(w, r)
		case http.MethodPatch:
			h.Update(w, r)
		case http.MethodDelete:
			h.Delete(w, r)
		default:
			methodNotAllowed(w, http.MethodGet, http.MethodPatch, http.MethodDelete)
		}
	case 2:
		switch parts[1] {
		case "archive":
			if r.Method == http.MethodPost {
				h.Archive(w, r)
				return
			}
			methodNotAllowed(w, http.MethodPost)
		case "unarchive":
			if r.Method == http.MethodPost {
				h.Unarchive(w, r)
				return
			}
			methodNotAllowed(w, http.MethodPost)
		case "join":
			if r.Method == http.MethodPost {
				h.Join(w, r)
				return
			}
			methodNotAllowed(w, http.MethodPost)
		case "leave":
			if r.Method == http.MethodPost {
				h.Leave(w, r)
				return
			}
			methodNotAllowed(w, http.MethodPost)
		case "members":
			switch r.Method {
			case http.MethodGet:
				h.Members(w, r)
			case http.MethodPost:
				h.AddMember(w, r)
			default:
				methodNotAllowed(w, http.MethodGet, http.MethodPost)
			}
		case "agents":
			if r.Method == http.MethodGet {
				h.ListAgents(w, r)
				return
			}
			methodNotAllowed(w, http.MethodGet)
		case "read", "read-all", "unread", "notification-settings", "message-display-settings",
			"files", "convert-to-joint", "joint-invites", "disconnect", "stop-all-agents",
			"resume-all-agents", "threads":
			writeDeferred(w)
		default:
			writeError(w, http.StatusNotFound, "Not found")
		}
	case 3:
		switch {
		case parts[1] == "members" && parts[2] == "batch":
			if r.Method == http.MethodPost {
				h.AddMembersBatch(w, r)
				return
			}
			methodNotAllowed(w, http.MethodPost)
		case parts[1] == "joint-invite" && parts[2] == "resend":
			writeDeferred(w)
		case parts[1] == "threads":
			writeDeferred(w)
		default:
			writeError(w, http.StatusNotFound, "Not found")
		}
	case 4:
		if parts[1] == "members" && (parts[2] == "agent" || parts[2] == "user") {
			r.SetPathValue("memberId", parts[3])
			if r.Method != http.MethodDelete {
				methodNotAllowed(w, http.MethodDelete)
				return
			}
			if parts[2] == "agent" {
				h.RemoveAgent(w, r)
				return
			}
			h.RemoveHuman(w, r)
			return
		}
		writeError(w, http.StatusNotFound, "Not found")
	case 5:
		if parts[1] == "members" && parts[4] == "role" {
			r.SetPathValue("targetType", parts[2])
			r.SetPathValue("memberId", parts[3])
			if r.Method == http.MethodPatch {
				h.ChangeMemberRole(w, r)
				return
			}
			methodNotAllowed(w, http.MethodPatch)
			return
		}
		writeError(w, http.StatusNotFound, "Not found")
	default:
		writeError(w, http.StatusNotFound, "Not found")
	}
}

func methodNotAllowed(w http.ResponseWriter, methods ...string) {
	w.Header().Set("Allow", strings.Join(methods, ", "))
	writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
}

func writeDeferred(w http.ResponseWriter) {
	writeErrorCode(w, http.StatusNotImplemented, "feature_not_implemented",
		"This channel capability is not implemented in this phase")
}
