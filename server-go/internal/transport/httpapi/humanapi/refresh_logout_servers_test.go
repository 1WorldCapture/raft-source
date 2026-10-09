package humanapi_test

import (
	"encoding/json"
	"net/http"
	"raft.local/server-go/tests/testkit"
	"strings"
	"sync"
	"testing"
)

func TestRefreshContract(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, _, refresh := env.RegisterOK("refresh@example.com")

	missing := env.Do("POST", "/api/auth/refresh", map[string]any{}, "")
	if missing.Status != http.StatusBadRequest || missing.Body["error"] != "Refresh token is required" {
		t.Fatalf("missing token: %d %s", missing.Status, missing.Raw)
	}
	invalid := env.Do("POST", "/api/auth/refresh", map[string]any{"refreshToken": "ab"}, "")
	if invalid.Status != http.StatusUnauthorized || invalid.Body["error"] != "Invalid or expired refresh token" {
		t.Fatalf("invalid token: %d %s", invalid.Status, invalid.Raw)
	}

	first := env.Do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, "")
	if first.Status != http.StatusOK || first.Body["accessToken"] == nil || first.Body["refreshToken"] == nil {
		t.Fatalf("refresh failed: %d %s", first.Status, first.Raw)
	}
	access2 := first.Body["accessToken"].(string)
	refresh2 := first.Body["refreshToken"].(string)
	if strings.Count(access2, ".") != 2 || refresh2 == refresh {
		t.Error("rotation did not issue fresh tokens")
	}

	// The new access token authenticates.
	if me := env.Do("GET", "/api/auth/me", nil, access2); me.Status != http.StatusOK {
		t.Fatalf("me with refreshed access: %d", me.Status)
	}

	// Replay of the ORIGINAL token inside the grace window returns the same successor.
	replay := env.Do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, "")
	if replay.Status != http.StatusOK {
		t.Fatalf("in-grace replay rejected: %d %s", replay.Status, replay.Raw)
	}
	if replay.Body["refreshToken"].(string) != refresh2 {
		t.Error("replay returned a different successor")
	}

	// Binding guard: installation header without a valid attempt id.
	bound := env.Do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh2}, "")
	_ = bound
	req := env.DoRaw("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh2},
		map[string]string{"X-Slock-Auth-Installation-Id": "ari_0123456789abcdef0123456789abcdef"})
	if req.Status != http.StatusBadRequest || req.Body["error"] != "Invalid refresh replay binding" {
		t.Fatalf("binding guard: %d %s", req.Status, req.Raw)
	}
}

func TestRefreshWithDurableBinding(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, _, refresh := env.RegisterOK("bound@example.com")
	headers := map[string]string{
		"X-Slock-Auth-Refresh-Attempt-Id": "arf_0123456789abcdef",
		"X-Slock-Auth-Installation-Id":    "ari_0123456789abcdef0123456789abcdef",
	}
	first := env.DoRaw("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, headers)
	if first.Status != http.StatusOK {
		t.Fatalf("bound refresh failed: %d %s", first.Status, first.Raw)
	}
	// Same binding + same old token replays the identical successor.
	replay := env.DoRaw("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, headers)
	if replay.Status != http.StatusOK {
		t.Fatalf("bound replay failed: %d %s", replay.Status, replay.Raw)
	}
	if replay.Body["refreshToken"] != first.Body["refreshToken"] {
		t.Error("bound replay diverged from the original successor")
	}
	// A different attempt id on the same predecessor is rejected+revoking.
	other := env.DoRaw("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, map[string]string{
		"X-Slock-Auth-Refresh-Attempt-Id": "arf_fedcba9876543210",
		"X-Slock-Auth-Installation-Id":    "ari_0123456789abcdef0123456789abcdef",
	})
	if other.Status != http.StatusUnauthorized {
		t.Fatalf("foreign binding accepted: %d", other.Status)
	}
}

func TestConcurrentRefreshAcrossTabs(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, _, refresh := env.RegisterOK("tabs@example.com")

	const tabs = 6
	results := make([]string, tabs)
	var wg sync.WaitGroup
	for i := 0; i < tabs; i++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			res := env.Do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, "")
			if res.Status == http.StatusOK {
				results[slot] = res.Body["refreshToken"].(string)
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
	env := testkit.NewTestEnv(t)
	_, access, refresh := env.FullAccount("logout@example.com", "logoutter")

	res := env.Do("POST", "/api/auth/logout", map[string]any{"refreshToken": refresh}, access)
	if res.Status != http.StatusOK || res.Body["ok"] != true {
		t.Fatalf("logout failed: %d %s", res.Status, res.Raw)
	}
	// Session is gone server-side: refresh rejected, access family revoked.
	if r := env.Do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, ""); r.Status != http.StatusUnauthorized {
		t.Fatalf("refresh survived logout: %d", r.Status)
	}
	if m := env.Do("GET", "/api/auth/me", nil, access); m.Status != http.StatusUnauthorized {
		t.Fatalf("access survived logout: %d", m.Status)
	}
	// Logout is idempotent and safe without a body.
	again := env.Do("POST", "/api/auth/logout", map[string]any{}, "")
	if again.Status != http.StatusOK {
		t.Fatalf("second logout: %d", again.Status)
	}
}

func TestServersMembershipQuery(t *testing.T) {
	env := testkit.NewTestEnv(t)

	// Unverified: 403 with the legacy body.
	_, access, _ := env.RegisterOK("servers@example.com")
	res := env.Do("GET", "/api/servers", nil, access)
	if res.Status != http.StatusForbidden || res.Body["error"] != "Email verification required" {
		t.Fatalf("unverified servers: %d %s", res.Status, res.Raw)
	}

	// Verified but profile incomplete: PROFILE_SETUP_REQUIRED.
	env.VerifyEmailOf(env.LatestOutboxLink("verify"))
	res = env.Do("GET", "/api/servers", nil, access)
	if res.Status != http.StatusForbidden || res.Body["code"] != "PROFILE_SETUP_REQUIRED" {
		t.Fatalf("incomplete profile servers: %d %s", res.Status, res.Raw)
	}

	// Complete profile: the true empty membership list is [].
	res = env.Do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "serverless", "displayName": "S"}, access)
	if res.Status != http.StatusOK {
		t.Fatalf("complete failed: %d", res.Status)
	}
	res = env.Do("GET", "/api/servers", nil, access)
	if res.Status != http.StatusOK {
		t.Fatalf("servers failed: %d %s", res.Status, res.Raw)
	}
	raw := strings.TrimSpace(string(res.Raw))
	if raw != "[]" {
		t.Fatalf("empty membership must serialize as [], got %s", raw)
	}

	// Seed a REAL membership row for this user; the query must find it.
	userID := env.Do("GET", "/api/auth/me", nil, access).Body["id"].(string)
	// Workspace row must exist before the membership (foreign keys on).
	if err := env.InsertWorkspace("ws-test-1", "The Lab", "the-lab", userID); err != nil {
		t.Fatal(err)
	}
	if err := env.InsertMembership(map[string]any{
		"workspace_id": "ws-test-1", "user_id": userID, "role": "owner",
		"server_push_muted": 0, "joined_at": 0,
	}); err != nil {
		t.Fatal(err)
	}
	res = env.Do("GET", "/api/servers", nil, access)
	if res.Status != http.StatusOK {
		t.Fatalf("servers with membership failed: %d", res.Status)
	}
	var arr []map[string]any
	if err := json.Unmarshal(res.Raw, &arr); err != nil || len(arr) != 1 {
		t.Fatalf("membership row missing: %s", res.Raw)
	}
	row := arr[0]
	if row["id"] != "ws-test-1" || row["slug"] != "the-lab" || row["role"] != "owner" ||
		row["messageHistoryDays"] != float64(30) || row["historyCutoff"] == nil {
		t.Errorf("membership projection wrong: %s", res.Raw)
	}

	// Another user must NOT see the first user's workspace.
	_, otherAccess, _ := env.FullAccount("isolation@example.com", "isolated")
	res = env.Do("GET", "/api/servers", nil, otherAccess)
	if strings.TrimSpace(string(res.Raw)) != "[]" {
		t.Fatalf("workspace isolation broken: %s", res.Raw)
	}
}

func TestWorkspaceCreateAfterVerifiedAccountFlow(t *testing.T) {
	env := testkit.NewTestEnv(t)
	ownerID, access, _ := env.FullAccount("create@example.com", "creator")
	res := env.Do("POST", "/api/servers", map[string]any{"name": "New Place"}, access)
	if res.Status != http.StatusBadRequest || res.Body["error"] != "Name and slug are required" {
		t.Fatalf("create must still validate required slug: %d %s", res.Status, res.Raw)
	}
	res = env.Do("POST", "/api/servers", map[string]any{"name": "New Place", "slug": "new-place"}, access)
	if res.Status != http.StatusOK || res.Body["ownerId"] != ownerID || res.Body["id"] == nil {
		t.Fatalf("verified account should create a real owned workspace: %d %s", res.Status, res.Raw)
	}
	createdID := res.Body["id"]
	list := env.Do("GET", "/api/servers", nil, access)
	var members []map[string]any
	if err := json.Unmarshal(list.Raw, &members); err != nil || list.Status != http.StatusOK || len(members) != 1 {
		t.Fatalf("created membership must be readable: %d %s", list.Status, list.Raw)
	}
	if members[0]["id"] != createdID || members[0]["role"] != "owner" {
		t.Fatalf("created membership must retain the actual owner: %s", list.Raw)
	}
}
