package humanapi_test

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"testing"
)

func TestEmailVerificationFlow(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, access, _ := env.RegisterOK("verify@example.com")

	missing := env.Do("POST", "/api/auth/verify-email", map[string]any{}, "")
	if missing.Status != http.StatusBadRequest || missing.Body["error"] != "Token is required" {
		t.Fatalf("missing token: %d %s", missing.Status, missing.Raw)
	}
	invalid := env.Do("POST", "/api/auth/verify-email", map[string]any{"token": "0000deadbeef"}, "")
	if invalid.Status != http.StatusBadRequest || invalid.Body["error"] != "Invalid or expired verification token" {
		t.Fatalf("invalid token: %d %s", invalid.Status, invalid.Raw)
	}

	token := env.LatestOutboxLink("verify")
	if len(token) != 64 {
		t.Fatalf("token shape wrong: %q", token)
	}
	env.VerifyEmailOf(token)

	me := env.Do("GET", "/api/auth/me", nil, access)
	if me.Body["emailVerified"] != true {
		t.Fatalf("me not verified: %s", me.Raw)
	}

	// Second use of the one-shot token fails.
	again := env.Do("POST", "/api/auth/verify-email", map[string]any{"token": token}, "")
	if again.Status != http.StatusBadRequest {
		t.Fatalf("token reuse accepted: %d", again.Status)
	}

	// Resend after verification is a 400.
	resend := env.Do("POST", "/api/auth/resend-verification", nil, access)
	if resend.Status != http.StatusBadRequest || resend.Body["error"] != "Email is already verified" {
		t.Fatalf("resend verified: %d %s", resend.Status, resend.Raw)
	}
}

func TestResendVerificationCooldown(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, access, _ := env.RegisterOK("resend@example.com")

	// Signup itself has just sent a verification email and starts the cooldown.
	initial := env.Do("POST", "/api/auth/resend-verification", nil, access)
	if initial.Status != http.StatusTooManyRequests {
		t.Fatalf("signup cooldown: %d", initial.Status)
	}
	// Advance the persisted fixture past the cooldown without a minute-long sleep.
	if _, err := env.App.DB.Exec(`UPDATE account_tokens SET created_at = created_at - 61000 WHERE kind = 'email_verification';
		UPDATE account_email_requests SET created_at = created_at - 61000 WHERE kind = 'email_verification'`); err != nil {
		t.Fatal(err)
	}
	first := env.Do("POST", "/api/auth/resend-verification", nil, access)
	if first.Status != http.StatusOK || first.Body["ok"] != true {
		t.Fatalf("resend after cooldown failed: %d %s", first.Status, first.Raw)
	}
	cooldown := env.Do("POST", "/api/auth/resend-verification", nil, access)
	if cooldown.Status != http.StatusTooManyRequests ||
		cooldown.Body["error"] != "Please wait before requesting another verification email." {
		t.Fatalf("cooldown missing: %d %s", cooldown.Status, cooldown.Raw)
	}
}

func TestForgotResetPasswordFlow(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, access, refresh := env.FullAccount("reset@example.com", "resetter")

	// Unknown account: same 200 body (no enumeration).
	unknown := env.Do("POST", "/api/auth/forgot-password", map[string]any{"email": "ghost@example.com"}, "")
	if unknown.Status != http.StatusOK || unknown.Body["message"] == "" {
		t.Fatalf("unknown email: %d %s", unknown.Status, unknown.Raw)
	}
	missing := env.Do("POST", "/api/auth/forgot-password", map[string]any{}, "")
	if missing.Status != http.StatusBadRequest || missing.Body["error"] != "Email is required" {
		t.Fatalf("missing email: %d %s", missing.Status, missing.Raw)
	}

	known := env.Do("POST", "/api/auth/forgot-password", map[string]any{"email": "reset@example.com"}, "")
	if known.Status != http.StatusOK {
		t.Fatalf("forgot failed: %d %s", known.Status, known.Raw)
	}
	token := env.LatestOutboxLink("reset")
	if len(token) != 64 {
		t.Fatalf("reset token shape: %q", token)
	}

	short := env.Do("POST", "/api/auth/reset-password", map[string]any{"token": token, "password": "short"}, "")
	if short.Status != http.StatusBadRequest || short.Body["error"] != "Password must be at least 8 characters" {
		t.Fatalf("short reset: %d %s", short.Status, short.Raw)
	}
	bad := env.Do("POST", "/api/auth/reset-password", map[string]any{"token": "ffffffff", "password": "new-password-9"}, "")
	if bad.Status != http.StatusBadRequest || bad.Body["error"] != "Invalid or expired reset token" {
		t.Fatalf("bad reset token: %d %s", bad.Status, bad.Raw)
	}
	noFields := env.Do("POST", "/api/auth/reset-password", map[string]any{}, "")
	if noFields.Status != http.StatusBadRequest || noFields.Body["error"] != "Token and password are required" {
		t.Fatalf("missing fields: %d %s", noFields.Status, noFields.Raw)
	}

	ok := env.Do("POST", "/api/auth/reset-password", map[string]any{"token": token, "password": "new-password-9"}, "")
	if ok.Status != http.StatusOK || ok.Body["ok"] != true {
		t.Fatalf("reset failed: %d %s", ok.Status, ok.Raw)
	}

	// Reset revokes every session...
	if res := env.Do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, ""); res.Status != http.StatusUnauthorized {
		t.Fatalf("refresh survived reset: %d", res.Status)
	}
	// ...and the old access token's family is dead.
	if res := env.Do("GET", "/api/auth/me", nil, access); res.Status != http.StatusUnauthorized {
		t.Fatalf("access survived reset: %d", res.Status)
	}
	// Token is single-use.
	reuse := env.Do("POST", "/api/auth/reset-password", map[string]any{"token": token, "password": "another-pass-9"}, "")
	if reuse.Status != http.StatusBadRequest {
		t.Fatalf("reset token reused: %d", reuse.Status)
	}
	// New password works.
	login := env.Do("POST", "/api/auth/login", map[string]any{"email": "reset@example.com", "password": "new-password-9"}, "")
	if login.Status != http.StatusOK {
		t.Fatalf("login with reset password: %d %s", login.Status, login.Raw)
	}
}
