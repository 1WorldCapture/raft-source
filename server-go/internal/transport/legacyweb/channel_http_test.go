package legacyweb

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/db"
)

const (
	chOwner   = "11111111-1111-4111-8111-111111111111"
	chMember  = "22222222-2222-4222-8222-222222222222"
	chMember2 = "55555555-5555-4555-8555-555555555555"
	chGuest   = "33333333-3333-4333-8333-333333333333"
	chPending = "66666666-6666-4666-8666-666666666666"
	chUnver   = "77777777-7777-4777-8777-777777777777"
	chWS      = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	chWS2     = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	chAgent   = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
)

type channelEnv struct {
	t      *testing.T
	db     *sql.DB
	mux    *http.ServeMux
	fixed  *clock.Fixed
	signer *auth.TokenSigner
}

func newChannelEnv(t *testing.T) *channelEnv {
	t.Helper()
	handle, err := db.Open(filepath.Join(t.TempDir(), "raft.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	fixed := &clock.Fixed{T: time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)}
	store := channel.NewStoreWithOptions(handle, channel.Options{Clock: fixed})
	authStore := auth.NewStore(handle)
	signer := auth.NewTokenSigner([]byte("test-secret-0123456789abcdef0123456789abcdef"), 15*time.Minute)
	sessions := auth.NewSessionService(handle, authStore, signer, nil, 24*time.Hour, time.Minute, 24*time.Hour)
	gate := &AuthGate{Signer: signer, Sessions: sessions, Users: authStore.UserByID}
	mux := http.NewServeMux()
	RegisterChannelRoutes(mux, &ChannelHandlers{Store: store}, gate)
	env := &channelEnv{t: t, db: handle, mux: mux, fixed: fixed, signer: signer}
	env.seed()
	return env
}

func (e *channelEnv) seed() {
	e.t.Helper()
	now := e.fixed.T.UnixMilli()
	users := []struct {
		id, name string
		verified int
	}{
		{chOwner, "owner", 1},
		{chMember, "member", 1},
		{chMember2, "membertwo", 1},
		{chGuest, "guest", 1},
		{chPending, "pending_setup", 1},
		{chUnver, "unverified", 0},
	}
	for _, u := range users {
		if _, err := e.db.Exec(`INSERT INTO users (id, email, name, password_hash, email_verified, created_at, updated_at)
			VALUES (?, ?, ?, 'x', ?, ?, ?)`, u.id, u.name+"@example.test", u.name, u.verified, now, now); err != nil {
			e.t.Fatal(err)
		}
	}
	for _, ws := range []struct{ id, slug, owner string }{{chWS, "alpha", chOwner}, {chWS2, "beta", chOwner}} {
		if _, err := e.db.Exec(`INSERT INTO workspaces (id, name, slug, owner_id, created_at) VALUES (?, ?, ?, ?, ?)`,
			ws.id, "WS "+ws.slug, ws.slug, ws.owner, now); err != nil {
			e.t.Fatal(err)
		}
	}
	rows := []struct{ ws, user, role string }{
		{chWS, chOwner, "owner"},
		{chWS, chMember, "member"},
		{chWS, chMember2, "member"},
		{chWS, chGuest, "guest"},
		{chWS, chPending, "member"},
		{chWS, chUnver, "member"},
		{chWS2, chOwner, "owner"},
	}
	for _, m := range rows {
		if _, err := e.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
			VALUES (?, ?, ?, 0, ?)`, m.ws, m.user, m.role, now); err != nil {
			e.t.Fatal(err)
		}
	}
	if _, err := e.db.Exec(`INSERT INTO agents (id, workspace_id, name, display_name, status, runtime, created_at, updated_at)
		VALUES (?, ?, 'cindy', 'Cindy', 'active', 'claude', ?, ?)`, chAgent, chWS, now, now); err != nil {
		e.t.Fatal(err)
	}
}

func (e *channelEnv) token(userID string) string {
	e.t.Helper()
	tok, err := e.signer.SignAccessToken(userID, "")
	if err != nil {
		e.t.Fatal(err)
	}
	return tok
}

func (e *channelEnv) serve(method, path, body string, headers map[string]string) (int, map[string]any, string, http.Header) {
	e.t.Helper()
	req, err := http.NewRequest(method, path, strings.NewReader(body))
	if err != nil {
		e.t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.mux.ServeHTTP(rec, req)
	raw := rec.Body.String()
	parsed := map[string]any{}
	if strings.Contains(rec.Header().Get("Content-Type"), "json") && len(raw) > 0 && raw[0] == '{' {
		_ = json.Unmarshal([]byte(raw), &parsed)
	}
	return rec.Code, parsed, raw, rec.Header()
}

func (e *channelEnv) auth(user, server string) map[string]string {
	h := map[string]string{"Authorization": "Bearer " + e.token(user)}
	if server != "" {
		h["X-Server-Id"] = server
	}
	return h
}

func (e *channelEnv) must(method, path, body string, headers map[string]string, status int) (map[string]any, string) {
	e.t.Helper()
	code, parsed, raw, _ := e.serve(method, path, body, headers)
	if code != status {
		e.t.Fatalf("%s %s: status %d, want %d, body %s", method, path, code, status, raw)
	}
	return parsed, raw
}

func (e *channelEnv) list(user, server, query string) []any {
	e.t.Helper()
	code, _, raw, _ := e.serve("GET", "/api/channels"+query, "", e.auth(user, server))
	if code != http.StatusOK {
		e.t.Fatalf("list %s: %d %s", query, code, raw)
	}
	var items []any
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		e.t.Fatalf("list json: %v %s", err, raw)
	}
	return items
}

func TestChannelAuthGates(t *testing.T) {
	e := newChannelEnv(t)
	code, body, _, _ := e.serve("GET", "/api/channels", "", nil)
	if code != http.StatusUnauthorized || body["code"] != "auth_required" {
		t.Fatalf("anon: %d %#v", code, body)
	}
	code, body, _, _ = e.serve("GET", "/api/channels", "", e.auth(chUnver, chWS))
	if code != http.StatusForbidden || body["error"] != "Email verification required" {
		t.Fatalf("unverified: %d %#v", code, body)
	}
	code, body, _, _ = e.serve("GET", "/api/channels", "", e.auth(chPending, chWS))
	if code != http.StatusForbidden || body["code"] != "PROFILE_SETUP_REQUIRED" {
		t.Fatalf("profile: %d %#v", code, body)
	}
	code, body, _, _ = e.serve("GET", "/api/channels", "", e.auth(chMember, ""))
	if code != http.StatusBadRequest || body["error"] != "Missing X-Server-Id header" {
		t.Fatalf("header: %d %#v", code, body)
	}
	// Owner of ws2 is not a member of a deleted/foreign check: a stranger id.
	code, body, _, _ = e.serve("GET", "/api/channels", "", e.auth(chMember, chWS2))
	if code != http.StatusForbidden || body["error"] != "Not a member of this server" {
		t.Fatalf("non-member: %d %#v", code, body)
	}
	if _, err := e.db.Exec(`UPDATE workspaces SET deleted_at = ? WHERE id = ?`, e.fixed.T.UnixMilli(), chWS2); err != nil {
		t.Fatal(err)
	}
	// chOwner is a member, but the workspace is deleted.
	if _, err := e.db.Exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, server_push_muted, joined_at)
		VALUES (?, ?, 'member', 0, ?)`, chWS2, chMember, e.fixed.T.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	code, body, _, _ = e.serve("GET", "/api/channels", "", e.auth(chMember, chWS2))
	if code != http.StatusForbidden || body["error"] != "Not a member of this server" {
		t.Fatalf("deleted workspace: %d %#v", code, body)
	}
}

func TestChannelListCreateAndDTO(t *testing.T) {
	e := newChannelEnv(t)
	items := e.list(chMember, chWS, "")
	if len(items) != 2 {
		t.Fatalf("lazy system list: %s", mustJSON(items))
	}
	byName := map[string]map[string]any{}
	for _, item := range items {
		row := item.(map[string]any)
		byName[row["name"].(string)] = row
	}
	all := byName["all"]
	ann := byName["announcement"]
	assertListRow(t, all, true)
	if all["systemKind"] != "all" || all["type"] != "channel" || all["joined"] != true {
		t.Fatalf("#all row: %s", mustJSON(all))
	}
	if all["activityMuted"] != false || all["muteFromSeq"] != nil || all["channelRole"] != nil {
		t.Fatalf("#all mute/role: %s", mustJSON(all))
	}
	if _, ok := all["lastMessageAt"]; !ok || all["lastMessageAt"] != nil || all["lastMessagePreview"] != nil {
		t.Fatalf("list last message must be present null: %s", mustJSON(all))
	}
	if all["collapseLongMessages"] != true || all["readState"].(map[string]any)["kind"] != "absent" {
		t.Fatalf("#all prefs/read: %s", mustJSON(all))
	}
	if ann["systemKind"] != "announcement" || ann["activityMuted"] != true || ann["muteFromSeq"] != float64(0) {
		t.Fatalf("#announcement mute: %s", mustJSON(ann))
	}
	guest := e.list(chGuest, chWS, "")
	if len(guest) != 0 {
		t.Fatalf("guest list: %s", mustJSON(guest))
	}
	e.must("GET", "/api/channels?archived=bogus", "", e.auth(chMember, chWS), http.StatusBadRequest)
	only := e.list(chMember, chWS, "?archived=only")
	if len(only) != 0 {
		t.Fatalf("archived only: %s", mustJSON(only))
	}

	e.fixed.Advance(time.Millisecond)
	created, _ := e.must("POST", "/api/channels", `{"name":" ops ","description":"hello","visibility":"public"}`, e.auth(chMember, chWS), http.StatusOK)
	if created["name"] != "ops" || created["joined"] != true || created["channelRole"] != "admin" || created["channelAdminBasis"] != "channel_role" {
		t.Fatalf("create projection: %s", mustJSON(created))
	}
	if created["description"] != "hello" || created["serverId"] != chWS || created["type"] != "channel" {
		t.Fatalf("create row: %s", mustJSON(created))
	}
	if _, ok := created["lastMessageAt"]; ok {
		t.Fatal("create must omit lastMessageAt")
	}
	if _, ok := created["collapseLongMessages"]; ok {
		t.Fatal("create must omit collapseLongMessages")
	}
	if created["activityMuteSupported"] != true || created["jointInvite"] != nil {
		t.Fatalf("create mute/joint: %s", mustJSON(created))
	}
	if invites, ok := created["jointInvites"].([]any); !ok || len(invites) != 0 {
		t.Fatalf("jointInvites: %#v", created["jointInvites"])
	}
	caps := created["channelCapabilities"].(map[string]any)
	for _, key := range []string{"editChannelMetadata", "archiveChannels", "addChannelMembers", "removeChannelMembers", "changeChannelMemberRoles", "manageGuestAccess"} {
		if caps[key] != true {
			t.Fatalf("member-creator missing %s: %s", key, mustJSON(caps))
		}
	}
	for _, key := range []string{"deleteChannels", "changeChannelVisibility", "federateChannels"} {
		if caps[key] != false {
			t.Fatalf("member-creator must not have %s", key)
		}
	}
	if created["readState"].(map[string]any)["kind"] != "absent" || created["maxReadSeq"] != float64(0) {
		t.Fatalf("create read state: %s", mustJSON(created))
	}
	if created["createdAt"] != "2026-10-08T12:00:00.001Z" {
		t.Fatalf("createdAt: %v", created["createdAt"])
	}
	channelID := created["id"].(string)

	detail, raw := e.must("GET", "/api/channels/"+channelID, "", e.auth(chOwner, chWS), http.StatusOK)
	if detail["joined"] != false || detail["channelRole"] != nil || detail["channelAdminBasis"] != "server_role" {
		t.Fatalf("owner detail: %s", mustJSON(detail))
	}
	if _, ok := detail["lastMessageAt"]; ok {
		t.Fatalf("detail must omit lastMessageAt: %s", raw)
	}
	if detail["collapseLongMessages"] != true || detail["channelCapabilities"].(map[string]any)["deleteChannels"] != true {
		t.Fatalf("owner caps: %s", mustJSON(detail))
	}

	e.must("POST", "/api/channels", `{"name":"ops"}`, e.auth(chOwner, chWS), http.StatusConflict)
	e.must("POST", "/api/channels", `{"name":"all"}`, e.auth(chOwner, chWS), http.StatusBadRequest)
	code, body, _, _ := e.serve("POST", "/api/channels", `{"name":"all"}`, e.auth(chOwner, chWS))
	if code != http.StatusBadRequest || body["code"] != "channel_name_reserved" {
		t.Fatalf("reserved: %d %#v", code, body)
	}
	e.must("POST", "/api/channels", `{"name":"1bad"}`, e.auth(chMember, chWS), http.StatusBadRequest)
	e.must("POST", "/api/channels", `{}`, e.auth(chMember, chWS), http.StatusBadRequest)
	e.must("POST", "/api/channels", `{"name":"nope"}`, e.auth(chGuest, chWS), http.StatusForbidden)
	e.must("POST", "/api/channels", `{"name":"jointone","visibility":"joint","targetServerSlug":"beta","invitedPeople":["ada"]}`, e.auth(chOwner, chWS), http.StatusNotImplemented)
	code, body, _, _ = e.serve("POST", "/api/channels", `{"name":"jointone","visibility":"joint","targetServerSlug":"beta","invitedPeople":["ada"]}`, e.auth(chOwner, chWS))
	if body["code"] != "joint_channels_not_implemented" {
		t.Fatalf("joint: %#v", body)
	}
	var jointRows int
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM channels WHERE name = 'jointone'`).Scan(&jointRows); err != nil || jointRows != 0 {
		t.Fatalf("joint must not insert, rows=%d err=%v", jointRows, err)
	}
	e.must("POST", "/api/channels", `{"name":"withagent","agentIds":["`+chAgent+`"],"userIds":["`+chMember2+`"]}`, e.auth(chMember, chWS), http.StatusOK)
	e.must("POST", "/api/channels", `{"name":"missingagent","agentIds":["`+chWS+`"]}`, e.auth(chMember, chWS), http.StatusBadRequest)

	// Cross-workspace id is not found.
	e.must("GET", "/api/channels/"+channelID, "", e.auth(chOwner, chWS2), http.StatusNotFound)
}

func assertListRow(t *testing.T, row map[string]any, joined bool) {
	t.Helper()
	if row["joined"] != joined {
		t.Fatalf("joined: %#v", row["joined"])
	}
	for _, key := range []string{
		"id", "serverId", "name", "description", "type", "systemKind", "guestVisible", "guestJoinable",
		"parentMessageId", "createdAt", "archivedAt", "archivedByUserId", "archivedByAgentId", "deletedAt",
		"channelCapabilities", "channelAuthorityRevision", "maxReadSeq", "readStateVersion", "readState",
		"activityMuteSupported", "jointServers",
	} {
		if _, ok := row[key]; !ok {
			t.Fatalf("list row missing %s: %s", key, mustJSON(row))
		}
	}
}

func TestChannelUpdateArchiveDeleteAndSystem(t *testing.T) {
	e := newChannelEnv(t)
	created, _ := e.must("POST", "/api/channels", `{"name":"ops","visibility":"public"}`, e.auth(chMember, chWS), http.StatusOK)
	id := created["id"].(string)
	// A server member who has not joined a public channel cannot add people.
	e.must("POST", "/api/channels/"+id+"/members", `{"userId":"`+chGuest+`"}`, e.auth(chMember2, chWS), http.StatusForbidden)
	allID := e.channelIDByName(chMember, "all")
	annID := e.channelIDByName(chMember, "announcement")

	e.must("PATCH", "/api/channels/"+allID, `{"visibility":"private"}`, e.auth(chOwner, chWS), http.StatusForbidden)
	code, body, _, _ := e.serve("PATCH", "/api/channels/"+allID, `{"visibility":"private"}`, e.auth(chOwner, chWS))
	if body["code"] != "all_channel_visibility_managed_separately" || !strings.Contains(body["error"].(string), "cannot be hidden or restored") {
		t.Fatalf("all visibility: %d %#v", code, body)
	}
	e.must("PATCH", "/api/channels/"+id, `{"visibility":"private"}`, e.auth(chOwner, chWS), http.StatusForbidden)
	code, body, _, _ = e.serve("PATCH", "/api/channels/"+id, `{"visibility":"private"}`, e.auth(chOwner, chWS))
	if body["code"] != "channel_membership_required" {
		t.Fatalf("visibility membership: %#v", body)
	}
	// Visibility is a server capability. The channel admin who created this
	// channel can rename it, and only a joined owner/admin can make it private.
	updated, _ := e.must("PATCH", "/api/channels/"+id, `{"name":"opsrenamed","description":""}`, e.auth(chMember, chWS), http.StatusOK)
	if updated["name"] != "opsrenamed" || updated["description"] != nil || updated["type"] != "channel" {
		t.Fatalf("patch: %s", mustJSON(updated))
	}
	if _, ok := updated["joined"]; ok {
		t.Fatal("patch response must be the raw row")
	}
	e.must("POST", "/api/channels/"+id+"/members", `{"userId":"`+chOwner+`"}`, e.auth(chMember, chWS), http.StatusOK)
	priv, _ := e.must("PATCH", "/api/channels/"+id, `{"visibility":"private"}`, e.auth(chOwner, chWS), http.StatusOK)
	if priv["type"] != "private" || priv["guestVisible"] != false {
		t.Fatalf("private: %s", mustJSON(priv))
	}
	e.must("DELETE", "/api/channels/"+id+"/members/user/"+chOwner, "", e.auth(chMember, chWS), http.StatusOK)
	e.must("GET", "/api/channels/"+id, "", e.auth(chOwner, chWS), http.StatusNotFound)
	e.must("POST", "/api/channels/"+id+"/join", "", e.auth(chMember2, chWS), http.StatusForbidden)

	e.must("POST", "/api/channels/"+id+"/members", `{"userId":"`+chOwner+`"}`, e.auth(chMember, chWS), http.StatusOK)
	e.must("PATCH", "/api/channels/"+id, `{"visibility":"public"}`, e.auth(chOwner, chWS), http.StatusOK)
	e.must("GET", "/api/channels/"+id, "", e.auth(chMember2, chWS), http.StatusOK)
	e.must("POST", "/api/channels/"+id+"/join", "", e.auth(chMember2, chWS), http.StatusOK)
	e.must("POST", "/api/channels/"+id+"/join", "", e.auth(chMember2, chWS), http.StatusOK)
	e.must("POST", "/api/channels/"+id+"/join", "", e.auth(chGuest, chWS), http.StatusForbidden)

	e.must("POST", "/api/channels/"+allID+"/archive", "", e.auth(chOwner, chWS), http.StatusBadRequest)
	e.must("DELETE", "/api/channels/"+allID, "", e.auth(chOwner, chWS), http.StatusForbidden)
	e.must("DELETE", "/api/channels/"+annID, "", e.auth(chOwner, chWS), http.StatusForbidden)
	e.must("POST", "/api/channels/"+allID+"/leave", "", e.auth(chMember, chWS), http.StatusForbidden)
	code, body, _, _ = e.serve("POST", "/api/channels/"+annID+"/leave", "", e.auth(chMember, chWS))
	if code != http.StatusForbidden || body["error"] != "Cannot remove members from, or leave, the #announcement channel" {
		t.Fatalf("leave announcement: %d %#v", code, body)
	}
	code, body, _, _ = e.serve("POST", "/api/channels/"+allID+"/leave", "", e.auth(chMember, chWS))
	if code != http.StatusForbidden || body["error"] != "Cannot leave or remove from the #all channel" {
		t.Fatalf("leave #all: %d %#v", code, body)
	}
	e.must("POST", "/api/channels/"+allID+"/join", "", e.auth(chMember, chWS), http.StatusOK)

	archived, _ := e.must("POST", "/api/channels/"+id+"/archive", "", e.auth(chMember, chWS), http.StatusOK)
	if archived["archivedByUserId"] != chMember || archived["archivedAt"] == nil {
		t.Fatalf("archive: %s", mustJSON(archived))
	}
	again, _ := e.must("POST", "/api/channels/"+id+"/archive", "", e.auth(chOwner, chWS), http.StatusOK)
	if again["archivedByUserId"] != chMember {
		t.Fatal("repeat archive must keep the first actor")
	}
	e.must("POST", "/api/channels/"+id+"/join", "", e.auth(chMember2, chWS), http.StatusConflict)
	code, body, _, _ = e.serve("POST", "/api/channels", `{"name":"opsrenamed"}`, e.auth(chOwner, chWS))
	if code != http.StatusConflict || body["code"] != "archived_name_collision" || body["canUnarchiveArchivedChannel"] != true || body["archivedChannelId"] != id {
		t.Fatalf("archived collision: %d %#v", code, body)
	}
	code, body, _, _ = e.serve("POST", "/api/channels", `{"name":"opsrenamed"}`, e.auth(chMember2, chWS))
	if code != http.StatusConflict || body["canUnarchiveArchivedChannel"] != false {
		t.Fatalf("member2 cannot unarchive: %#v", body)
	}
	e.must("POST", "/api/channels/"+id+"/unarchive", "", e.auth(chMember2, chWS), http.StatusForbidden)
	e.must("POST", "/api/channels/"+id+"/unarchive", "", e.auth(chOwner, chWS), http.StatusOK)
	e.must("DELETE", "/api/channels/"+id, "", e.auth(chMember, chWS), http.StatusForbidden)
	e.must("DELETE", "/api/channels/"+id, "", e.auth(chOwner, chWS), http.StatusOK)
	e.must("GET", "/api/channels/"+id, "", e.auth(chOwner, chWS), http.StatusNotFound)

	e.must("POST", "/api/channels/system/all/hide", "", e.auth(chMember, chWS), http.StatusForbidden)
	e.must("POST", "/api/channels/system/all/hide", "", e.auth(chOwner, chWS), http.StatusOK)
	for _, item := range e.list(chOwner, chWS, "") {
		if item.(map[string]any)["name"] == "all" {
			t.Fatal("hidden #all still listed")
		}
	}
	e.must("POST", "/api/channels/system/all/hide", "", e.auth(chOwner, chWS), http.StatusOK)
	e.must("POST", "/api/channels/system/all/restore", "", e.auth(chOwner, chWS), http.StatusOK)
	found := false
	for _, item := range e.list(chOwner, chWS, "") {
		if item.(map[string]any)["name"] == "all" {
			found = true
		}
	}
	if !found {
		t.Fatal("restored #all missing from the list")
	}
}

func (e *channelEnv) channelIDByName(user, name string) string {
	e.t.Helper()
	for _, item := range e.list(user, chWS, "") {
		row := item.(map[string]any)
		if row["name"] == name {
			return row["id"].(string)
		}
	}
	e.t.Fatalf("channel %s not listed", name)
	return ""
}

func TestChannelMembershipRosterAndRoles(t *testing.T) {
	e := newChannelEnv(t)
	created, _ := e.must("POST", "/api/channels", `{"name":"ops","visibility":"private"}`, e.auth(chMember, chWS), http.StatusOK)
	id := created["id"].(string)
	// An unjoined member cannot see a private channel, so the add is a 404.
	e.must("POST", "/api/channels/"+id+"/members", `{"userId":"`+chGuest+`"}`, e.auth(chMember2, chWS), http.StatusNotFound)
	// Owner manages a private channel they have not joined.
	e.must("POST", "/api/channels/"+id+"/members", `{"userId":"`+chMember2+`"}`, e.auth(chOwner, chWS), http.StatusOK)
	e.must("POST", "/api/channels/"+id+"/members", `{"agentId":"`+chAgent+`"}`, e.auth(chOwner, chWS), http.StatusOK)
	e.must("POST", "/api/channels/"+id+"/members", `{"agentId":"`+chWS+`"}`, e.auth(chOwner, chWS), http.StatusBadRequest)
	e.must("POST", "/api/channels/"+id+"/members", `{}`, e.auth(chOwner, chWS), http.StatusBadRequest)

	batch, raw := e.must("POST", "/api/channels/"+id+"/members/batch",
		`{"userIds":["`+chGuest+`","`+chMember2+`"],"agentIds":["`+chAgent+`"]}`, e.auth(chMember, chWS), http.StatusOK)
	added := batch["added"].(map[string]any)
	already := batch["alreadyMembers"].(map[string]any)
	if len(added["userIds"].([]any)) != 1 || added["userIds"].([]any)[0] != chGuest {
		t.Fatalf("batch added: %s", raw)
	}
	if len(already["userIds"].([]any)) != 1 || already["userIds"].([]any)[0] != chMember2 {
		t.Fatalf("batch already users: %s", raw)
	}
	if len(already["agentIds"].([]any)) != 1 || len(added["agentIds"].([]any)) != 0 {
		t.Fatalf("batch agents: %s", raw)
	}
	e.must("POST", "/api/channels/"+id+"/members/batch", `{"userIds":["nope"],"agentIds":[]}`, e.auth(chMember, chWS), http.StatusBadRequest)
	e.must("POST", "/api/channels/"+id+"/members/batch", `{"userIds":[]}`, e.auth(chMember, chWS), http.StatusBadRequest)
	code, body, _, _ := e.serve("POST", "/api/channels/"+id+"/members/batch", `{"userIds":[],"agentIds":[]}`, e.auth(chMember, chWS))
	if code != http.StatusBadRequest || body["code"] != "empty_member_batch" {
		t.Fatalf("empty batch: %d %#v", code, body)
	}
	// Private reads require a membership row. Add the owner before roster checks.
	e.must("POST", "/api/channels/"+id+"/members", `{"userId":"`+chOwner+`"}`, e.auth(chMember, chWS), http.StatusOK)

	membersRaw := e.mustRaw("GET", "/api/channels/"+id+"/members", "", e.auth(chOwner, chWS), http.StatusOK)
	var members map[string]any
	if err := json.Unmarshal([]byte(membersRaw), &members); err != nil {
		t.Fatal(err)
	}
	if _, ok := members["externalMembers"].([]any); !ok {
		t.Fatalf("externalMembers: %#v", members["externalMembers"])
	}
	humans := members["humans"].([]any)
	var memberRow map[string]any
	for _, item := range humans {
		row := item.(map[string]any)
		if row["id"] == chMember {
			memberRow = row
		}
		if row["id"] == chOwner && row["canChangeChannelRole"] != false {
			t.Fatal("owner row must not be role-changeable")
		}
	}
	sum := sha256.Sum256([]byte("member@example.test"))
	if memberRow["gravatarHash"] != hex.EncodeToString(sum[:]) || memberRow["role"] != "member" || memberRow["channelRole"] != "admin" {
		t.Fatalf("member roster: %s", mustJSON(memberRow))
	}
	if memberRow["effectiveChannelRole"] != "admin" || memberRow["channelAdminBasis"] != "channel_role" {
		t.Fatalf("member basis: %s", mustJSON(memberRow))
	}
	agentsRaw := e.mustRaw("GET", "/api/channels/"+id+"/agents", "", e.auth(chOwner, chWS), http.StatusOK)
	var agents []map[string]any
	if err := json.Unmarshal([]byte(agentsRaw), &agents); err != nil {
		t.Fatal(err)
	}
	if len(agents) != 1 || agents[0]["channelRole"] != "member" || agents[0]["serverRole"] != nil || agents[0]["name"] != "cindy" {
		t.Fatalf("explicit agents: %s", agentsRaw)
	}
	allID := e.channelIDByName(chOwner, "all")
	derivedRaw := e.mustRaw("GET", "/api/channels/"+allID+"/agents", "", e.auth(chOwner, chWS), http.StatusOK)
	if strings.Contains(derivedRaw, "channelRole") || strings.Contains(derivedRaw, "serverRole") {
		t.Fatalf("derived agents must omit role keys: %s", derivedRaw)
	}
	if _, err := e.db.Exec(`UPDATE workspaces SET hide_humans_from_members = 1 WHERE id = ?`, chWS); err != nil {
		t.Fatal(err)
	}
	hiddenRaw := e.mustRaw("GET", "/api/channels/"+allID+"/members", "", e.auth(chMember, chWS), http.StatusOK)
	var hidden map[string]any
	if err := json.Unmarshal([]byte(hiddenRaw), &hidden); err != nil {
		t.Fatal(err)
	}
	seen := hidden["humans"].([]any)
	if len(seen) != 1 || seen[0].(map[string]any)["id"] != chMember {
		t.Fatalf("hidden directory: %s", hiddenRaw)
	}

	// A joined member can see the private channel but cannot remove agents.
	e.must("DELETE", "/api/channels/"+id+"/members/agent/"+chAgent, "", e.auth(chMember2, chWS), http.StatusForbidden)
	role, raw := e.must("PATCH", "/api/channels/"+id+"/members/user/"+chMember2+"/role", `{"role":"admin"}`, e.auth(chMember, chWS), http.StatusOK)
	if role["changed"] != true || role["channelRole"] != "admin" || role["authorityRevision"] != float64(2) || role["eventId"] == nil {
		t.Fatalf("role: %s", raw)
	}
	var status string
	if err := e.db.QueryRow(`SELECT delivery_status FROM channel_membership_role_events WHERE id = ?`, role["eventId"]).Scan(&status); err != nil || status != "pending" {
		t.Fatalf("event status: %q %v", status, err)
	}
	e.must("PATCH", "/api/channels/"+id+"/members/user/"+chMember+"/role", `{"role":"member"}`, e.auth(chMember, chWS), http.StatusConflict)
	code, body, _, _ = e.serve("PATCH", "/api/channels/"+id+"/members/user/"+chOwner+"/role", `{"role":"member"}`, e.auth(chMember, chWS))
	if code != http.StatusForbidden || body["code"] != "protected_server_role" {
		t.Fatalf("protected: %d %#v", code, body)
	}
	code, body, _, _ = e.serve("PATCH", "/api/channels/"+id+"/members/user/"+chGuest+"/role", `{"role":"admin"}`, e.auth(chMember, chWS))
	if code != http.StatusConflict || body["code"] != "guest_channel_admin_forbidden" {
		t.Fatalf("guest admin: %d %#v", code, body)
	}
	e.must("PATCH", "/api/channels/"+id+"/members/nope/"+chMember2+"/role", `{"role":"member"}`, e.auth(chMember, chWS), http.StatusBadRequest)
	// Guest reads stay closed while the guest gate is off, so removal is a 404.
	e.must("DELETE", "/api/channels/"+id+"/members/agent/"+chAgent, "", e.auth(chGuest, chWS), http.StatusNotFound)
	e.must("DELETE", "/api/channels/"+id+"/members/agent/"+chAgent, "", e.auth(chMember, chWS), http.StatusOK)
	e.must("DELETE", "/api/channels/"+id+"/members/user/"+chGuest, "", e.auth(chOwner, chWS), http.StatusOK)
	// Last private-channel departure soft-deletes. Remove everyone else first.
	e.must("DELETE", "/api/channels/"+id+"/members/user/"+chMember2, "", e.auth(chOwner, chWS), http.StatusOK)
	e.must("DELETE", "/api/channels/"+id+"/members/user/"+chOwner, "", e.auth(chMember, chWS), http.StatusOK)
	e.must("POST", "/api/channels/"+id+"/leave", "", e.auth(chMember, chWS), http.StatusOK)
	e.must("GET", "/api/channels/"+id, "", e.auth(chMember, chWS), http.StatusNotFound)
	var deleted sql.NullInt64
	if err := e.db.QueryRow(`SELECT deleted_at FROM channels WHERE id = ?`, id).Scan(&deleted); err != nil || !deleted.Valid {
		t.Fatalf("soft delete: %v %v", deleted, err)
	}
}

func TestChannelDeferredAndMethodFallback(t *testing.T) {
	e := newChannelEnv(t)
	code, body, _, hdr := e.serve("PUT", "/api/channels", "", e.auth(chMember, chWS))
	if code != http.StatusMethodNotAllowed || body["error"] != "Method not allowed" || !strings.Contains(hdr.Get("Allow"), "GET") || !strings.Contains(hdr.Get("Allow"), "POST") {
		t.Fatalf("405: %d %#v allow=%q", code, body, hdr.Get("Allow"))
	}
	code, body, _, _ = e.serve("PUT", "/api/channels", "", nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("405 before auth: %d %#v", code, body)
	}
	for _, path := range []string{
		"/api/channels/dm",
		"/api/channels/unread",
		"/api/channels/inbox",
		"/api/channels/activity/snapshot",
		"/api/channels/threads/followed",
		"/api/channels/saved",
		"/api/channels/joint-invites",
	} {
		code, body, _, _ = e.serve("GET", path, "", e.auth(chMember, chWS))
		if code != http.StatusNotImplemented || body["code"] != "feature_not_implemented" {
			t.Fatalf("%s: %d %#v", path, code, body)
		}
	}
	created, _ := e.must("POST", "/api/channels", `{"name":"ops"}`, e.auth(chMember, chWS), http.StatusOK)
	id := created["id"].(string)
	for _, path := range []string{
		"/api/channels/" + id + "/read",
		"/api/channels/" + id + "/files",
		"/api/channels/" + id + "/threads",
		"/api/channels/" + id + "/notification-settings",
		"/api/channels/" + id + "/disconnect",
	} {
		code, body, _, _ = e.serve("POST", path, `{}`, e.auth(chMember, chWS))
		if code != http.StatusNotImplemented || body["code"] != "feature_not_implemented" {
			t.Fatalf("%s: %d %#v", path, code, body)
		}
	}
	code, body, _, hdr = e.serve("PUT", "/api/channels/"+id+"/archive", "", e.auth(chMember, chWS))
	if code != http.StatusMethodNotAllowed || hdr.Get("Allow") != "POST" {
		t.Fatalf("archive 405: %d %#v allow=%q", code, body, hdr.Get("Allow"))
	}
}

func (e *channelEnv) mustRaw(method, path, body string, headers map[string]string, status int) string {
	e.t.Helper()
	code, _, raw, _ := e.serve(method, path, body, headers)
	if code != status {
		e.t.Fatalf("%s %s: status %d, want %d, body %s", method, path, code, status, raw)
	}
	return raw
}

func mustJSON(v any) string {
	buf, _ := json.Marshal(v)
	return string(buf)
}
