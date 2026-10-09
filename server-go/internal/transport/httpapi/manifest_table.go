// The inventory is descriptive only. Routing and authorization never depend
// on this list. Real registrations and dispatchers remain the authority.
package httpapi

import "strings"

// routeManifestEntry distinguishes actual ServeMux mounts from logical
// dispatcher children. Allow is the exact fixed fallback header, or empty
// when this entry does not emit one (conditional headers are explained in
// Capability). An audit pattern is not a promise of an implemented capability.
type routeManifestEntry struct {
	Method     string
	Pattern    string
	Owner      string
	Identity   string
	Allow      string
	Gate       string
	Scope      string
	RateLimit  string
	Capability string
	Kind       string // mount or dispatch
}

// Manifest returns fresh audit metadata without I/O or route registration.
// Literal spec expansion only groups shared policy; it is not a new router.
func Manifest() []routeManifestEntry {
	var out []routeManifestEntry
	add := func(owner, identity, gate, scope, rate, capability, kind, allow string, specs ...string) {
		for _, spec := range specs {
			method, pattern, _ := strings.Cut(spec, " ")
			out = append(out, routeManifestEntry{
				Method: method, Pattern: pattern, Owner: owner, Identity: identity,
				Allow: allow, Gate: gate, Scope: scope, RateLimit: rate,
				Capability: capability, Kind: kind,
			})
		}
	}
	const rvp = "RequireVerifiedProfileComplete" // RequireVerified is exactly this alias.
	const server = "ServersHandlers.RequireServerScope; header must match URL workspace"
	const management = "RequireServerScope; DenyGuests before handler or 405"
	const channel = "RequireChannelServer"
	const accountRate = "shared account generalAuth per-IP; default 200/min"
	const admissionRate = "independent per-endpoint per-IP instance; default 200/min"
	const messageRate = "shared MessageHandlers per-user write bucket"
	const gatesFirst405 = "405 after original authentication/scope/guest checks"

	// Register/forgot outer limiters run BEFORE generalAuth. Login's account
	// limiter runs AFTER the same shared account-IP bucket.
	add("humanapi", "public", "none", "none", accountRate, "implemented", "mount", "",
		"GET /api/auth/providers", "POST /api/auth/refresh", "POST /api/auth/logout",
		"POST /api/auth/verify-email", "POST /api/auth/reset-password", "GET /api/auth/invite-info")
	add("humanapi", "public", "none", "none", "register-IP 20/hour -> "+accountRate, "implemented", "mount", "", "POST /api/auth/register")
	add("humanapi", "public", "none", "none", accountRate+" -> login-account 10/min (email)", "implemented", "mount", "", "POST /api/auth/login")
	add("humanapi", "public", "none", "none", "forgot-IP 5/hour -> "+accountRate, "implemented", "mount", "", "POST /api/auth/forgot-password")
	add("humanapi", "human", "Require", "user session", accountRate, "implemented", "mount", "",
		"POST /api/auth/resend-verification", "GET /api/auth/me", "PATCH /api/auth/me",
		"POST /api/auth/me/avatar", "POST /api/auth/me/complete-profile",
		"GET /api/auth/me/username-available", "POST /api/auth/me/timezone-observation")
	add("humanapi", "human", rvp, "invitation proof and authenticated user", accountRate, "implemented", "mount", "", "POST /api/auth/accept-invite")
	add("humanapi", "public", "none", "none", "none", "implemented public avatar", "mount", "",
		"GET /api/avatars/users/{file}", "GET /api/avatars/servers/{file}")

	// Workspace literals, aliases and gates-first method fallbacks.
	add("humanapi", "human", rvp, "user-scoped; no X-Server-Id", "none", "implemented", "mount", "",
		"GET /api/servers", "POST /api/servers", "GET /api/servers/{$}", "POST /api/servers/{$}",
		"GET /api/servers/order", "PATCH /api/servers/order", "GET /api/servers/unread-summary")
	add("humanapi", "human", rvp, server, "none", "implemented", "mount", "",
		"GET /api/servers/{id}", "PATCH /api/servers/{id}", "POST /api/servers/{id}/avatar",
		"GET /api/servers/{id}/members", "POST /api/servers/{id}/setup-transition",
		"POST /api/servers/{id}/setup-reset", "POST /api/servers/{id}/setup-handoff", "GET /api/servers/{id}/sidebar-order")
	add("humanapi", "human", rvp, management, "none", "implemented", "mount", "",
		"GET /api/servers/{id}/settings", "GET /api/servers/{id}/onboarding-settings", "PATCH /api/servers/{id}/onboarding-settings",
		"GET /api/servers/{id}/setup-projection", "GET /api/servers/{id}/machines",
		"GET /api/servers/{id}/join-links", "POST /api/servers/{id}/join-links", "DELETE /api/servers/{id}/join-links/{linkId}",
		"GET /api/servers/{id}/invites", "POST /api/servers/{id}/invites", "DELETE /api/servers/{id}/invites/{inviteId}")
	add("humanapi", "human", rvp, management, "none", "501 office overview; gates first", "mount", "", "GET /api/servers/{id}/agent-overview")
	add("humanapi", "human", rvp, "user-scoped", "none", gatesFirst405, "mount", "GET, POST", "* /api/servers", "* /api/servers/{$}")
	add("humanapi", "human", rvp, "RequireServerScope except literal order and unread-summary", "none",
		"405; order Allow=GET, PATCH; unread-summary Allow=GET; other ids Allow=GET, PATCH", "mount", "", "* /api/servers/{id}")
	for _, path := range []string{"avatar", "setup-transition", "setup-reset", "setup-handoff"} {
		add("humanapi", "human", rvp, server, "none", gatesFirst405, "mount", "POST", "* /api/servers/{id}/"+path)
	}
	for _, path := range []string{"members", "sidebar-order"} {
		add("humanapi", "human", rvp, server, "none", gatesFirst405, "mount", "GET", "* /api/servers/{id}/"+path)
	}
	// Preserve the inherited machines fallback Allow=GET even though a
	// separate, more-specific POST mount handles enrollment.
	for _, path := range []string{"settings", "setup-projection", "machines"} {
		add("humanapi", "human", rvp, management, "none", gatesFirst405, "mount", "GET", "* /api/servers/{id}/"+path)
	}
	add("humanapi", "human", rvp, management, "none", gatesFirst405, "mount", "GET, PATCH", "* /api/servers/{id}/onboarding-settings")
	add("humanapi", "human", rvp, management, "none", gatesFirst405, "mount", "GET, POST", "* /api/servers/{id}/join-links", "* /api/servers/{id}/invites")
	add("humanapi", "human", rvp, management, "none", gatesFirst405, "mount", "DELETE", "* /api/servers/{id}/join-links/{linkId}", "* /api/servers/{id}/invites/{inviteId}")
	for _, method := range []string{"POST", "PATCH", "DELETE", "PUT", "OPTIONS"} {
		add("humanapi", "human", rvp, "user-scoped", "none", gatesFirst405, "mount", "GET", method+" /api/servers/unread-summary")
	}
	add("humanapi", "human", rvp, "user-scoped", "none", "404 reserved community capability; gate first", "mount", "", "POST /api/servers/join-community")

	// ReadstateHandlers.RequireServerScope is NOT the similarly named
	// ServersHandlers method: here the URL id is a channel, not a workspace.
	const readstateScope = "ReadstateHandlers.RequireServerScope; X-Server-Id membership, no URL workspace match"
	add("humanapi", "human", rvp, readstateScope, "none", "implemented", "mount", "",
		"GET /api/channels/activity/snapshot", "GET /api/channels/activity/difference",
		"GET /api/channels/inbox", "GET /api/channels/inbox/done", "GET /api/channels/inbox/unfollowed",
		"POST /api/channels/inbox/done", "POST /api/channels/inbox/undone", "POST /api/channels/inbox/read-all",
		"POST /api/channels/threads/done", "POST /api/channels/threads/undone", "POST /api/channels/{id}/read",
		"POST /api/channels/{id}/read-all", "POST /api/channels/{id}/unread", "GET /api/channels/unread",
		"GET /api/channels/{id}/notification-settings", "PATCH /api/channels/{id}/notification-settings",
		"GET /api/channels/{id}/message-display-settings", "PATCH /api/channels/{id}/message-display-settings")
	add("humanapi", "human", rvp, readstateScope, "none", "501 read-mutations not open; gates first", "mount", "",
		"POST /api/read-mutations", "GET /api/read-mutations/frontier")

	// Real channel mounts, then explicitly distinguished dispatcher children.
	add("humanapi", "human", rvp, channel, "none", "implemented", "mount", "",
		"GET /api/channels", "POST /api/channels", "GET /api/channels/{$}", "POST /api/channels/{$}")
	add("humanapi", "human", rvp, channel, "none", gatesFirst405, "mount", "GET, POST", "* /api/channels", "* /api/channels/{$}")
	add("humanapi", "human", rvp, channel, "none", "dispatcher; literal mounts win; unknown children 404; implemented child method mismatch 405 Allow", "mount", "", "* /api/channels/{rest...}")
	add("humanapi", "human", rvp, channel, "none", "implemented logical dispatcher child", "dispatch", "",
		"POST /api/channels/system/all/hide", "POST /api/channels/system/all/restore",
		"GET /api/channels/{id}", "PATCH /api/channels/{id}", "DELETE /api/channels/{id}",
		"POST /api/channels/{id}/archive", "POST /api/channels/{id}/unarchive", "POST /api/channels/{id}/join", "POST /api/channels/{id}/leave",
		"GET /api/channels/{id}/members", "POST /api/channels/{id}/members", "POST /api/channels/{id}/members/batch",
		"DELETE /api/channels/{id}/members/agent/{memberId}", "DELETE /api/channels/{id}/members/user/{memberId}",
		"PATCH /api/channels/{id}/members/{targetType}/{memberId}/role", "GET /api/channels/{id}/agents")
	for _, path := range []string{"read", "read-all", "unread", "notification-settings", "message-display-settings", "files", "convert-to-joint", "joint-invites", "disconnect", "stop-all-agents", "resume-all-agents", "joint-invite/resend"} {
		add("humanapi", "human", rvp, channel, "none", "501 dispatcher branch when no more-specific real mount handles the method", "dispatch", "", "* /api/channels/{id}/"+path)
	}
	for _, family := range []string{"dm", "unread", "activity", "inbox", "threads", "saved", "joint-invites"} {
		add("humanapi", "human", rvp, channel, "none", "501 reserved first-segment family root/descendants only when no implemented literal route wins", "dispatch", "", "* /api/channels/"+family+"/{tail...}")
	}

	// Conversation literals outrank the channel dispatcher even for an
	// unsupported method; they keep their own precise 405/Allow behavior.
	add("humanapi", "human", rvp, channel, "none", "implemented", "mount", "",
		"GET /api/channels/dm", "POST /api/channels/dm", "GET /api/channels/threads/followed",
		"POST /api/channels/threads/follow", "POST /api/channels/threads/unfollow",
		"POST /api/channels/{id}/threads", "GET /api/channels/{id}/threads", "GET /api/channels/{id}/threads/{messageId}")
	add("humanapi", "human", rvp, channel, "none", gatesFirst405, "mount", "GET, POST", "* /api/channels/dm", "* /api/channels/{id}/threads")
	add("humanapi", "human", rvp, channel, "none", gatesFirst405, "mount", "GET", "* /api/channels/threads/followed", "* /api/channels/{id}/threads/{messageId}")
	add("humanapi", "human", rvp, channel, "none", gatesFirst405, "mount", "POST", "* /api/channels/threads/follow", "* /api/channels/threads/unfollow")

	// Message dispatcher branches retain the single per-user write bucket.
	add("humanapi", "human", rvp, channel, messageRate, "implemented", "mount", "", "POST /api/messages", "POST /api/v2/messages")
	add("humanapi", "human", rvp, channel, "none", gatesFirst405, "mount", "POST", "* /api/messages", "* /api/v2/messages")
	add("humanapi", "human", rvp, channel, "reaction mutations use the shared per-user write bucket; reads none", "dispatcher; unknown 404; child method mismatch 405", "mount", "", "* /api/messages/{rest...}")
	add("humanapi", "human", rvp, channel, "none", "implemented logical dispatcher child", "dispatch", "",
		"GET /api/messages/sync", "GET /api/messages/channel/{channelId}", "GET /api/messages/context/{messageId}",
		"GET /api/messages/{messageId}/reactions/actors", "GET /api/messages/{messageId}/reactions/viewer")
	add("humanapi", "human", rvp, channel, messageRate, "implemented logical dispatcher child", "dispatch", "",
		"POST /api/messages/{messageId}/reactions", "DELETE /api/messages/{messageId}/reactions")
	add("humanapi", "human", rvp, channel, "none", "501 not implemented; gates and method checks first", "dispatch", "",
		"GET /api/messages/search", "POST /api/messages/forward", "POST /api/messages/mention-actions/execute")

	// Human Agent management and actual runtime catalog paths.
	add("humanapi", "human", rvp, "user-scoped; ownership checked by handler", "none", "implemented", "mount", "",
		"GET /api/agents/manageable", "POST /api/agents/{id}/credentials", "GET /api/agents/{id}/credentials", "DELETE /api/agents/{id}/credentials/{credentialId}")
	const agentScope = "agentScope + agentGuestGate; guests can read list/detail only"
	add("humanapi", "human", rvp, agentScope, "none", "implemented", "mount", "",
		"GET /api/agents", "POST /api/agents", "GET /api/agents/{id}", "PATCH /api/agents/{id}", "DELETE /api/agents/{id}",
		"POST /api/agents/{id}/start", "POST /api/agents/{id}/stop", "POST /api/agents/{id}/reset", "POST /api/agents/{id}/assign-machine",
		"POST /api/agents/{id}/bootstrap-tokens", "POST /api/agents/{id}/avatar",
		"GET /api/agents/{id}/onboarding-identity-adoption", "POST /api/agents/{id}/onboarding-identity-adoption")
	add("humanapi", "human", rvp, agentScope, "none", "501 only after permission checks; reminders refuses guests before owner resolution", "mount", "",
		"GET /api/agents/{id}/skills", "GET /api/reminders")
	add("humanapi", "human", rvp, "workspace/X-Server-Id and membership checked inside runtime handler", "none", "implemented", "mount", "",
		"GET /api/servers/{id}/machines/{machineId}/runtime-options",
		"GET /api/servers/{id}/machines/{machineId}/runtime-form-definitions/{runtimeId}",
		"GET /api/servers/{id}/machines/{machineId}/runtime-form-definitions/{runtimeId}/option-sources/{sourceId}",
		"GET /api/servers/{id}/machines/{machineId}/runtime-models/{runtime}",
		"POST /api/servers/{id}/machines/{machineId}/runtimes/rescan", "GET /api/agents/{id}/runtime-options")
	add("humanapi", "human", rvp, management, "none", "implemented human machine management", "mount", "",
		"POST /api/servers/{id}/machines", "PATCH /api/servers/{id}/machines/{machineId}",
		"DELETE /api/servers/{id}/machines/{machineId}", "POST /api/servers/{id}/machines/{machineId}/rotate-key")
	add("humanapi", "human", rvp, management, "none", gatesFirst405, "mount", "PATCH, DELETE", "* /api/servers/{id}/machines/{machineId}")
	add("humanapi", "human", rvp, management, "none", gatesFirst405, "mount", "POST", "* /api/servers/{id}/machines/{machineId}/rotate-key")

	// Six admission routes have SIX separate limiter instances. Preserve
	// Require-only human admission and the distinct public exchange proofs.
	add("computerapi", "exchange", "none", "none", admissionRate, "public device grant initiation; feature/config gate", "mount", "", "POST /api/auth/device/authorize")
	add("computerapi", "exchange", "device-grant", "none", admissionRate, "feature-gated token exchange", "mount", "", "POST /api/auth/device/token")
	add("computerapi", "exchange", "bootstrap-token", "none", admissionRate, "feature-gated bootstrap exchange", "mount", "", "POST /api/agent/login")
	add("computerapi", "human", "Require", "handler validates device/attachment proof", admissionRate, "feature-gated admission", "mount", "",
		"POST /api/auth/device/approve", "POST /api/computer/attach", "GET /api/computer/legacy-machines")
	const computerGate = "computer-key" // Includes the original sk_machine alias.
	add("computerapi", "computer-key", "computer-registry", "credential principal", "none",
		"registry dispatcher; unregistered method/path returns 401 before credential check", "mount", "", "* /internal/computer/")
	add("computerapi", "computer-key", computerGate, "credential principal", "none", "implemented registry child; read-only preflight of live registry", "dispatch", "", "POST /internal/computer/preflight")
	add("computerapi", "computer-key", computerGate, "bound runner owner/workspace", "none", "implemented", "mount", "",
		"GET /internal/computer/runners", "POST /internal/computer/runners/{agentId}/stop",
		"POST /internal/computer/runners/{agentId}/credentials", "DELETE /internal/computer/runners/{agentId}/credentials/{credentialId}")
	add("computerapi", "computer-key", computerGate, "bound runner owner/workspace", "none", "404 provider_connections_disabled after authentication", "mount", "", "POST /internal/computer/runners/{agentId}/provider-connection")

	// Unknown Agent paths refuse before credential checks. Known deferred
	// first-segment families instead authenticate and then return honest 501.
	add("agentapi", "agent-key", "agent-key", "credential workspace", "none", "implemented identity; no additional capability grant required", "mount", "",
		"GET /internal/agent-api", "GET /internal/agent-api/{$}")
	add("agentapi", "agent-key", "agent-key", "credential workspace; server capability and optional active-capabilities header", "none", "implemented server directory", "mount", "", "GET /internal/agent-api/server")
	add("agentapi", "agent-key", "agent-key", "credential workspace; channels capability and optional active-capabilities header", "none", "implemented channel members", "mount", "", "GET /internal/agent-api/channel-members")
	add("agentapi", "public", "none", "none", "none", "401 unregistered method; no credential check", "mount", "", "* /internal/agent-api")
	add("agentapi", "agent-key", "agent-family-dispatch", "credential workspace for known family", "none",
		"known family 501 after auth; unknown family 401 unregistered", "mount", "", "* /internal/agent-api/{rest...}")
	for _, family := range []string{"feedback-locators", "events", "history", "knowledge", "wiki", "mcp", "send", "v2", "send-receipts", "messages", "search", "channels", "resolve-channel", "threads", "mention-actions", "mentions", "tasks", "labs", "profile", "integrations", "wake-hints", "activity", "upload", "attachment-upload-capabilities", "attachment-upload-sessions", "attachments", "reminders", "app-sources", "apps", "prepare-action", "migrations", "server", "channel-members"} {
		add("agentapi", "agent-key", "agent-key", "credential workspace", "none",
			"501 deferred first-segment family; includes family root and descendants unless exact implemented method wins", "dispatch", "", "* /internal/agent-api/"+family+"/{tail...}")
	}

	// A public rejection mount means no auth gate, not a working public API.
	add("machinews", "daemon", "daemon-proof", "bound machine", "none", "implemented WebSocket", "mount", "", "GET /daemon/connect")
	add("socketio", "human", "socketio-handshake", "connection workspace/interest/authority", "none", "implemented transport; nil config answers 501", "mount", "", "* /socket.io/")
	add("httpapi", "public", "none", "none", "none", "501 unimplemented surface", "mount", "", "* /internal/", "* /daemon/")
	add("httpapi", "public", "none", "none", "none", "404 unknown; exact account fallback Allow table gives 405; unknown auth child 501", "mount", "", "* /")
	return out
}
