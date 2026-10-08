package legacyweb_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestRefreshContract(t *testing.T) {
	env := newTestEnv(t)
	_, _, refresh := env.registerOK("refresh@example.com")

	missing := env.do("POST", "/api/auth/refresh", map[string]any{}, "")
	if missing.status != http.StatusBadRequest || missing.body["error"] != "Refresh token is required" {
		t.Fatalf("missing token: %d %s", missing.status, missing.raw)
	}
	invalid := env.do("POST", "/api/auth/refresh", map[string]any{"refreshToken": "ab"}, "")
	if invalid.status != http.StatusUnauthorized || invalid.body["error"] != "Invalid or expired refresh token" {
		t.Fatalf("invalid token: %d %s", invalid.status, invalid.raw)
	}

	first := env.do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, "")
	if first.status != http.StatusOK || first.body["accessToken"] == nil || first.body["refreshToken"] == nil {
		t.Fatalf("refresh failed: %d %s", first.status, first.raw)
	}
	access2 := first.body["accessToken"].(string)
	refresh2 := first.body["refreshToken"].(string)
	if strings.Count(access2, ".") != 2 || refresh2 == refresh {
		t.Error("rotation did not issue fresh tokens")
	}

	// The new access token authenticates.
	if me := env.do("GET", "/api/auth/me", nil, access2); me.status != http.StatusOK {
		t.Fatalf("me with refreshed access: %d", me.status)
	}

	// Replay of the ORIGINAL token inside the grace window returns the same successor.
	replay := env.do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, "")
	if replay.status != http.StatusOK {
		t.Fatalf("in-grace replay rejected: %d %s", replay.status, replay.raw)
	}
	if replay.body["refreshToken"].(string) != refresh2 {
		t.Error("replay returned a different successor")
	}

	// Binding guard: installation header without a valid attempt id.
	bound := env.do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh2}, "")
	_ = bound
	req := env.doRaw("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh2},
		map[string]string{"X-Slock-Auth-Installation-Id": "ari_0123456789abcdef0123456789abcdef"})
	if req.status != http.StatusBadRequest || req.body["error"] != "Invalid refresh replay binding" {
		t.Fatalf("binding guard: %d %s", req.status, req.raw)
	}
}

func TestRefreshWithDurableBinding(t *testing.T) {
	env := newTestEnv(t)
	_, _, refresh := env.registerOK("bound@example.com")
	headers := map[string]string{
		"X-Slock-Auth-Refresh-Attempt-Id": "arf_0123456789abcdef",
		"X-Slock-Auth-Installation-Id":    "ari_0123456789abcdef0123456789abcdef",
	}
	first := env.doRaw("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, headers)
	if first.status != http.StatusOK {
		t.Fatalf("bound refresh failed: %d %s", first.status, first.raw)
	}
	// Same binding + same old token replays the identical successor.
	replay := env.doRaw("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, headers)
	if replay.status != http.StatusOK {
		t.Fatalf("bound replay failed: %d %s", replay.status, replay.raw)
	}
	if replay.body["refreshToken"] != first.body["refreshToken"] {
		t.Error("bound replay diverged from the original successor")
	}
	// A different attempt id on the same predecessor is rejected+revoking.
	other := env.doRaw("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, map[string]string{
		"X-Slock-Auth-Refresh-Attempt-Id": "arf_fedcba9876543210",
		"X-Slock-Auth-Installation-Id":    "ari_0123456789abcdef0123456789abcdef",
	})
	if other.status != http.StatusUnauthorized {
		t.Fatalf("foreign binding accepted: %d", other.status)
	}
}

func TestConcurrentRefreshAcrossTabs(t *testing.T) {
	env := newTestEnv(t)
	_, _, refresh := env.registerOK("tabs@example.com")

	const tabs = 6
	results := make([]string, tabs)
	var wg sync.WaitGroup
	for i := 0; i < tabs; i++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			res := env.do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, "")
			if res.status == http.StatusOK {
				results[slot] = res.body["refreshToken"].(string)
			}
		}(i)
	}
	wg.Wait()
	distinct := map[string]bool{}
	for _, r := range results {
		if r != "" {
			distinct[r] = true
		}
	}
	if len(distinct) != 1 {
		t.Fatalf("concurrent tabs saw %d distinct successors: %v", len(distinct), distinct)
	}
}

func TestLogoutContract(t *testing.T) {
	env := newTestEnv(t)
	_, access, refresh := env.fullAccount("logout@example.com", "logoutter")

	res := env.do("POST", "/api/auth/logout", map[string]any{"refreshToken": refresh}, access)
	if res.status != http.StatusOK || res.body["ok"] != true {
		t.Fatalf("logout failed: %d %s", res.status, res.raw)
	}
	// Session is gone server-side: refresh rejected, access family revoked.
	if r := env.do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, ""); r.status != http.StatusUnauthorized {
		t.Fatalf("refresh survived logout: %d", r.status)
	}
	if m := env.do("GET", "/api/auth/me", nil, access); m.status != http.StatusUnauthorized {
		t.Fatalf("access survived logout: %d", m.status)
	}
	// Logout is idempotent and safe without a body.
	again := env.do("POST", "/api/auth/logout", map[string]any{}, "")
	if again.status != http.StatusOK {
		t.Fatalf("second logout: %d", again.status)
	}
}

func TestServersMembershipQuery(t *testing.T) {
	env := newTestEnv(t)

	// Unverified: 403 with the legacy body.
	_, access, _ := env.registerOK("servers@example.com")
	res := env.do("GET", "/api/servers", nil, access)
	if res.status != http.StatusForbidden || res.body["error"] != "Email verification required" {
		t.Fatalf("unverified servers: %d %s", res.status, res.raw)
	}

	// Verified but profile incomplete: PROFILE_SETUP_REQUIRED.
	env.verifyEmailOf(env.latestOutboxLink("verify"))
	res = env.do("GET", "/api/servers", nil, access)
	if res.status != http.StatusForbidden || res.body["code"] != "PROFILE_SETUP_REQUIRED" {
		t.Fatalf("incomplete profile servers: %d %s", res.status, res.raw)
	}

	// Complete profile: the true empty membership list is [].
	res = env.do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "serverless", "displayName": "S"}, access)
	if res.status != http.StatusOK {
		t.Fatalf("complete failed: %d", res.status)
	}
	res = env.do("GET", "/api/servers", nil, access)
	if res.status != http.StatusOK {
		t.Fatalf("servers failed: %d %s", res.status, res.raw)
	}
	raw := strings.TrimSpace(string(res.raw))
	if raw != "[]" {
		t.Fatalf("empty membership must serialize as [], got %s", raw)
	}

	// Seed a REAL membership row for this user; the query must find it.
	userID := env.do("GET", "/api/auth/me", nil, access).body["id"].(string)
	// Workspace row must exist before the membership (foreign keys on).
	if err := env.insertWorkspace("ws-test-1", "The Lab", "the-lab", userID); err != nil {
		t.Fatal(err)
	}
	if err := env.insertMembership(map[string]any{
		"workspace_id": "ws-test-1", "user_id": userID, "role": "owner",
		"server_push_muted": 0, "joined_at": 0,
	}); err != nil {
		t.Fatal(err)
	}
	res = env.do("GET", "/api/servers", nil, access)
	if res.status != http.StatusOK {
		t.Fatalf("servers with membership failed: %d", res.status)
	}
	var arr []map[string]any
	if err := json.Unmarshal(res.raw, &arr); err != nil || len(arr) != 1 {
		t.Fatalf("membership row missing: %s", res.raw)
	}
	row := arr[0]
	if row["id"] != "ws-test-1" || row["slug"] != "the-lab" || row["role"] != "owner" ||
		row["messageHistoryDays"] != float64(30) || row["historyCutoff"] == nil {
		t.Errorf("membership projection wrong: %s", res.raw)
	}

	// Another user must NOT see the first user's workspace.
	_, otherAccess, _ := env.fullAccount("isolation@example.com", "isolated")
	res = env.do("GET", "/api/servers", nil, otherAccess)
	if strings.TrimSpace(string(res.raw)) != "[]" {
		t.Fatalf("workspace isolation broken: %s", res.raw)
	}
}

func TestWorkspaceCreateUnsupported(t *testing.T) {
	env := newTestEnv(t)
	_, access, _ := env.fullAccount("create@example.com", "creator")
	res := env.do("POST", "/api/servers", map[string]any{"name": "New Place"}, access)
	if res.status != http.StatusNotImplemented || res.body["code"] != "feature_not_implemented" {
		t.Fatalf("workspace create must be explicitly unsupported: %d %s", res.status, res.raw)
	}
}
