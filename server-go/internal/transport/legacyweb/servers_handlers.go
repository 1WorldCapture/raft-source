// HTTP handlers for the workspace "servers" surface (W01-W07): create with
// the legacy truthiness/type semantics, the ordered list, the account-level
// switcher order, detail, profile patch and avatar upload. Domain rules and
// transactions live in internal/workspace; this file only parses requests and
// maps domain answers to the legacy statuses/bodies.
package legacyweb

import (
	"math"
	"net/http"
	"strconv"
	"time"

	"raft.local/server-go/internal/workspace"
)

// ServersHandlers serves the workspace projection of the legacy servers API.
type ServersHandlers struct {
	Store *workspace.Store

	// Now feeds the time-dependent list projection (the plan history window).
	// It shares the store clock in production and is injectable in tests.
	Now func() time.Time

	// Avatar storage mirrors AvatarHandlers: server avatars are content
	// addressed PNGs under <Dir>/servers and served from /api/avatars/servers.
	AvatarDir      string
	MaxAvatarBytes int64
	MaxAvatarSide  int
}

func (h *ServersHandlers) now() time.Time {
	if h.Now != nil {
		return h.Now()
	}
	return time.Now()
}

// The frozen free-plan full-featured trial window (shared/index.ts): during
// the window free servers read as unlimited history, after it 30 days. The
// dates are contract, not configuration; the clock is the only variable.
var (
	trialWindowStart = time.Date(2026, 4, 18, 0, 0, 0, 0, time.UTC)
	trialWindowEnd   = time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC)
)

// planHistoryDays mirrors getEffectiveLimits(plan, now).messageHistoryDays:
// -1 is unlimited. founder/partner/pro are unlimited; empty plan reads as
// free (TS `plan || "free"`); a value outside the plan enum cannot be stored
// by the schema, so the default arm is unlimited like every real paid plan.
func planHistoryDays(plan string, now time.Time) int {
	if plan == "" || plan == "free" {
		if !now.Before(trialWindowStart) && now.Before(trialWindowEnd) {
			return -1
		}
		return 30
	}
	return -1
}

// historyCutoff is the day-window filter for finite-history plans; nil for
// unlimited plans (TS historyCutoff: null).
func historyCutoff(plan string, now time.Time) *string {
	days := planHistoryDays(plan, now)
	if days < 0 {
		return nil
	}
	cutoff := now.UTC().AddDate(0, 0, -days).Format("2006-01-02T15:04:05.000Z")
	return &cutoff
}

// List writes the caller's real memberships with the account-level ordering
// and version (the domain applies the saved order); [] is a true answer.
func (h *ServersHandlers) List(w http.ResponseWriter, r *http.Request) {
	memberships, err := h.Store.ListUserServers(r.Context(), userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to list servers")
		return
	}
	now := h.now()
	out := make([]map[string]any, 0, len(memberships))
	for _, m := range memberships {
		plan := m.Plan
		out = append(out, map[string]any{
			"id":                    m.ID,
			"name":                  m.Name,
			"avatarUrl":             m.AvatarURL,
			"slug":                  m.Slug,
			"ownerId":               m.OwnerID,
			"onboardingAgentId":     m.OnboardingAgentID,
			"hideHumansFromMembers": m.HideHumansFromMembers,
			"plan":                  plan,
			"planDowngradedAt":      FormatDateMS(m.PlanDowngradedAt),
			"role":                  m.Role,
			"serverPushMuted":       m.ServerPushMuted,
			"createdAt":             FormatDateMS(&m.CreatedAt),
			"serverOrderVersion":    m.ServerOrderVersion,
			"messageHistoryDays":    planHistoryDays(plan, now),
			"historyCutoff":         historyCutoff(plan, now),
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// Create implements POST /api/servers (W01). Raw-JSON truthiness and type
// compatibility live here exactly like the legacy route: falsy name/slug is
// the combined "required" error, a truthy non-string slug is "Slug is
// required", and slug length/pattern plus the active-conflict mapping belong
// to the domain.
func (h *ServersHandlers) Create(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	rawName, rawSlug := body["name"], body["slug"]
	if !jsTruthy(rawName) || !jsTruthy(rawSlug) {
		writeError(w, http.StatusBadRequest, "Name and slug are required")
		return
	}
	slug, ok := rawSlug.(string)
	if !ok {
		writeError(w, http.StatusBadRequest, "Slug is required")
		return
	}
	name, convertible := jsTextValue(rawName)
	if !convertible {
		// A truthy array/object name cannot become a text column; the legacy
		// insert fails and the route answers its generic 500.
		writeError(w, http.StatusInternalServerError, "Failed to create server")
		return
	}
	record, err := h.Store.CreateWorkspace(r.Context(), userID(r), name, slug)
	if err != nil {
		if !writeDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to create server")
		}
		return
	}
	writeJSON(w, http.StatusOK, record)
}

// jsTruthy evaluates JSON values with the legacy JS truthiness rules.
func jsTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case string:
		return t != ""
	default:
		return true
	}
}

// jsTextValue converts a truthy JSON scalar the way the legacy text column
// coerced it: strings stay, numbers and booleans use their JS string form.
// Structured values report convertible=false.
func jsTextValue(v any) (string, bool) {
	switch t := v.(type) {
	case string:
		return t, true
	case float64:
		if t == 0 {
			return "0", true // JS String(-0) is "0"
		}
		return strconv.FormatFloat(t, 'g', -1, 64), true
	case bool:
		if t {
			return "true", true
		}
		return "false", true
	default:
		return "", false
	}
}

// GetOrder implements GET /api/servers/order (W03): the effective saved
// order (filtered to real memberships, missing ones appended) with its
// version; never null — an unset order is [] with version 0.
func (h *ServersHandlers) GetOrder(w http.ResponseWriter, r *http.Request) {
	order, err := h.Store.GetOrder(r.Context(), userID(r))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to get server order")
		return
	}
	writeJSON(w, http.StatusOK, order)
}

// UpdateOrder implements PATCH /api/servers/order (W04). The body must be a
// string array; foreign, unknown and duplicate IDs are filtered silently
// (never a 403) and missing memberships are appended by the domain, inside
// its transaction, with a no-op update leaving the version untouched.
func (h *ServersHandlers) UpdateOrder(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	ids, ok := normalizeOrderIDs(body["serverOrder"])
	if !ok {
		writeError(w, http.StatusBadRequest, "serverOrder must be an array of string IDs")
		return
	}
	order, err := h.Store.UpdateOrder(r.Context(), userID(r), ids)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to update server order")
		return
	}
	writeJSON(w, http.StatusOK, order)
}

// normalizeOrderIDs validates and dedupes the request array like the legacy
// normalizeOrderIds: every element must be a string; first occurrence wins.
func normalizeOrderIDs(raw any) ([]string, bool) {
	items, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	seen := make(map[string]bool, len(items))
	ids := make([]string, 0, len(items))
	for _, item := range items {
		id, isString := item.(string)
		if !isString {
			return nil, false
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids, true
}

// GetWorkspace implements GET /api/servers/:id (W05): ID lookup only, the
// bare ServerRecord. The scope middleware has already established
// membership; a row that vanished afterwards is the endpoint's own 404.
func (h *ServersHandlers) GetWorkspace(w http.ResponseWriter, r *http.Request) {
	record, err := h.Store.GetWorkspace(r.Context(), r.PathValue("id"))
	if err != nil {
		if !writeDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to get server")
		}
		return
	}
	writeJSON(w, http.StatusOK, record)
}

// UpdateWorkspace implements PATCH /api/servers/:id (W06): name and
// hideHumansFromMembers only, owner/admin gated before any field validation
// (the legacy order), with type checks here because the patch pointers must
// distinguish absent from present; the sentence-level validation and the
// write itself run transactionally in the domain.
func (h *ServersHandlers) UpdateWorkspace(w http.ResponseWriter, r *http.Request) {
	if !workspace.CanManage(scopeRole(r)) {
		writeError(w, http.StatusForbidden, "Only server owners and admins can edit the server profile")
		return
	}
	var body map[string]any
	if !decodeJSONBody(w, r, &body) {
		return
	}
	patch := workspace.ProfilePatch{}
	if raw, present := body["name"]; present {
		s, ok := raw.(string)
		if !ok {
			writeError(w, http.StatusBadRequest, "Name must be a string")
			return
		}
		patch.Name = &s
	}
	if raw, present := body["hideHumansFromMembers"]; present {
		b, ok := raw.(bool)
		if !ok {
			writeError(w, http.StatusBadRequest, "hideHumansFromMembers must be a boolean")
			return
		}
		patch.HideHumansFromMembers = &b
	}
	if patch.Name == nil && patch.HideHumansFromMembers == nil {
		writeError(w, http.StatusBadRequest, "At least one field is required")
		return
	}
	record, err := h.Store.UpdateProfile(r.Context(), r.PathValue("id"), userID(r), patch)
	if err != nil {
		if !writeDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to update server")
		}
		return
	}
	writeJSON(w, http.StatusOK, record)
}

// UploadWorkspaceAvatar implements POST /api/servers/:id/avatar (W07). The
// capability gate and the workspace existence check run before any upload
// decoding; the file is validated, re-encoded to PNG and published by the
// shared avatar pipeline, and only then does the domain transaction store
// the reference — a database failure is never masked as success.
func (h *ServersHandlers) UploadWorkspaceAvatar(w http.ResponseWriter, r *http.Request) {
	if !workspace.CanManage(scopeRole(r)) {
		writeError(w, http.StatusForbidden, "Only server owners and admins can edit the server profile")
		return
	}
	if _, err := h.Store.GetWorkspace(r.Context(), r.PathValue("id")); err != nil {
		if !writeDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to upload avatar")
		}
		return
	}
	png, ok := decodeValidatedAvatarPNG(w, r, h.MaxAvatarBytes, h.MaxAvatarSide)
	if !ok {
		return
	}
	avatarURL, err := publishServerAvatar(h.AvatarDir, png)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to upload avatar")
		return
	}
	record, err := h.Store.SetAvatar(r.Context(), r.PathValue("id"), userID(r), avatarURL)
	if err != nil {
		if !writeDomainError(w, err) {
			writeError(w, http.StatusInternalServerError, "Failed to upload avatar")
		}
		return
	}
	writeJSON(w, http.StatusOK, record)
}
