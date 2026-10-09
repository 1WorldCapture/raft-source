package humanapi_test

import (
	"bytes"
	"encoding/base64"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"raft.local/server-go/tests/testkit"
	"strings"
	"testing"
)

func TestProvidersContract(t *testing.T) {
	env := testkit.NewTestEnv(t)
	res := env.Do("GET", "/api/auth/providers", nil, "")
	if res.Status != http.StatusOK {
		t.Fatalf("providers: %d", res.Status)
	}
	if raw := strings.TrimSpace(string(res.Raw)); raw != `{"providers":[]}` {
		t.Fatalf("providers body: %s", raw)
	}
	bad := env.Do("GET", "/api/auth/providers?platform=tv", nil, "")
	if bad.Status != http.StatusBadRequest || bad.Body["code"] != "platform_invalid" {
		t.Fatalf("platform validation: %d %s", bad.Status, bad.Raw)
	}
}

func TestRoutePolicy(t *testing.T) {
	env := testkit.NewTestEnv(t)
	cases := []struct {
		method string
		path   string
		status int
	}{
		{"GET", "/api/definitely-not-a-route", http.StatusNotFound},
		{"DELETE", "/api/auth/me", http.StatusMethodNotAllowed},
		// M2 server paths run the account gates before method policy.
		{"PUT", "/api/servers", http.StatusUnauthorized},
		// M4 enables Socket.IO with websocket-only transport; polling is an
		// explicit protocol rejection, not an unimplemented feature.
		{"GET", "/socket.io/?EIO=4&transport=polling", http.StatusBadRequest},
		{"POST", "/internal/agent-api/anything", http.StatusUnauthorized},
		{"GET", "/daemon/v1/nothing", http.StatusNotImplemented},
		// accept-invite is implemented (M3 invitations fix): without identity
		// it answers the auth gate's 401, not the old unimplemented 501.
		{"POST", "/api/auth/accept-invite", http.StatusUnauthorized},
		{"GET", "/api/feature-flags", http.StatusNotFound},
	}
	for _, tc := range cases {
		res := env.Do(tc.method, tc.path, nil, "")
		if res.Status != tc.status {
			t.Errorf("%s %s: status %d want %d (%s)", tc.method, tc.path, res.Status, tc.status, res.Raw)
		}
	}
	// 405 carries Allow.
	res := env.Do("DELETE", "/api/auth/me", nil, "")
	if allow := res.Header.Get("Allow"); !strings.Contains(allow, "GET") || !strings.Contains(allow, "PATCH") {
		t.Errorf("Allow header missing: %q", allow)
	}
}

func TestJSONBodyLimit(t *testing.T) {
	env := testkit.NewTestEnv(t)
	huge := map[string]any{"email": "a@b.co", "password": strings.Repeat("p", 200*1024)}
	res := env.Do("POST", "/api/auth/login", huge, "")
	if res.Status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body: %d", res.Status)
	}
}

// tinyPNG is a 1x1 transparent PNG.
func tinyPNG(t *testing.T) []byte {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestAvatarUploadAndServe(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, access, _ := env.FullAccount("avatar@example.com", "avatarer")

	upload := func(contentType string, data []byte, filename string) testkit.Response {
		var buf bytes.Buffer
		writer := multipart.NewWriter(&buf)
		part, err := writer.CreateFormFile("avatar", filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(data); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest("POST", "/api/auth/me/avatar", &buf)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", writer.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+access)
		rec := httptest.NewRecorder()
		env.App.Handler.ServeHTTP(rec, req)
		return testkit.ParseResponse(rec)
	}

	noFile := env.Do("POST", "/api/auth/me/avatar", map[string]any{}, access)
	if noFile.Status != http.StatusBadRequest || noFile.Body["error"] != "No avatar file provided" {
		t.Fatalf("no file: %d %s", noFile.Status, noFile.Raw)
	}

	bad := upload("image/png", []byte("definitely not an image"), "x.png")
	if bad.Status != http.StatusBadRequest || bad.Body["errorCode"] != "PROFILE_AVATAR_BAD_FORMAT" {
		t.Fatalf("bad format: %d %s", bad.Status, bad.Raw)
	}

	ok := upload("image/png", tinyPNG(t), "me.png")
	if ok.Status != http.StatusOK {
		t.Fatalf("upload failed: %d %s", ok.Status, ok.Raw)
	}
	avatarURL, _ := ok.Body["avatarUrl"].(string)
	if !strings.HasPrefix(avatarURL, "/api/avatars/users/") || !strings.HasSuffix(avatarURL, ".png") {
		t.Fatalf("avatarUrl shape: %q", avatarURL)
	}

	// Serving the stored avatar works and is cacheable.
	res := env.Do("GET", avatarURL, nil, "")
	if res.Status != http.StatusOK {
		t.Fatalf("serve avatar: %d", res.Status)
	}
	if cache := res.Header.Get("Cache-Control"); !strings.Contains(cache, "immutable") {
		t.Errorf("cache header: %q", cache)
	}
	// Path traversal is refused.
	traversal := env.Do("GET", "/api/avatars/users/..%2F..%2Fkeys%2Fjwt-secret", nil, "")
	if traversal.Status != http.StatusNotFound {
		t.Fatalf("traversal: %d", traversal.Status)
	}
}

func TestPersistenceAcrossRestart(t *testing.T) {
	env := testkit.NewTestEnv(t)
	userID, access, refresh := env.FullAccount("persist@example.com", "persister")

	// Reopen the same data dir in a fresh app ("restart").
	restarted := env.Reopen()

	// The stored JWT secret means previously issued tokens still verify.
	me := restarted.Do("GET", "/api/auth/me", nil, access)
	if me.Status != http.StatusOK || me.Body["id"] != userID {
		t.Fatalf("access token lost across restart: %d %s", me.Status, me.Raw)
	}
	// The refresh session persisted.
	refreshed := restarted.Do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, "")
	if refreshed.Status != http.StatusOK {
		t.Fatalf("refresh lost across restart: %d %s", refreshed.Status, refreshed.Raw)
	}
	// Login still works with the persisted Argon2 hash.
	login := restarted.Do("POST", "/api/auth/login", map[string]any{"email": "persist@example.com", "password": "password-123"}, "")
	if login.Status != http.StatusOK {
		t.Fatalf("login lost across restart: %d", login.Status)
	}
}

func TestMeAfterFamilyRevokedByOtherMeans(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, access, refresh := env.FullAccount("revoked@example.com", "revoker")
	// Simulate an admin/credential reset revoking the family out-of-band.
	if _, err := env.App.DB.Exec(`UPDATE session_families SET revoked_at = 1 WHERE revoked_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	if me := env.Do("GET", "/api/auth/me", nil, access); me.Status != http.StatusUnauthorized {
		t.Fatalf("revoked family accepted: %d", me.Status)
	}
	if r := env.Do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, ""); r.Status != http.StatusUnauthorized {
		t.Fatalf("refresh on revoked family accepted: %d", r.Status)
	}
}
