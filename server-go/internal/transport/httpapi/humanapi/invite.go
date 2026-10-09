// HTTP handlers for the workspace invitation surface (M3 invitations fix):
// owner/admin management of join links and email invites under
// /api/servers/:id, plus the public invite preview and the authenticated
// accept path on /api/auth. Contract sources: the frozen TS routes
// (packages/server/src/routes/servers.ts join-links/invites handlers,
// auth.ts accept-invite/invite-info) as consumed by packages/web
// (InviteHumanDialog.tsx, SettingsPanel.tsx, auth/InviteAcceptPage.tsx).
// Domain rules, capability revalidation and transactions live in
// internal/workspace/invites.go; this file only parses requests and maps
// domain answers to the legacy statuses/bodies.
package humanapi

import (
	"context"
	"math"
	"net/http"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"strconv"
	"strings"
	"time"

	"raft.local/server-go/internal/workspace"
)

// InviteMailSender delivers the invitation email. The raw token appears only
// in the message handed to this sender — never in logs or list responses.
type InviteMailSender func(ctx context.Context, to, inviterName, serverName, token string) error

// InviteHandlers serves the invitation projection of the legacy API.
type InviteHandlers struct {
	Store *workspace.Store

	// SendInviteMail delivers the one-time email invite; nil refuses invite
	// creation honestly instead of pretending delivery happened.
	SendInviteMail InviteMailSender

	// Logger surfaces delivery failures without the token.
	Logger interface{ Warn(msg string, args ...any) }

	// Now resolves display timestamps (shares the store clock in production).
	Now func() time.Time
}

func (h *InviteHandlers) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

// requireInviteManager applies the TS route-level capability check with its
// exact sentence. Each handler preserves its own validation order; the store
// revalidates the capability inside the write transaction.
func (h *InviteHandlers) requireInviteManager(w http.ResponseWriter, r *http.Request, message string) bool {
	if !workspace.CanManage(scopeRole(r)) {
		httpx.WriteError(w, http.StatusForbidden, message)
		return false
	}
	return true
}

// ListJoinLinks implements GET /api/servers/:id/join-links: the active links,
// newest first, as the bare array the UI renders.
func (h *InviteHandlers) ListJoinLinks(w http.ResponseWriter, r *http.Request) {
	if !h.requireInviteManager(w, r, "Only server owners and admins can view join links") {
		return
	}
	links, err := h.Store.ListJoinLinks(r.Context(), r.PathValue("id"), authn.UserID(r))
	if err != nil {
		h.writeManagementError(w, err, "Failed to list join links")
		return
	}
	out := make([]map[string]any, 0, len(links))
	for _, link := range links {
		out = append(out, joinLinkWire(link))
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// CreateJoinLink implements POST /api/servers/:id/join-links. Body semantics
// mirror the TS route: absent/null/"" maxUses and expiresAt mean unlimited /
// never; maxUses follows JS Number() coercion for numbers, numeric strings
// and booleans; a non-RFC3339 expiresAt is the legacy "valid date" error.
func (h *InviteHandlers) CreateJoinLink(w http.ResponseWriter, r *http.Request) {
	if !h.requireInviteManager(w, r, "Only server owners and admins can create join links") {
		return
	}
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	expiresAt, ok := parseJoinLinkExpiresAt(w, body["expiresAt"])
	if !ok {
		return
	}
	maxUses, ok := parseJoinLinkMaxUses(w, body["maxUses"])
	if !ok {
		return
	}
	token, link, err := h.Store.CreateJoinLink(r.Context(), r.PathValue("id"), authn.UserID(r),
		workspace.JoinLinkOptions{MaxUses: maxUses, ExpiresAt: expiresAt})
	if err != nil {
		h.writeManagementError(w, err, "Failed to create join link")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"token": token, "link": joinLinkWire(link)})
}

// RevokeJoinLink implements DELETE /api/servers/:id/join-links/:linkId. The
// id is scoped to THIS workspace in the domain write; the ok body matches the
// idempotent TS answer.
func (h *InviteHandlers) RevokeJoinLink(w http.ResponseWriter, r *http.Request) {
	if !h.requireInviteManager(w, r, "Only server owners and admins can revoke join links") {
		return
	}
	if err := h.Store.RevokeJoinLink(r.Context(), r.PathValue("id"), authn.UserID(r), r.PathValue("linkId")); err != nil {
		h.writeManagementError(w, err, "Failed to revoke join link")
		return
	}
	httpx.OKTrue(w)
}

// ListInvites implements GET /api/servers/:id/invites: pending, unexpired
// email invites as the bare array the settings page renders.
func (h *InviteHandlers) ListInvites(w http.ResponseWriter, r *http.Request) {
	if !h.requireInviteManager(w, r, "Only server owners and admins can view invites") {
		return
	}
	invites, err := h.Store.ListPendingInvites(r.Context(), r.PathValue("id"), authn.UserID(r))
	if err != nil {
		h.writeManagementError(w, err, "Failed to list invites")
		return
	}
	out := make([]map[string]any, 0, len(invites))
	for _, invite := range invites {
		out = append(out, map[string]any{
			"id":              invite.ID,
			"invitedEmail":    invite.InvitedEmail,
			"invitedByUserId": invite.InvitedByUserID,
			"role":            invite.Role,
			"status":          invite.Status,
			"expiresAt":       FormatDateMS(&invite.ExpiresAt),
			"createdAt":       FormatDateMS(&invite.CreatedAt),
		})
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// CreateInvite implements POST /api/servers/:id/invites: validate email,
// then capability, then role (the TS precedence), persist the digest-only
// invite, and deliver its one-time token. Delivery failure is the legacy 500;
// recovery requires explicit revoke-and-recreate, never a fake success.
func (h *InviteHandlers) CreateInvite(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	rawEmail, _ := body["email"].(string)
	if message := workspace.ValidateInviteEmail(rawEmail); message != "" {
		httpx.WriteError(w, http.StatusBadRequest, message)
		return
	}
	if !h.requireInviteManager(w, r, "Only server owners and admins can send invites") {
		return
	}
	rawRole, rolePresent := body["role"]
	if rolePresent && rawRole != "member" && rawRole != "guest" {
		httpx.WriteError(w, http.StatusBadRequest, "role must be one of: member, guest")
		return
	}
	role := "member"
	if s, ok := rawRole.(string); ok {
		role = s
	}
	// A missing mailer cannot deliver the one-time token, so refuse BEFORE
	// persisting: an inserted row would be a pending invite whose token was
	// never shown or sent to anyone. This mirrors the TS route's honest 500,
	// not a fake 200.
	if h.SendInviteMail == nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to create invite")
		return
	}
	invited, err := h.Store.CreateEmailInvite(r.Context(), r.PathValue("id"), authn.UserID(r), rawEmail, role)
	if err != nil {
		h.writeManagementError(w, err, "Failed to create invite")
		return
	}
	if sendErr := h.SendInviteMail(r.Context(), invited.InvitedEmail,
		invited.InvitedByName, invited.WorkspaceName, invited.Token); sendErr != nil {
		// Fixed diagnostic only: the transport error text may carry the
		// recipient, mail body or SMTP credentials, and the raw invite token
		// exists solely in the delivered message — neither reaches logs.
		if h.Logger != nil {
			h.Logger.Warn("invite email delivery failed; pending invite requires revoke-and-recreate to recover",
				"workspace_id", r.PathValue("id"))
		}
		// TS semantics: the pending row was already committed, so the route
		// answers its generic 500. The row is NOT directly retryable — the
		// one-time token exists only in the failed delivery attempt and the
		// stored digest cannot regenerate it. Recovery is explicit: revoke
		// the pending invite (DELETE .../invites/:id), then create it again.
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to create invite")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"id":           invited.ID,
		"invitedEmail": invited.InvitedEmail,
		"expiresAt":    FormatDateMS(&invited.ExpiresAt),
		"role":         invited.Role,
	})
}

// RevokeInvite implements DELETE /api/servers/:id/invites/:inviteId with the
// same cross-workspace scoping and idempotent ok as join links.
func (h *InviteHandlers) RevokeInvite(w http.ResponseWriter, r *http.Request) {
	if !h.requireInviteManager(w, r, "Only server owners and admins can revoke invites") {
		return
	}
	if err := h.Store.RevokeInvite(r.Context(), r.PathValue("id"), authn.UserID(r), r.PathValue("inviteId")); err != nil {
		h.writeManagementError(w, err, "Failed to revoke invite")
		return
	}
	httpx.OKTrue(w)
}

// InviteInfo implements GET /api/auth/invite-info (public): the pre-accept
// preview for the accept page, or the single legacy 404 for anything that is
// not a currently usable token.
func (h *InviteHandlers) InviteInfo(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		httpx.WriteError(w, http.StatusBadRequest, "Token is required")
		return
	}
	info, err := h.Store.InviteInfo(r.Context(), token)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to get invite info")
		return
	}
	if info == nil {
		httpx.WriteError(w, http.StatusNotFound, "Invalid or expired invite")
		return
	}
	inviterName := any(nil)
	if info.InviterName != nil {
		inviterName = *info.InviterName
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"kind":                  info.Kind,
		"serverName":            info.ServerName,
		"inviterName":           inviterName,
		"memberCount":           info.MemberCount,
		"agentCount":            info.AgentCount,
		"insideCountsHidden":    info.InsideCountsHidden,
		"humanSeatLimitReached": info.HumanSeatLimitReached,
		"humanSeatLimitMessage": nil,
		"agreement":             nil,
	})
}

// AcceptInvite implements POST /api/auth/accept-invite (authenticated,
// verified, profile complete). The token's sentence-level failures keep the
// TS keyword → 400 mapping; anything else is the honest legacy 500.
func (h *InviteHandlers) AcceptInvite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token       string `json:"token"`
		AgreementID string `json:"agreementId"`
	}
	if !httpx.DecodeJSONBody(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Token) == "" {
		httpx.WriteError(w, http.StatusBadRequest, "Invite token is required")
		return
	}
	// agreementId is accepted for wire compatibility; no agreement provider
	// exists in this phase, so the field is intentionally inert (the TS
	// agreement_required flow is a later-phase surface).
	result, err := h.Store.AcceptInvite(r.Context(), body.Token, authn.UserID(r))
	if err != nil {
		if de := workspace.AsDomainError(err); de != nil {
			// The frozen guest gate refuses explicitly (400) rather than
			// falling through to the generic 500.
			if de.Message == workspace.MsgGuestAccessDisabled {
				httpx.WriteError(w, http.StatusBadRequest, de.Message)
				return
			}
			// The TS route maps by message keyword, not domain code: every
			// token-state sentence is a 400, while "This server no longer
			// exists" (no keyword) keeps the generic 500.
			for _, keyword := range []string{"Invalid", "expired", "already", "revoked", "usage limit", "different email", "seat limit", "limit reached"} {
				if strings.Contains(de.Message, keyword) {
					httpx.WriteError(w, http.StatusBadRequest, de.Message)
					return
				}
			}
		}
		httpx.WriteError(w, http.StatusInternalServerError, "Failed to accept invite")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"serverId":   result.ServerID,
		"serverName": result.ServerName,
	})
}

// writeManagementError maps domain answers for the management routes with
// their TS statuses: 403 sentences, 400 validation, 409 conflicts, 404 for a
// vanished workspace; infra failures fall through to the endpoint 500.
func (h *InviteHandlers) writeManagementError(w http.ResponseWriter, err error, fallback string) {
	if writeDomainError(w, err) {
		return
	}
	httpx.WriteError(w, http.StatusInternalServerError, fallback)
}

// joinLinkWire is the UI JoinLinkRecord shape (SettingsPanel.tsx): the raw
// token is present because the contract rebuilds the join URL from lists.
func joinLinkWire(link workspace.JoinLinkRecord) map[string]any {
	var maxUses any
	if link.MaxUses != nil {
		maxUses = *link.MaxUses
	}
	return map[string]any{
		"id":        link.ID,
		"token":     link.Token,
		"createdAt": FormatDateMS(&link.CreatedAt),
		"expiresAt": FormatDateMS(link.ExpiresAt),
		"maxUses":   maxUses,
		"useCount":  link.UseCount,
		"revokedAt": FormatDateMS(link.RevokedAt),
	}
}

// parseJoinLinkExpiresAt applies the TS `expiresAt ? new Date(...) : null`
// semantics: absent/null/"" mean never; anything else must parse as an
// RFC3339 timestamp (the web always sends toISOString()).
func parseJoinLinkExpiresAt(w http.ResponseWriter, raw any) (*time.Time, bool) {
	switch v := raw.(type) {
	case nil:
		return nil, true
	case string:
		if v == "" {
			return nil, true
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
			if parsed, err := time.Parse(layout, v); err == nil {
				utc := parsed.UTC()
				return &utc, true
			}
		}
		httpx.WriteError(w, http.StatusBadRequest, "expiresAt must be a valid date")
		return nil, false
	default:
		httpx.WriteError(w, http.StatusBadRequest, "expiresAt must be a valid date")
		return nil, false
	}
}

// parseJoinLinkMaxUses applies the TS `Number(maxUses)` + integer coercion:
// absent/null/"" mean unlimited; numbers, numeric strings and booleans
// convert like JS; everything else is the legacy positive-integer error.
func parseJoinLinkMaxUses(w http.ResponseWriter, raw any) (*int64, bool) {
	switch v := raw.(type) {
	case nil:
		return nil, true
	case string:
		if v == "" {
			return nil, true
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil || f != math.Trunc(f) {
			httpx.WriteError(w, http.StatusBadRequest, "maxUses must be a positive integer")
			return nil, false
		}
		return maxUsesPointer(w, f)
	case float64:
		if v != math.Trunc(v) {
			httpx.WriteError(w, http.StatusBadRequest, "maxUses must be a positive integer")
			return nil, false
		}
		return maxUsesPointer(w, v)
	case bool:
		if v {
			return maxUsesPointer(w, 1)
		}
		httpx.WriteError(w, http.StatusBadRequest, "maxUses must be a positive integer")
		return nil, false
	default:
		httpx.WriteError(w, http.StatusBadRequest, "maxUses must be a positive integer")
		return nil, false
	}
}

// maxUsesPointer applies the route-level positive-integer rule with the
// route's exact sentence ("maxUses must be a positive integer"); the domain
// keeps the service-level "Max uses..." sentence for direct store callers.
func maxUsesPointer(w http.ResponseWriter, value float64) (*int64, bool) {
	cast := int64(value)
	if cast < 1 || cast > 1<<53-1 {
		httpx.WriteError(w, http.StatusBadRequest, "maxUses must be a positive integer")
		return nil, false
	}
	return &cast, true
}
