package legacyweb_test

import (
	"bytes"
	"encoding/base64"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProvidersContract(t *testing.T) {
	env := newTestEnv(t)
	res := env.do("GET", "/api/auth/providers", nil, "")
	if res.status != http.StatusOK {
		t.Fatalf("providers: %d", res.status)
	}
	if raw := strings.TrimSpace(string(res.raw)); raw != `{"providers":[]}` {
		t.Fatalf("providers body: %s", raw)
	}
	bad := env.do("GET", "/api/auth/providers?platform=tv", nil, "")
	if bad.status != http.StatusBadRequest || bad.body["code"] != "platform_invalid" {
		t.Fatalf("platform validation: %d %s", bad.status, bad.raw)
	}
}

func TestRoutePolicy(t *testing.T) {
	env := newTestEnv(t)
	cases := []struct {
		method string
		path   string
		status int
	}{
		{"GET", "/api/definitely-not-a-route", http.StatusNotFound},
		{"DELETE", "/api/auth/me", http.StatusMethodNotAllowed},
		// M2 server paths run the account gates before method policy.
		{"PUT", "/api/servers", http.StatusUnauthorized},
		{"GET", "/socket.io/?EIO=4&transport=polling", http.StatusNotImplemented},
		{"POST", "/internal/agent-api/anything", http.StatusUnauthorized},
		{"GET", "/daemon/v1/nothing", http.StatusNotImplemented},
		// accept-invite is implemented (M3 invitations fix): without identity
		// it answers the auth gate's 401, not the old unimplemented 501.
		{"POST", "/api/auth/accept-invite", http.StatusUnauthorized},
		{"GET", "/api/feature-flags", http.StatusNotFound},
	}
	for _, tc := range cases {
		res := env.do(tc.method, tc.path, nil, "")
		if res.status != tc.status {
			t.Errorf("%s %s: status %d want %d (%s)", tc.method, tc.path, res.status, tc.status, res.raw)
		}
	}
	// 405 carries Allow.
	res := env.do("DELETE", "/api/auth/me", nil, "")
	if allow := res.header.Get("Allow"); !strings.Contains(allow, "GET") || !strings.Contains(allow, "PATCH") {
		t.Errorf("Allow header missing: %q", allow)
	}
}

func TestJSONBodyLimit(t *testing.T) {
	env := newTestEnv(t)
	huge := map[string]any{"email": "a@b.co", "password": strings.Repeat("p", 200*1024)}
	res := env.do("POST", "/api/auth/login", huge, "")
	if res.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body: %d", res.status)
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
	env := newTestEnv(t)
	_, access, _ := env.fullAccount("avatar@example.com", "avatarer")

	upload := func(contentType string, data []byte, filename string) response {
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
		env.app.Handler.ServeHTTP(rec, req)
		return parseResponse(rec)
	}

	noFile := env.do("POST", "/api/auth/me/avatar", map[string]any{}, access)
	if noFile.status != http.StatusBadRequest || noFile.body["error"] != "No avatar file provided" {
		t.Fatalf("no file: %d %s", noFile.status, noFile.raw)
	}

	bad := upload("image/png", []byte("definitely not an image"), "x.png")
	if bad.status != http.StatusBadRequest || bad.body["errorCode"] != "PROFILE_AVATAR_BAD_FORMAT" {
		t.Fatalf("bad format: %d %s", bad.status, bad.raw)
	}

	ok := upload("image/png", tinyPNG(t), "me.png")
	if ok.status != http.StatusOK {
		t.Fatalf("upload failed: %d %s", ok.status, ok.raw)
	}
	avatarURL, _ := ok.body["avatarUrl"].(string)
	if !strings.HasPrefix(avatarURL, "/api/avatars/users/") || !strings.HasSuffix(avatarURL, ".png") {
		t.Fatalf("avatarUrl shape: %q", avatarURL)
	}

	// Serving the stored avatar works and is cacheable.
	res := env.do("GET", avatarURL, nil, "")
	if res.status != http.StatusOK {
		t.Fatalf("serve avatar: %d", res.status)
	}
	if cache := res.header.Get("Cache-Control"); !strings.Contains(cache, "immutable") {
		t.Errorf("cache header: %q", cache)
	}
	// Path traversal is refused.
	traversal := env.do("GET", "/api/avatars/users/..%2F..%2Fkeys%2Fjwt-secret", nil, "")
	if traversal.status != http.StatusNotFound {
		t.Fatalf("traversal: %d", traversal.status)
	}
}

func TestPersistenceAcrossRestart(t *testing.T) {
	env := newTestEnv(t)
	userID, access, refresh := env.fullAccount("persist@example.com", "persister")

	// Reopen the same data dir in a fresh app ("restart").
	restarted := env.reopen()

	// The stored JWT secret means previously issued tokens still verify.
	me := restarted.do("GET", "/api/auth/me", nil, access)
	if me.status != http.StatusOK || me.body["id"] != userID {
		t.Fatalf("access token lost across restart: %d %s", me.status, me.raw)
	}
	// The refresh session persisted.
	refreshed := restarted.do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, "")
	if refreshed.status != http.StatusOK {
		t.Fatalf("refresh lost across restart: %d %s", refreshed.status, refreshed.raw)
	}
	// Login still works with the persisted Argon2 hash.
	login := restarted.do("POST", "/api/auth/login", map[string]any{"email": "persist@example.com", "password": "password-123"}, "")
	if login.status != http.StatusOK {
		t.Fatalf("login lost across restart: %d", login.status)
	}
}

func TestMeAfterFamilyRevokedByOtherMeans(t *testing.T) {
	env := newTestEnv(t)
	_, access, refresh := env.fullAccount("revoked@example.com", "revoker")
	// Simulate an admin/credential reset revoking the family out-of-band.
	if _, err := env.app.DB.Exec(`UPDATE session_families SET revoked_at = 1 WHERE revoked_at IS NULL`); err != nil {
		t.Fatal(err)
	}
	if me := env.do("GET", "/api/auth/me", nil, access); me.status != http.StatusUnauthorized {
		t.Fatalf("revoked family accepted: %d", me.status)
	}
	if r := env.do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, ""); r.status != http.StatusUnauthorized {
		t.Fatalf("refresh on revoked family accepted: %d", r.status)
	}
}
