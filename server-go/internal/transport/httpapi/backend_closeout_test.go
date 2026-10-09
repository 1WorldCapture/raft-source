package httpapi_test

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"strings"
	"testing"
)

func TestDeletedAccountStillReturnsAuthoritative401(t *testing.T) {
	e := testkit.NewTestEnv(t)
	id, access, _ := e.RegisterOK("deleted-account@example.test")
	if _, err := e.ExecFixture(`DELETE FROM users WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	if result := e.Do("GET", "/api/auth/me", nil, access); result.Status != http.StatusUnauthorized {
		t.Fatalf("missing account must be 401, not a temporary outage: %d", result.Status)
	}
}

func TestProfileWriteFailureDoesNotInvalidateTheSession(t *testing.T) {
	e := testkit.NewTestEnv(t)
	_, access, _ := e.RegisterOK("profile-write-failure@example.test")
	if _, err := e.ExecFixture(`CREATE TRIGGER reject_profile_update BEFORE UPDATE OF display_name ON users
		BEGIN SELECT RAISE(ABORT, 'injected profile write failure'); END`); err != nil {
		t.Fatal(err)
	}
	failed := e.Do("PATCH", "/api/auth/me", map[string]any{"displayName": "Not committed"}, access)
	if failed.Status != http.StatusServiceUnavailable {
		t.Fatalf("write failure must not be reported as invalid credentials: %d", failed.Status)
	}
	me := e.Do("GET", "/api/auth/me", nil, access)
	if me.Status != http.StatusOK || me.Body["displayName"] == "Not committed" {
		t.Fatal("failed write altered the profile or revoked a valid session")
	}
}

func TestResetPasswordPolicyFailureKeepsTheTokenUsable(t *testing.T) {
	e := testkit.NewTestEnv(t)
	e.RegisterOK("reset-policy@example.test")
	forgot := e.Do("POST", "/api/auth/forgot-password", map[string]any{"email": "reset-policy@example.test"}, "")
	if forgot.Status != http.StatusOK || forgot.Body["ok"] != true {
		t.Fatal("forgot-password must return a JSON boolean ok=true")
	}
	token := e.LatestOutboxLink("reset")
	tooLong := e.Do("POST", "/api/auth/reset-password", map[string]any{"token": token, "password": strings.Repeat("x", 1025)}, "")
	if tooLong.Status != http.StatusBadRequest || tooLong.Body["error"] != "Password must be at most 1024 characters" {
		t.Fatal("password policy failure must not masquerade as an expired reset token")
	}
	valid := e.Do("POST", "/api/auth/reset-password", map[string]any{"token": token, "password": "new-valid-password"}, "")
	if valid.Status != http.StatusOK {
		t.Fatalf("validation failure consumed the reset token: %d", valid.Status)
	}
}
