package legacyweb_test

import (
	"net/http"
	"strings"
	"testing"
)

func TestDeletedAccountStillReturnsAuthoritative401(t *testing.T) {
	e := newTestEnv(t)
	id, access, _ := e.registerOK("deleted-account@example.test")
	if _, err := e.app.DB.Exec(`DELETE FROM users WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	if result := e.do("GET", "/api/auth/me", nil, access); result.status != http.StatusUnauthorized {
		t.Fatalf("missing account must be 401, not a temporary outage: %d", result.status)
	}
}

func TestProfileWriteFailureDoesNotInvalidateTheSession(t *testing.T) {
	e := newTestEnv(t)
	_, access, _ := e.registerOK("profile-write-failure@example.test")
	if _, err := e.app.DB.Exec(`CREATE TRIGGER reject_profile_update BEFORE UPDATE OF display_name ON users
		BEGIN SELECT RAISE(ABORT, 'injected profile write failure'); END`); err != nil {
		t.Fatal(err)
	}
	failed := e.do("PATCH", "/api/auth/me", map[string]any{"displayName": "Not committed"}, access)
	if failed.status != http.StatusServiceUnavailable {
		t.Fatalf("write failure must not be reported as invalid credentials: %d", failed.status)
	}
	me := e.do("GET", "/api/auth/me", nil, access)
	if me.status != http.StatusOK || me.body["displayName"] == "Not committed" {
		t.Fatal("failed write altered the profile or revoked a valid session")
	}
}

func TestResetPasswordPolicyFailureKeepsTheTokenUsable(t *testing.T) {
	e := newTestEnv(t)
	e.registerOK("reset-policy@example.test")
	forgot := e.do("POST", "/api/auth/forgot-password", map[string]any{"email": "reset-policy@example.test"}, "")
	if forgot.status != http.StatusOK || forgot.body["ok"] != true {
		t.Fatal("forgot-password must return a JSON boolean ok=true")
	}
	token := e.latestOutboxLink("reset")
	tooLong := e.do("POST", "/api/auth/reset-password", map[string]any{"token": token, "password": strings.Repeat("x", 1025)}, "")
	if tooLong.status != http.StatusBadRequest || tooLong.body["error"] != "Password must be at most 1024 characters" {
		t.Fatal("password policy failure must not masquerade as an expired reset token")
	}
	valid := e.do("POST", "/api/auth/reset-password", map[string]any{"token": token, "password": "new-valid-password"}, "")
	if valid.status != http.StatusOK {
		t.Fatalf("validation failure consumed the reset token: %d", valid.status)
	}
}
