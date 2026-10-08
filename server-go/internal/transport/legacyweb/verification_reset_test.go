package legacyweb_test

import (
	"net/http"
	"testing"
)

func TestEmailVerificationFlow(t *testing.T) {
	env := newTestEnv(t)
	_, access, _ := env.registerOK("verify@example.com")

	missing := env.do("POST", "/api/auth/verify-email", map[string]any{}, "")
	if missing.status != http.StatusBadRequest || missing.body["error"] != "Token is required" {
		t.Fatalf("missing token: %d %s", missing.status, missing.raw)
	}
	invalid := env.do("POST", "/api/auth/verify-email", map[string]any{"token": "0000deadbeef"}, "")
	if invalid.status != http.StatusBadRequest || invalid.body["error"] != "Invalid or expired verification token" {
		t.Fatalf("invalid token: %d %s", invalid.status, invalid.raw)
	}

	token := env.latestOutboxLink("verify")
	if len(token) != 64 {
		t.Fatalf("token shape wrong: %q", token)
	}
	env.verifyEmailOf(token)

	me := env.do("GET", "/api/auth/me", nil, access)
	if me.body["emailVerified"] != true {
		t.Fatalf("me not verified: %s", me.raw)
	}

	// Second use of the one-shot token fails.
	again := env.do("POST", "/api/auth/verify-email", map[string]any{"token": token}, "")
	if again.status != http.StatusBadRequest {
		t.Fatalf("token reuse accepted: %d", again.status)
	}

	// Resend after verification is a 400.
	resend := env.do("POST", "/api/auth/resend-verification", nil, access)
	if resend.status != http.StatusBadRequest || resend.body["error"] != "Email is already verified" {
		t.Fatalf("resend verified: %d %s", resend.status, resend.raw)
	}
}

func TestResendVerificationCooldown(t *testing.T) {
	env := newTestEnv(t)
	_, access, _ := env.registerOK("resend@example.com")

	// Signup itself has just sent a verification email and starts the cooldown.
	initial := env.do("POST", "/api/auth/resend-verification", nil, access)
	if initial.status != http.StatusTooManyRequests {
		t.Fatalf("signup cooldown: %d", initial.status)
	}
	// Advance the persisted fixture past the cooldown without a minute-long sleep.
	if _, err := env.app.DB.Exec(`UPDATE account_tokens SET created_at = created_at - 61000 WHERE kind = 'email_verification';
		UPDATE account_email_requests SET created_at = created_at - 61000 WHERE kind = 'email_verification'`); err != nil {
		t.Fatal(err)
	}
	first := env.do("POST", "/api/auth/resend-verification", nil, access)
	if first.status != http.StatusOK || first.body["ok"] != true {
		t.Fatalf("resend after cooldown failed: %d %s", first.status, first.raw)
	}
	cooldown := env.do("POST", "/api/auth/resend-verification", nil, access)
	if cooldown.status != http.StatusTooManyRequests ||
		cooldown.body["error"] != "Please wait before requesting another verification email." {
		t.Fatalf("cooldown missing: %d %s", cooldown.status, cooldown.raw)
	}
}

func TestForgotResetPasswordFlow(t *testing.T) {
	env := newTestEnv(t)
	_, access, refresh := env.fullAccount("reset@example.com", "resetter")

	// Unknown account: same 200 body (no enumeration).
	unknown := env.do("POST", "/api/auth/forgot-password", map[string]any{"email": "ghost@example.com"}, "")
	if unknown.status != http.StatusOK || unknown.body["message"] == "" {
		t.Fatalf("unknown email: %d %s", unknown.status, unknown.raw)
	}
	missing := env.do("POST", "/api/auth/forgot-password", map[string]any{}, "")
	if missing.status != http.StatusBadRequest || missing.body["error"] != "Email is required" {
		t.Fatalf("missing email: %d %s", missing.status, missing.raw)
	}

	known := env.do("POST", "/api/auth/forgot-password", map[string]any{"email": "reset@example.com"}, "")
	if known.status != http.StatusOK {
		t.Fatalf("forgot failed: %d %s", known.status, known.raw)
	}
	token := env.latestOutboxLink("reset")
	if len(token) != 64 {
		t.Fatalf("reset token shape: %q", token)
	}

	short := env.do("POST", "/api/auth/reset-password", map[string]any{"token": token, "password": "short"}, "")
	if short.status != http.StatusBadRequest || short.body["error"] != "Password must be at least 8 characters" {
		t.Fatalf("short reset: %d %s", short.status, short.raw)
	}
	bad := env.do("POST", "/api/auth/reset-password", map[string]any{"token": "ffffffff", "password": "new-password-9"}, "")
	if bad.status != http.StatusBadRequest || bad.body["error"] != "Invalid or expired reset token" {
		t.Fatalf("bad reset token: %d %s", bad.status, bad.raw)
	}
	noFields := env.do("POST", "/api/auth/reset-password", map[string]any{}, "")
	if noFields.status != http.StatusBadRequest || noFields.body["error"] != "Token and password are required" {
		t.Fatalf("missing fields: %d %s", noFields.status, noFields.raw)
	}

	ok := env.do("POST", "/api/auth/reset-password", map[string]any{"token": token, "password": "new-password-9"}, "")
	if ok.status != http.StatusOK || ok.body["ok"] != true {
		t.Fatalf("reset failed: %d %s", ok.status, ok.raw)
	}

	// Reset revokes every session...
	if res := env.do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, ""); res.status != http.StatusUnauthorized {
		t.Fatalf("refresh survived reset: %d", res.status)
	}
	// ...and the old access token's family is dead.
	if res := env.do("GET", "/api/auth/me", nil, access); res.status != http.StatusUnauthorized {
		t.Fatalf("access survived reset: %d", res.status)
	}
	// Token is single-use.
	reuse := env.do("POST", "/api/auth/reset-password", map[string]any{"token": token, "password": "another-pass-9"}, "")
	if reuse.status != http.StatusBadRequest {
		t.Fatalf("reset token reused: %d", reuse.status)
	}
	// New password works.
	login := env.do("POST", "/api/auth/login", map[string]any{"email": "reset@example.com", "password": "new-password-9"}, "")
	if login.status != http.StatusOK {
		t.Fatalf("login with reset password: %d %s", login.status, login.raw)
	}
}
