package humanapi_test

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"strings"
	"testing"

	"raft.local/server-go/internal/auth"
)

func TestRegisterSuccessContract(t *testing.T) {
	env := testkit.NewTestEnv(t)
	res := env.Do("POST", "/api/auth/register", map[string]any{
		"email":          "alice@example.com",
		"password":       "password-123",
		"acceptTerms":    true,
		"termsVersion":   auth.TermsVersionCurrent,
		"privacyVersion": auth.PrivacyVersionCurrent,
	}, "")
	if res.Status != http.StatusOK {
		t.Fatalf("status %d: %s", res.Status, res.Raw)
	}
	user, ok := res.Body["user"].(map[string]any)
	if !ok {
		t.Fatalf("missing user: %s", res.Raw)
	}
	access, _ := res.Body["accessToken"].(string)
	refresh, _ := res.Body["refreshToken"].(string)
	if strings.Count(access, ".") != 2 || len(refresh) != 64 {
		t.Errorf("token shapes wrong: %q %q", access, refresh)
	}

	// Deferred-profile account shape.
	if user["name"].(string) == "" || !strings.HasPrefix(user["name"].(string), "pending_") {
		t.Errorf("pending handle missing: %v", user["name"])
	}
	if user["displayName"] != nil {
		t.Error("displayName should be null before completion")
	}
	if user["emailVerified"] != false {
		t.Error("emailVerified must be false at registration")
	}
	if user["profileSetupCompletedAt"] != nil {
		t.Error("profileSetupCompletedAt must be null at registration")
	}
	if suggested, _ := user["profileSetupSuggestedHandle"].(string); suggested == "" {
		t.Error("suggested handle missing")
	}
	// Derived preference defaults the client gates on.
	if user["preferredTranslationMode"] != "auto" || user["autoTranslationEnabled"] != true {
		t.Errorf("translation defaults wrong: %v %v", user["preferredTranslationMode"], user["autoTranslationEnabled"])
	}
	if user["preferredTranslationDisplay"] != "translated" {
		t.Error("translation display default wrong")
	}
	if user["profileSetupProvider"] != nil {
		t.Error("password accounts must not claim a social provider")
	}
	// gravatarHash is sha256(lowercased trimmed email).
	if user["gravatarHash"] != auth.HashToken("") && len(user["gravatarHash"].(string)) != 64 {
		t.Error("gravatarHash shape wrong")
	}
	if user["email"].(string) != "alice@example.com" {
		t.Error("email mismatch")
	}
}

func TestRegisterValidationFailures(t *testing.T) {
	env := testkit.NewTestEnv(t)
	legal := map[string]any{
		"acceptTerms": true, "termsVersion": auth.TermsVersionCurrent, "privacyVersion": auth.PrivacyVersionCurrent,
	}

	cases := []struct {
		name   string
		body   map[string]any
		status int
		code   string
		error_ string
	}{
		{"missing email", map[string]any{"password": "password-123"}, 400, "email_register_body_invalid", ""},
		{"empty password", map[string]any{"email": "a@b.co"}, 400, "email_register_body_invalid", ""},
		{"wrong type email", map[string]any{"email": 5, "password": "password-123"}, 400, "email_register_body_invalid", ""},
		{"short password", map[string]any{"email": "a@b.co", "password": "short"}, 400, "", "Password must be at least 8 characters"},
		{"bad name", func() map[string]any {
			b := map[string]any{"email": "a@b.co", "password": "password-123", "name": "ab"}
			for k, v := range legal {
				b[k] = v
			}
			return b
		}(), 400, "", "Name must be at least 5 characters"},
		{"no terms", map[string]any{"email": "a@b.co", "password": "password-123"}, 422, "", "LEGAL_ACCEPTANCE_REQUIRED"},
		{"old terms", func() map[string]any {
			b := map[string]any{"email": "a@b.co", "password": "password-123", "acceptTerms": true, "termsVersion": "2000-01-01", "privacyVersion": auth.PrivacyVersionCurrent}
			return b
		}(), 409, "", "TERMS_CHANGED"},
		{"invalid email", func() map[string]any {
			b := map[string]any{"email": "not-an-email", "password": "password-123"}
			for k, v := range legal {
				b[k] = v
			}
			return b
		}(), 400, "", "Invalid email address"},
	}
	for _, tc := range cases {
		res := env.Do("POST", "/api/auth/register", tc.body, "")
		if res.Status != tc.status {
			t.Errorf("%s: status %d want %d (%s)", tc.name, res.Status, tc.status, res.Raw)
			continue
		}
		if tc.code != "" && res.Body["code"] != tc.code {
			t.Errorf("%s: code %v want %s", tc.name, res.Body["code"], tc.code)
		}
		if tc.error_ != "" && res.Body["error"] != tc.error_ {
			t.Errorf("%s: error %v want %q", tc.name, res.Body["error"], tc.error_)
		}
	}

	// The 422 body carries the current legal versions for the UI.
	res := env.Do("POST", "/api/auth/register", map[string]any{"email": "a@b.co", "password": "password-123"}, "")
	legalBlock, ok := res.Body["legal"].(map[string]any)
	if !ok || legalBlock["termsVersion"] != auth.TermsVersionCurrent {
		t.Errorf("legal block missing: %s", res.Raw)
	}
}

func TestRegisterDuplicateEmailConflict(t *testing.T) {
	env := testkit.NewTestEnv(t)
	env.RegisterOK("dupe@example.com")
	res := env.Do("POST", "/api/auth/register", map[string]any{
		"email": "dupe@example.com", "password": "password-123",
		"acceptTerms": true, "termsVersion": auth.TermsVersionCurrent, "privacyVersion": auth.PrivacyVersionCurrent,
	}, "")
	if res.Status != http.StatusConflict || res.Body["error"] != "Email is already registered" {
		t.Fatalf("duplicate register: %d %s", res.Status, res.Raw)
	}
}

func TestLoginContract(t *testing.T) {
	env := testkit.NewTestEnv(t)
	env.RegisterOK("login@example.com")

	ok := env.Do("POST", "/api/auth/login", map[string]any{"email": "login@example.com", "password": "password-123"}, "")
	if ok.Status != http.StatusOK || ok.Body["user"] == nil || ok.Body["accessToken"] == nil {
		t.Fatalf("login failed: %d %s", ok.Status, ok.Raw)
	}
	// Case/whitespace-insensitive email like the legacy normalizer.
	ok2 := env.Do("POST", "/api/auth/login", map[string]any{"email": "  LOGIN@Example.COM ", "password": "password-123"}, "")
	if ok2.Status != http.StatusOK {
		t.Fatalf("normalized login failed: %d %s", ok2.Status, ok2.Raw)
	}

	wrong := env.Do("POST", "/api/auth/login", map[string]any{"email": "login@example.com", "password": "wrong-pass"}, "")
	if wrong.Status != http.StatusUnauthorized || wrong.Body["code"] != "AUTH_INVALID_CREDENTIALS" ||
		wrong.Body["error"] != "Invalid email or password" {
		t.Fatalf("wrong password: %d %s", wrong.Status, wrong.Raw)
	}
	missing := env.Do("POST", "/api/auth/login", map[string]any{"email": "ghost@example.com", "password": "wrong-pass"}, "")
	if missing.Status != http.StatusUnauthorized || missing.Body["code"] != "AUTH_INVALID_CREDENTIALS" {
		t.Fatalf("unknown account must match the same 401 body: %d %s", missing.Status, missing.Raw)
	}
	badBody := env.Do("POST", "/api/auth/login", map[string]any{"password": 1}, "")
	if badBody.Status != http.StatusBadRequest || badBody.Body["code"] != "email_login_body_invalid" {
		t.Fatalf("schema failure: %d %s", badBody.Status, badBody.Raw)
	}
	if issues, ok := badBody.Body["issues"].([]any); !ok || len(issues) == 0 {
		t.Error("issues array missing")
	}
}

func TestLoginAccountRateLimit(t *testing.T) {
	env := testkit.NewTestEnv(t)
	env.RegisterOK("throttle@example.com")
	for i := 0; i < 14; i++ {
		res := env.Do("POST", "/api/auth/login", map[string]any{"email": "throttle@example.com", "password": "nope-nope"}, "")
		if res.Status == http.StatusTooManyRequests {
			return // limiter engaged
		}
		if res.Status != http.StatusUnauthorized {
			t.Fatalf("unexpected status %d", res.Status)
		}
	}
	t.Error("per-account login limiter never engaged")
}
