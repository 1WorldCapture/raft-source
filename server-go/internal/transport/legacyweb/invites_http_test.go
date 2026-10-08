package legacyweb_test

// Behavioral tests for the M3 invitations fix: join-link and email-invite
// management, the public preview and the logged-in accept path, driven
// through the fully wired handler (auth gates, scope, guest denial) with an
// in-process recorder. Contract pins come from the frozen TS routes
// (servers.ts join-links/invites, auth.ts invite-info/accept-invite) and the
// web consumers (InviteHumanDialog, SettingsPanel, InviteAcceptPage).

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"raft.local/server-go/internal/platform/mail"
)

// decodeBareArray parses a bare JSON array response (list endpoints).
func decodeBareArray(t *testing.T, raw []byte) []map[string]any {
	t.Helper()
	var arr []map[string]any
	if err := json.Unmarshal(raw, &arr); err != nil {
		t.Fatalf("bare array body: %v (%s)", err, raw)
	}
	return arr
}

// inviteOutboxToken returns the one-time raw invite token the mail delivery
// carried to the given address (the only place the raw value exists).
func inviteOutboxToken(t *testing.T, outbox, to string) string {
	t.Helper()
	entries, err := mail.ReadOutbox(outbox, 30)
	if err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	for _, entry := range entries {
		if entry.Kind == "invite" && entry.To == to && entry.Token != "" {
			return entry.Token
		}
	}
	t.Fatalf("no invite mail delivered to %s", to)
	return ""
}

func TestJoinLinkManagementAuthorization(t *testing.T) {
	env := newTestEnv(t)
	_, ownerToken, _ := env.fullAccount("inv-owner@example.com", "invowner")
	memberID, memberToken, _ := env.fullAccount("inv-member@example.com", "invmember")
	guestID, guestToken, _ := env.fullAccount("inv-guest@example.com", "invguest")
	_, strangerToken, _ := env.fullAccount("inv-stranger@example.com", "invstranger")
	workspaceID := env.createServer(t, ownerToken, "Invites Auth", "invites-auth-ws")
	env.addMember(t, workspaceID, memberID, "member")
	env.addMember(t, workspaceID, guestID, "guest")

	// Unauthenticated and unscoped calls never reach the handler.
	if res := env.serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, nil); res.status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated list: %d", res.status)
	}
	if res := env.serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, bearer(ownerToken)); res.status != http.StatusBadRequest {
		t.Fatalf("missing X-Server-Id: %d", res.status)
	}
	stranger := env.serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, scoped(strangerToken, workspaceID))
	if stranger.status != http.StatusForbidden || stranger.body["error"] != "Not a member of this server" {
		t.Fatalf("stranger scope: %d %v", stranger.status, stranger.body)
	}

	// Guests hit the management-surface denial; ordinary members hit the
	// capability sentence — both exact.
	if res := env.serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, scoped(guestToken, workspaceID)); res.status != http.StatusForbidden || res.body["error"] != "Guests cannot access server management data" {
		t.Fatalf("guest list: %d %v", res.status, res.body)
	}
	for _, tc := range []struct{ method, path, want string }{
		{"GET", "/join-links", "Only server owners and admins can view join links"},
		{"POST", "/join-links", "Only server owners and admins can create join links"},
		{"DELETE", "/join-links/x", "Only server owners and admins can revoke join links"},
		{"GET", "/invites", "Only server owners and admins can view invites"},
		{"POST", "/invites", "Only server owners and admins can send invites"},
		{"DELETE", "/invites/x", "Only server owners and admins can revoke invites"},
	} {
		// The TS email-invite route validates email before this capability
		// check; use a valid email so this matrix reaches authorization.
		res := env.serve(tc.method, "/api/servers/"+workspaceID+tc.path, map[string]any{"email": "target@example.com"}, scoped(memberToken, workspaceID))
		if res.status != http.StatusForbidden || res.body["error"] != tc.want {
			t.Fatalf("%s %s as member: %d %v", tc.method, tc.path, res.status, res.body)
		}
	}

	// The owner (and admin) may manage.
	if res := env.serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"maxUses": nil, "expiresAt": nil}, scoped(ownerToken, workspaceID)); res.status != http.StatusOK {
		t.Fatalf("owner create: %d %s", res.status, res.raw)
	}
}

func TestJoinLinkLifecycleAndLimits(t *testing.T) {
	env := newTestEnv(t)
	_, ownerToken, _ := env.fullAccount("jl-owner@example.com", "jlowner")
	_, joinerToken, _ := env.fullAccount("jl-joiner@example.com", "jljoiner")
	_, secondJoinerToken, _ := env.fullAccount("jl-second@example.com", "jlsecond")
	workspaceID := env.createServer(t, ownerToken, "Join Links", "join-links-ws")

	// Body validation mirrors the TS route sentences.
	for _, body := range []map[string]any{
		{"maxUses": 0},
		{"maxUses": -3},
		{"maxUses": 2.5},
		{"maxUses": "abc"},
		{"maxUses": map[string]any{}},
	} {
		res := env.serve("POST", "/api/servers/"+workspaceID+"/join-links", body, scoped(ownerToken, workspaceID))
		if res.status != http.StatusBadRequest || res.body["error"] != "maxUses must be a positive integer" {
			t.Fatalf("maxUses %v: %d %v", body["maxUses"], res.status, res.body)
		}
	}
	badDate := env.serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"expiresAt": "not-a-date"}, scoped(ownerToken, workspaceID))
	if badDate.status != http.StatusBadRequest || badDate.body["error"] != "expiresAt must be a valid date" {
		t.Fatalf("expiresAt: %d %v", badDate.status, badDate.body)
	}

	// The UI dialog flow: GET (empty list) -> POST an unlimited link.
	empty := env.serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, scoped(ownerToken, workspaceID))
	if empty.status != http.StatusOK || len(decodeBareArray(t, empty.raw)) != 0 {
		t.Fatalf("empty list: %d %s", empty.status, empty.raw)
	}
	created := env.serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"maxUses": nil, "expiresAt": nil}, scoped(ownerToken, workspaceID))
	if created.status != http.StatusOK {
		t.Fatalf("create: %d %s", created.status, created.raw)
	}
	token, _ := created.body["token"].(string)
	link, _ := created.body["link"].(map[string]any)
	if token == "" || link == nil {
		t.Fatalf("create body missing token/link: %s", created.raw)
	}
	for key, want := range map[string]any{"useCount": float64(0), "maxUses": nil, "expiresAt": nil, "revokedAt": nil} {
		if got, ok := link[key]; !ok || got != want {
			t.Fatalf("link.%s = %v (%T), want %v", key, got, got, want)
		}
	}
	if link["token"] != token {
		t.Fatalf("link.token %v != response token %v (the UI rebuilds the URL from it)", link["token"], token)
	}
	if _, ok := link["createdAt"].(string); !ok {
		t.Fatalf("link.createdAt missing: %v", link["createdAt"])
	}

	// Public preview for the accept page.
	info := env.serve("GET", "/api/auth/invite-info?token="+token, nil, nil)
	if info.status != http.StatusOK || info.body["kind"] != "join_link" {
		t.Fatalf("info: %d %s", info.status, info.raw)
	}
	if info.body["serverName"] != "Join Links" {
		t.Fatalf("info serverName: %v", info.body["serverName"])
	}
	if info.body["insideCountsHidden"] != false || info.body["agreement"] != nil || info.body["humanSeatLimitReached"] != false {
		t.Fatalf("info defaults drifted: %s", info.raw)
	}

	// Accept joins as member; a repeated accept stays idempotent and the use
	// count advances exactly once.
	accepted := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": token}, bearer(joinerToken))
	if accepted.status != http.StatusOK || accepted.body["serverId"] != workspaceID || accepted.body["serverName"] != "Join Links" {
		t.Fatalf("accept: %d %s", accepted.status, accepted.raw)
	}
	if again := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": token}, bearer(joinerToken)); again.status != http.StatusOK {
		t.Fatalf("idempotent re-accept: %d %s", again.status, again.raw)
	}
	links := env.serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, scoped(ownerToken, workspaceID))
	rows := decodeBareArray(t, links.raw)
	if len(rows) != 1 {
		t.Fatalf("list length: %d (%s)", len(rows), links.raw)
	}
	if rows[0]["token"] != token || rows[0]["useCount"] != float64(1) {
		t.Fatalf("listed link drifted: %v", rows[0])
	}

	// maxUses=1: the first joiner consumes it, everyone after gets the
	// legacy usage-limit sentence and the preview collapses to 404.
	limited := env.serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"maxUses": 1}, scoped(ownerToken, workspaceID))
	if limited.status != http.StatusOK {
		t.Fatalf("limited create: %d %s", limited.status, limited.raw)
	}
	limitedToken, _ := limited.body["token"].(string)
	if res := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": limitedToken}, bearer(secondJoinerToken)); res.status != http.StatusOK {
		t.Fatalf("limited accept: %d %s", res.status, res.raw)
	}
	if res := env.serve("GET", "/api/auth/invite-info?token="+limitedToken, nil, nil); res.status != http.StatusNotFound {
		t.Fatalf("exhausted preview: %d", res.status)
	}
	exhausted := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": limitedToken}, bearer(joinerToken))
	if exhausted.status != http.StatusBadRequest || exhausted.body["error"] != "This invite has already reached its usage limit" {
		t.Fatalf("exhausted accept: %d %v", exhausted.status, exhausted.body)
	}

	// Expiry behaves identically (backdated row).
	expiring := env.serve("POST", "/api/servers/"+workspaceID+"/join-links", map[string]any{"expiresAt": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, scoped(ownerToken, workspaceID))
	if expiring.status != http.StatusOK {
		t.Fatalf("expiring create: %d %s", expiring.status, expiring.raw)
	}
	expiringLink, _ := expiring.body["link"].(map[string]any)
	expiringToken, _ := expiring.body["token"].(string)
	if _, err := env.app.DB.Exec(`UPDATE workspace_join_links SET expires_at = ? WHERE id = ?`, time.Now().Add(-time.Minute).UnixMilli(), expiringLink["id"]); err != nil {
		t.Fatal(err)
	}
	expired := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": expiringToken}, bearer(secondJoinerToken))
	if expired.status != http.StatusBadRequest || expired.body["error"] != "This invite has expired" {
		t.Fatalf("expired accept: %d %v", expired.status, expired.body)
	}

	// Revocation removes the link from management and kills the token.
	linkID, _ := link["id"].(string)
	if res := env.serve("DELETE", "/api/servers/"+workspaceID+"/join-links/"+linkID, nil, scoped(ownerToken, workspaceID)); res.status != http.StatusOK || res.body["ok"] != true {
		t.Fatalf("revoke: %d %s", res.status, res.raw)
	}
	if res := env.serve("GET", "/api/auth/invite-info?token="+token, nil, nil); res.status != http.StatusNotFound || res.body["error"] != "Invalid or expired invite" {
		t.Fatalf("info after revoke: %d %v", res.status, res.body)
	}
	revoked := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": token}, bearer(secondJoinerToken))
	if revoked.status != http.StatusBadRequest || revoked.body["error"] != "This invite has been revoked" {
		t.Fatalf("accept revoked: %d %v", revoked.status, revoked.body)
	}
	// The exhausted limited link is filtered too: the list is empty now.
	afterRevoke := env.serve("GET", "/api/servers/"+workspaceID+"/join-links", nil, scoped(ownerToken, workspaceID))
	if rows := decodeBareArray(t, afterRevoke.raw); len(rows) != 0 {
		t.Fatalf("revoked/exhausted links still listed: %s", afterRevoke.raw)
	}
}

func TestEmailInviteFlow(t *testing.T) {
	env := newTestEnv(t)
	_, ownerToken, _ := env.fullAccount("em-owner@example.com", "emowner")
	invitedID, invitedToken, _ := env.fullAccount("em-invited@example.com", "eminvited")
	_, otherToken, _ := env.fullAccount("em-other@example.com", "emother")
	workspaceID := env.createServer(t, ownerToken, "Email Invites", "email-invites-ws")
	env.addMember(t, workspaceID, invitedID, "member")

	// Validation precedes persistence with the TS sentences.
	invalidEmail := env.serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "not-an-email"}, scoped(ownerToken, workspaceID))
	if invalidEmail.status != http.StatusBadRequest || invalidEmail.body["error"] != "Enter a valid email address" {
		t.Fatalf("invalid email: %d %v", invalidEmail.status, invalidEmail.body)
	}
	badRole := env.serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "someone@example.com", "role": "admin"}, scoped(ownerToken, workspaceID))
	if badRole.status != http.StatusBadRequest || badRole.body["error"] != "role must be one of: member, guest" {
		t.Fatalf("invalid role: %d %v", badRole.status, badRole.body)
	}
	// Frozen M3 guest gate: the TS route refuses guest invites while the
	// feature flag is disabled, and M3 freezes it disabled — same sentence,
	// same 400, no silent member downgrade, no row persisted.
	var guestRows int
	if err := env.app.DB.QueryRow(`SELECT COUNT(*) FROM workspace_invites WHERE role = 'guest'`).Scan(&guestRows); err != nil {
		t.Fatal(err)
	}
	guestCreate := env.serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "would-be-guest@example.com", "role": "guest"}, scoped(ownerToken, workspaceID))
	if guestCreate.status != http.StatusBadRequest || guestCreate.body["error"] != "Guest access is not enabled for this server" {
		t.Fatalf("guest create under disabled gate: %d %v", guestCreate.status, guestCreate.body)
	}
	var guestRowsAfter int
	if err := env.app.DB.QueryRow(`SELECT COUNT(*) FROM workspace_invites WHERE role = 'guest'`).Scan(&guestRowsAfter); err != nil {
		t.Fatal(err)
	}
	if guestRowsAfter != guestRows {
		t.Fatalf("guest invite persisted under disabled gate: %d -> %d", guestRows, guestRowsAfter)
	}
	// Inviting an address that already belongs to a member is the 409.
	if res := env.serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "Em-Invited@Example.com"}, scoped(ownerToken, workspaceID)); res.status != http.StatusConflict || res.body["error"] != "This user is already a member of this server" {
		t.Fatalf("member email invite: %d %v", res.status, res.body)
	}

	// A guest invite persisted by an earlier policy (or a direct write) must
	// also be refused at acceptance — explicitly, without downgrading the
	// join to member and without consuming or mutating the row.
	legacyGuestToken := "legacy-guest-invite-token-0123456789abcdef"
	digest := sha256.Sum256([]byte(legacyGuestToken))
	if _, err := env.app.DB.Exec(`
		INSERT INTO workspace_invites
			(id, workspace_id, invited_email, invited_by_user_id, role, token_digest, status, expires_at, created_at)
		VALUES (?, ?, ?, ?, 'guest', ?, 'pending', ?, ?)`,
		"legacy-guest-invite", workspaceID, "legacy-guest@example.com", invitedID,
		hex.EncodeToString(digest[:]), time.Now().Add(time.Hour).UnixMilli(), time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	legacyInfo := env.serve("GET", "/api/auth/invite-info?token="+legacyGuestToken, nil, nil)
	if legacyInfo.status != http.StatusOK || legacyInfo.body["kind"] != "email" {
		t.Fatalf("legacy guest preview: %d %s", legacyInfo.status, legacyInfo.raw)
	}
	legacyAccept := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": legacyGuestToken}, bearer(invitedToken))
	if legacyAccept.status != http.StatusBadRequest || legacyAccept.body["error"] != "Guest access is not enabled for this server" {
		t.Fatalf("legacy guest accept: %d %v", legacyAccept.status, legacyAccept.body)
	}
	var legacyStatus string
	var legacyMembership int
	if err := env.app.DB.QueryRow(`SELECT status FROM workspace_invites WHERE id = 'legacy-guest-invite'`).Scan(&legacyStatus); err != nil || legacyStatus != "pending" {
		t.Fatalf("legacy guest row mutated: %q err=%v", legacyStatus, err)
	}
	if err := env.app.DB.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ?`, workspaceID).Scan(&legacyMembership); err != nil || legacyMembership != 2 { // owner + seeded member
		t.Fatalf("guest refusal must not create membership: %d err=%v", legacyMembership, err)
	}

	// Member invite for a fresh address: normalized email, response shape and
	// real delivery through the private outbox.
	created := env.serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "  outsider+Member@Example.com  "}, scoped(ownerToken, workspaceID))
	if created.status != http.StatusOK {
		t.Fatalf("create invite: %d %s", created.status, created.raw)
	}
	if created.body["invitedEmail"] != "outsider+member@example.com" {
		t.Fatalf("email not normalized: %v", created.body["invitedEmail"])
	}
	if created.body["role"] != "member" {
		t.Fatalf("role: %v", created.body["role"])
	}
	if _, ok := created.body["expiresAt"].(string); !ok {
		t.Fatalf("create response missing expiresAt: %s", created.raw)
	}
	if _, hasToken := created.body["token"]; hasToken {
		t.Fatalf("create response leaked the raw token: %s", created.raw)
	}
	rawToken := inviteOutboxToken(t, env.outbox, "outsider+member@example.com")

	// Only the sha256 digest is stored; the raw token exists solely in mail.
	var stored string
	if err := env.app.DB.QueryRow(`SELECT token_digest FROM workspace_invites WHERE id = ?`, created.body["id"]).Scan(&stored); err != nil {
		t.Fatalf("stored invite: %v", err)
	}
	if stored == rawToken || len(stored) != 64 {
		t.Fatalf("invite token stored in recoverable form: %q", stored)
	}

	// Email binding first: a different account cannot consume the invite.
	if res := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": rawToken}, bearer(otherToken)); res.status != http.StatusBadRequest || res.body["error"] != "This invite was sent to a different email address" {
		t.Fatalf("wrong-email accept: %d %v", res.status, res.body)
	}

	// Pending list exposes the management projection.
	pending := env.serve("GET", "/api/servers/"+workspaceID+"/invites", nil, scoped(ownerToken, workspaceID))
	rows := decodeBareArray(t, pending.raw)
	if len(rows) != 2 {
		t.Fatalf("pending list length (legacy guest + fresh member): %s", pending.raw)
	}
	var memberRow map[string]any
	for _, row := range rows {
		if row["invitedEmail"] == "outsider+member@example.com" {
			memberRow = row
		}
	}
	if memberRow == nil || memberRow["status"] != "pending" || memberRow["role"] != "member" {
		t.Fatalf("pending member invite drifted: %s", pending.raw)
	}

	// Preview shows the email kind with the inviter handle.
	info := env.serve("GET", "/api/auth/invite-info?token="+rawToken, nil, nil)
	if info.status != http.StatusOK || info.body["kind"] != "email" || info.body["inviterName"] != "emowner" {
		t.Fatalf("email info: %d %s", info.status, info.raw)
	}
	if info.body["memberCount"] != float64(2) { // owner + the seeded member
		t.Fatalf("info memberCount: %v", info.body["memberCount"])
	}

	// The account holding the invited address (case-insensitive) accepts and
	// lands with the invited role.
	_, memberAccountToken, _ := env.fullAccount("Outsider+Member@example.com", "outsidermember")
	accepted := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": rawToken}, bearer(memberAccountToken))
	if accepted.status != http.StatusOK || accepted.body["serverId"] != workspaceID {
		t.Fatalf("accept invite: %d %s", accepted.status, accepted.raw)
	}
	var role string
	if err := env.app.DB.QueryRow(`SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = (SELECT id FROM users WHERE email = 'outsider+member@example.com')`, workspaceID).Scan(&role); err != nil || role != "member" {
		t.Fatalf("accepted role: %q err=%v", role, err)
	}

	// Single use with the TS precedence: the used invite answers "already
	// been used" even for the matching account (email invites are strictly
	// single-use — unlike join links, whose re-accept is conditionally
	// idempotent).
	if res := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": rawToken}, bearer(memberAccountToken)); res.status != http.StatusBadRequest || res.body["error"] != "This invite has already been used" {
		t.Fatalf("reuse: %d %v", res.status, res.body)
	}
	var status string
	if err := env.app.DB.QueryRow(`SELECT status FROM workspace_invites WHERE id = ?`, created.body["id"]).Scan(&status); err != nil || status != "accepted" {
		t.Fatalf("invite status after accept: %q err=%v", status, err)
	}

	// Pending list after accept: the member invite drained, the refused
	// legacy guest row stays pending until revoked.
	afterAccept := env.serve("GET", "/api/servers/"+workspaceID+"/invites", nil, scoped(ownerToken, workspaceID))
	if rows := decodeBareArray(t, afterAccept.raw); len(rows) != 1 || rows[0]["invitedEmail"] != "legacy-guest@example.com" {
		t.Fatalf("pending list after accept: %s", afterAccept.raw)
	}

	// An expired pending invite stops previewing and is replaceable; a live
	// duplicate is the 409; revocation deletes the row and kills the token.
	expiring := env.serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "fresh@example.com"}, scoped(ownerToken, workspaceID))
	if expiring.status != http.StatusOK {
		t.Fatalf("expiring create: %d %s", expiring.status, expiring.raw)
	}
	if _, err := env.app.DB.Exec(`UPDATE workspace_invites SET expires_at = ? WHERE id = ?`, time.Now().Add(-time.Minute).UnixMilli(), expiring.body["id"]); err != nil {
		t.Fatal(err)
	}
	if res := env.serve("GET", "/api/auth/invite-info?token="+inviteOutboxToken(t, env.outbox, "fresh@example.com"), nil, nil); res.status != http.StatusNotFound {
		t.Fatalf("expired preview: %d", res.status)
	}
	refreshed := env.serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "fresh@example.com"}, scoped(ownerToken, workspaceID))
	if refreshed.status != http.StatusOK {
		t.Fatalf("expired invite not replaceable: %d %s", refreshed.status, refreshed.raw)
	}
	dup := env.serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{"email": "fresh@example.com"}, scoped(ownerToken, workspaceID))
	if dup.status != http.StatusConflict || dup.body["error"] != "An invite has already been sent to this email" {
		t.Fatalf("duplicate invite: %d %v", dup.status, dup.body)
	}
	inviteID, _ := refreshed.body["id"].(string)
	if res := env.serve("DELETE", "/api/servers/"+workspaceID+"/invites/"+inviteID, nil, scoped(ownerToken, workspaceID)); res.status != http.StatusOK || res.body["ok"] != true {
		t.Fatalf("revoke invite: %d %s", res.status, res.raw)
	}
	var count int
	// Remaining rows: the accepted member invite and the refused legacy
	// guest invite; the expired fresh row was replaced (replacement deletes
	// the stale row) and the refreshed row was revoked.
	if err := env.app.DB.QueryRow(`SELECT COUNT(*) FROM workspace_invites WHERE workspace_id = ?`, workspaceID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("revoked invite rows: %d err=%v", count, err)
	}
	// The revoked (deleted) token no longer resolves at all.
	if res := env.serve("GET", "/api/auth/invite-info?token="+inviteOutboxToken(t, env.outbox, "fresh@example.com"), nil, nil); res.status != http.StatusNotFound {
		t.Fatalf("revoked preview: %d", res.status)
	}

	// The joined member now sees the workspace in their own server list —
	// the exact read the web performs to route after accepting.
	list := env.serve("GET", "/api/servers", nil, bearer(memberAccountToken))
	found := false
	for _, row := range decodeBareArray(t, list.raw) {
		if row["id"] == workspaceID {
			found = true
			if row["role"] != "member" {
				t.Fatalf("list role: %v", row["role"])
			}
		}
	}
	if !found {
		t.Fatalf("joined workspace missing from joiner's list: %s", list.raw)
	}
}

func TestInviteCrossWorkspaceIsolation(t *testing.T) {
	env := newTestEnv(t)
	_, ownerA, _ := env.fullAccount("iso-a@example.com", "isoalpha")
	_, ownerB, _ := env.fullAccount("iso-b@example.com", "isobeta")
	_, joiner, _ := env.fullAccount("iso-joiner@example.com", "isojoined")
	wsA := env.createServer(t, ownerA, "Iso A", "iso-alpha-ws")
	wsB := env.createServer(t, ownerB, "Iso B", "iso-beta-ws")

	createdB := env.serve("POST", "/api/servers/"+wsB+"/join-links", map[string]any{}, scoped(ownerB, wsB))
	if createdB.status != http.StatusOK {
		t.Fatalf("create in B: %d", createdB.status)
	}
	tokenB, _ := createdB.body["token"].(string)
	linkB, _ := createdB.body["link"].(map[string]any)
	idB, _ := linkB["id"].(string)

	// A's owner cannot list B's links (scope membership check) and a revoke
	// naming B's link id against A's workspace neither revokes nor errors.
	if res := env.serve("GET", "/api/servers/"+wsB+"/join-links", nil, scoped(ownerA, wsB)); res.status != http.StatusForbidden {
		t.Fatalf("cross list: %d", res.status)
	}
	if res := env.serve("DELETE", "/api/servers/"+wsA+"/join-links/"+idB, nil, scoped(ownerA, wsA)); res.status != http.StatusOK {
		t.Fatalf("cross revoke shape: %d %s", res.status, res.raw)
	}
	if res := env.serve("GET", "/api/auth/invite-info?token="+tokenB, nil, nil); res.status != http.StatusOK || res.body["serverName"] != "Iso B" {
		t.Fatalf("B's link must survive A's revoke attempt: %d %s", res.status, res.raw)
	}
	// Tokens are global capabilities, but they join exactly their own
	// workspace — never a bystander's.
	if res := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": tokenB}, bearer(joiner)); res.status != http.StatusOK || res.body["serverId"] != wsB {
		t.Fatalf("join via B token: %d %s", res.status, res.raw)
	}
	var inA int
	if err := env.app.DB.QueryRow(`SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = ? AND user_id = (SELECT id FROM users WHERE email = 'iso-joiner@example.com')`, wsA).Scan(&inA); err != nil || inA != 0 {
		t.Fatalf("joiner leaked into A: %d err=%v", inA, err)
	}
}

func TestInviteAcceptGatesAndMissingInputs(t *testing.T) {
	env := newTestEnv(t)
	// accept-invite requires identity (the auth gate outranks body
	// validation, exactly like the TS requireAuth chain); invite-info is
	// public but still demands its token parameter.
	if res := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": "x"}, nil); res.status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated accept: %d", res.status)
	}
	_, done, _ := env.fullAccount("gate-done@example.com", "gatedone")
	if res := env.serve("POST", "/api/auth/accept-invite", map[string]any{}, bearer(done)); res.status != http.StatusBadRequest || res.body["error"] != "Invite token is required" {
		t.Fatalf("missing token: %d %v", res.status, res.body)
	}
	if res := env.serve("GET", "/api/auth/invite-info", nil, nil); res.status != http.StatusBadRequest || res.body["error"] != "Token is required" {
		t.Fatalf("missing info token: %d %v", res.status, res.body)
	}
	if res := env.serve("POST", "/api/auth/accept-invite", map[string]any{"token": "nonsense-token"}, bearer(done)); res.status != http.StatusBadRequest || res.body["error"] != "Invalid invite token" {
		t.Fatalf("invalid token: %d %v", res.status, res.body)
	}
	if res := env.serve("GET", "/api/auth/invite-info?token=nonsense-token", nil, nil); res.status != http.StatusNotFound {
		t.Fatalf("invalid info token: %d", res.status)
	}
	// Method policy: the new surfaces answer 405 only after the gates, and
	// the scope check still outranks the method answer.
	if res := env.serve("PUT", "/api/servers/x/join-links", nil, nil); res.status != http.StatusUnauthorized {
		t.Fatalf("405 gate order: %d", res.status)
	}
	ws := env.createServer(t, done, "Method Order", "method-order-ws")
	mismatch := env.serve("PUT", "/api/servers/"+ws+"/join-links", nil, scoped(done, "00000000-0000-0000-0000-000000000000"))
	if mismatch.status != http.StatusBadRequest || mismatch.body["error"] != "X-Server-Id must match server id in URL" {
		t.Fatalf("scope mismatch precedence: %d %v", mismatch.status, mismatch.body)
	}
	method := env.serve("PUT", "/api/servers/"+ws+"/join-links", nil, scoped(done, ws))
	if method.status != http.StatusMethodNotAllowed {
		t.Fatalf("unsupported method: %d %v", method.status, method.body)
	}
	nested := env.serve("GET", "/api/servers/"+ws+"/join-links/some-link-id", nil, scoped(done, ws))
	if nested.status != http.StatusMethodNotAllowed {
		t.Fatalf("nested unsupported method: %d %v", nested.status, nested.body)
	}
}
