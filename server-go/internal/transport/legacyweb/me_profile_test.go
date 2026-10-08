package legacyweb_test

import (
	"net/http"
	"strings"
	"testing"
)

func TestMeContract(t *testing.T) {
	env := newTestEnv(t)
	_, access, _ := env.registerOK("me@example.com")

	noAuth := env.do("GET", "/api/auth/me", nil, "")
	if noAuth.status != http.StatusUnauthorized || noAuth.body["code"] != "auth_required" {
		t.Fatalf("no auth: %d %s", noAuth.status, noAuth.raw)
	}
	bad := env.do("GET", "/api/auth/me", nil, "not-a-token")
	if bad.status != http.StatusUnauthorized || bad.body["error"] != "Invalid or expired token" {
		t.Fatalf("bad token: %d %s", bad.status, bad.raw)
	}
	ok := env.do("GET", "/api/auth/me", nil, access)
	if ok.status != http.StatusOK {
		t.Fatalf("me failed: %d %s", ok.status, ok.raw)
	}
	// /me returns the user object itself, not {user: ...}.
	if _, nested := ok.body["user"]; nested {
		t.Error("me must not nest the user")
	}
	if ok.body["email"].(string) != "me@example.com" {
		t.Error("me email mismatch")
	}
}

func TestUsernameAvailability(t *testing.T) {
	env := newTestEnv(t)
	_, access, _ := env.fullAccount("avail@example.com", "availability")

	cases := []struct {
		query  string
		avail  bool
		reason string
	}{
		{"availability", false, "taken"},
		{"ab", false, "invalid"},
		{"1abcde", false, "invalid"},
		{"system", false, "reserved"},
		{"pending_user", false, "reserved"},
		{"freshname", true, ""},
	}
	for _, tc := range cases {
		res := env.do("GET", "/api/auth/me/username-available?name="+tc.query, nil, access)
		if res.status != http.StatusOK {
			t.Fatalf("%s: status %d", tc.query, res.status)
		}
		if res.body["available"] != tc.avail {
			t.Errorf("%s: available=%v want %v", tc.query, res.body["available"], tc.avail)
		}
		if tc.reason != "" && res.body["reason"] != tc.reason {
			t.Errorf("%s: reason=%v want %s", tc.query, res.body["reason"], tc.reason)
		}
	}
	// Advisory precheck requires auth.
	if res := env.do("GET", "/api/auth/me/username-available?name=freshname", nil, ""); res.status != http.StatusUnauthorized {
		t.Errorf("unauthenticated precheck: %d", res.status)
	}
}

func TestCompleteProfileContract(t *testing.T) {
	env := newTestEnv(t)
	_, access, _ := env.registerOK("complete@example.com")

	// Strict schema: extra keys rejected.
	res := env.do("POST", "/api/auth/me/complete-profile", map[string]any{
		"name": "completer", "displayName": "Completer", "extra": 1,
	}, access)
	if res.status != http.StatusBadRequest || res.body["code"] != "PROFILE_SETUP_BODY_INVALID" {
		t.Fatalf("strict schema: %d %s", res.status, res.raw)
	}
	// Short name.
	res = env.do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "abc", "displayName": "X"}, access)
	if res.status != http.StatusBadRequest || res.body["code"] != "PROFILE_SETUP_NAME_INVALID" ||
		res.body["error"] != "Name must be at least 5 characters" {
		t.Fatalf("short name: %d %s", res.status, res.raw)
	}
	// Reserved name.
	res = env.do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "agents", "displayName": "X"}, access)
	if res.status != http.StatusBadRequest || res.body["code"] != "PROFILE_SETUP_NAME_RESERVED" {
		t.Fatalf("reserved: %d %s", res.status, res.raw)
	}
	// DisplayName bounds.
	res = env.do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "completer", "displayName": strings.Repeat("x", 81)}, access)
	if res.status != http.StatusBadRequest || res.body["code"] != "PROFILE_SETUP_BODY_INVALID" {
		t.Fatalf("long display must fail the request schema: %d %s", res.status, res.raw)
	}

	// Success.
	res = env.do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "completer", "displayName": "Completer"}, access)
	if res.status != http.StatusOK {
		t.Fatalf("complete failed: %d %s", res.status, res.raw)
	}
	if res.body["name"] != "completer" || res.body["displayName"] != "Completer" {
		t.Errorf("completion payload wrong: %s", res.raw)
	}
	if res.body["profileSetupCompletedAt"] == nil {
		t.Error("completion stamp missing")
	}
	if res.body["profileSetupSuggestedHandle"] != nil {
		t.Error("suggested handle must clear after completion")
	}
	stamp := res.body["profileSetupCompletedAt"].(string)
	if !strings.HasSuffix(stamp, "Z") || !strings.Contains(stamp, ".") {
		t.Errorf("date not millisecond UTC ISO: %q", stamp)
	}

	// Same-payload replay is idempotent success.
	res = env.do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "completer", "displayName": "Completer"}, access)
	if res.status != http.StatusOK {
		t.Fatalf("replay failed: %d %s", res.status, res.raw)
	}
	// Different payload on a completed account conflicts.
	res = env.do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "completer2", "displayName": "Completer"}, access)
	if res.status != http.StatusConflict || res.body["code"] != "PROFILE_SETUP_ALREADY_COMPLETED" {
		t.Fatalf("re-complete: %d %s", res.status, res.raw)
	}

	// Username collision across accounts.
	_, access2, _ := env.registerOK("complete2@example.com")
	env.verifyEmailOf(env.latestOutboxLink("verify"))
	res = env.do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "completer", "displayName": "X"}, access2)
	if res.status != http.StatusConflict || res.body["code"] != "PROFILE_SETUP_NAME_TAKEN" {
		t.Fatalf("name taken: %d %s", res.status, res.raw)
	}
}

func TestPatchProfilePreferences(t *testing.T) {
	env := newTestEnv(t)
	_, access, _ := env.fullAccount("patch@example.com", "patcher")

	res := env.do("PATCH", "/api/auth/me", map[string]any{
		"displayName":                  "Patched Name",
		"description":                  "hello world",
		"preferredLanguage":            "zh-Hans",
		"displayLanguage":              "en-US",
		"preferredTimezone":            " Asia/Shanghai ",
		"preferredTranslationMode":     "manual",
		"preferredTranslationDisplay":  "bilingual",
		"preferredTimeFormat":          "24h",
		"preferredMessageBodyFontSize": "lg",
		"signupRole":                   "founder",
		"referralSource":               "other",
		"referralSourceOther":          "a friend told me",
	}, access)
	if res.status != http.StatusOK {
		t.Fatalf("patch failed: %d %s", res.status, res.raw)
	}
	checks := map[string]any{
		"displayName":                  "Patched Name",
		"description":                  "hello world",
		"preferredLanguage":            "zh-cn",
		"displayLanguage":              "en",
		"preferredTimezone":            "Asia/Shanghai",
		"preferredTranslationMode":     "manual",
		"autoTranslationEnabled":       false,
		"preferredTranslationDisplay":  "bilingual",
		"preferredTimeFormat":          "24h",
		"preferredMessageBodyFontSize": "lg",
		"signupRole":                   "founder",
		"referralSource":               "other",
		"referralSourceOther":          "a friend told me",
	}
	for field, want := range checks {
		if res.body[field] != want {
			t.Errorf("%s = %v, want %v", field, res.body[field], want)
		}
	}
	if res.body["signupSurveyCompletedAt"] == nil {
		t.Error("survey stamp missing")
	}

	// Invalid values reject with the legacy sentences.
	badCases := []struct {
		field string
		value any
		want  string
	}{
		{"preferredLanguage", "klingon", "preferredLanguage must be a supported language tag"},
		{"displayLanguage", "fr", "displayLanguage must be a supported UI display locale"},
		{"preferredTimezone", "Mars/Olympus", "preferredTimezone must be an IANA timezone"},
		{"preferredTranslationMode", "sometimes", "preferredTranslationMode must be auto, manual, or off"},
		{"preferredTranslationDisplay", "both", "preferredTranslationDisplay must be translated, original, or bilingual"},
		{"preferredTimeFormat", "48h", "preferredTimeFormat must be 12h, 24h, or null"},
		{"preferredMessageBodyFontSize", "xl", "preferredMessageBodyFontSize must be sm, md, lg, or null"},
		{"signupRole", "astronaut", "Invalid signupRole"},
		{"referralSource", "myspace", "Invalid referralSource"},
		{"referralSourceSkipped", "yes", "referralSourceSkipped must be a boolean"},
	}
	for _, tc := range badCases {
		res := env.do("PATCH", "/api/auth/me", map[string]any{tc.field: tc.value}, access)
		if res.status != http.StatusBadRequest || res.body["error"] != tc.want {
			t.Errorf("%s=%v: %d %s", tc.field, tc.value, res.status, res.raw)
		}
	}
	// referralSourceOther without referralSource.
	res = env.do("PATCH", "/api/auth/me", map[string]any{"referralSourceOther": "x"}, access)
	if res.status != http.StatusBadRequest || res.body["error"] != "referralSource is required when referralSourceOther is provided" {
		t.Fatalf("orphan other: %d %s", res.status, res.raw)
	}
	// Description cap.
	res = env.do("PATCH", "/api/auth/me", map[string]any{"description": strings.Repeat("d", 3001)}, access)
	if res.status != http.StatusBadRequest {
		t.Fatalf("long description: %d", res.status)
	}
	// Nulls clear.
	res = env.do("PATCH", "/api/auth/me", map[string]any{"description": nil, "preferredTimeFormat": nil}, access)
	if res.status != http.StatusOK || res.body["description"] != nil || res.body["preferredTimeFormat"] != nil {
		t.Fatalf("null clear failed: %d %s", res.status, res.raw)
	}
	// avatarUrl hardening: arbitrary URLs rejected.
	res = env.do("PATCH", "/api/auth/me", map[string]any{"avatarUrl": "https://evil.example/x.png"}, access)
	if res.status != http.StatusBadRequest {
		t.Fatalf("arbitrary avatarUrl accepted: %d", res.status)
	}
}

func TestTimezoneObservation(t *testing.T) {
	env := newTestEnv(t)
	_, access, _ := env.fullAccount("tz@example.com", "tzwatcher")

	bad := env.do("POST", "/api/auth/me/timezone-observation", map[string]any{"timezone": "Mars/Olympus_Mons"}, access)
	if bad.status != http.StatusBadRequest {
		t.Fatalf("bad tz: %d %s", bad.status, bad.raw)
	}
	strict := env.do("POST", "/api/auth/me/timezone-observation", map[string]any{"timezone": "UTC", "extra": true}, access)
	if strict.status != http.StatusBadRequest || strict.body["code"] != "timezone_observation_body_invalid" {
		t.Fatalf("strict schema: %d %s", strict.status, strict.raw)
	}

	ok := env.do("POST", "/api/auth/me/timezone-observation", map[string]any{"timezone": "Asia/Shanghai"}, access)
	if ok.status != http.StatusOK {
		t.Fatalf("observation failed: %d %s", ok.status, ok.raw)
	}
	if ok.body["firstObservedTimezone"] != "Asia/Shanghai" || ok.body["lastObservedTimezone"] != "Asia/Shanghai" {
		t.Errorf("observation payload wrong: %s", ok.raw)
	}
	if ok.body["firstObservedTimezoneAt"] == nil {
		t.Error("first stamp missing")
	}

	// me reflects the observation.
	me := env.do("GET", "/api/auth/me", nil, access)
	if me.body["firstObservedTimezone"] != "Asia/Shanghai" {
		t.Errorf("me missing observation: %s", me.raw)
	}
}

func TestChangePasswordViaPatch(t *testing.T) {
	env := newTestEnv(t)
	_, access, refresh := env.fullAccount("chpw@example.com", "changepw")

	wrong := env.do("PATCH", "/api/auth/me", map[string]any{"currentPassword": "nope-nope", "newPassword": "new-password-9"}, access)
	if wrong.status != http.StatusUnauthorized || wrong.body["code"] != "AUTH_CURRENT_PASSWORD_INCORRECT" {
		t.Fatalf("wrong current: %d %s", wrong.status, wrong.raw)
	}
	short := env.do("PATCH", "/api/auth/me", map[string]any{"currentPassword": "password-123", "newPassword": "short"}, access)
	if short.status != http.StatusBadRequest || short.body["error"] != "New password must be at least 8 characters" {
		t.Fatalf("short new: %d %s", short.status, short.raw)
	}
	ok := env.do("PATCH", "/api/auth/me", map[string]any{"currentPassword": "password-123", "newPassword": "new-password-9"}, access)
	if ok.status != http.StatusOK {
		t.Fatalf("change failed: %d %s", ok.status, ok.raw)
	}
	// Every session died with the credential change.
	if res := env.do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, ""); res.status != http.StatusUnauthorized {
		t.Fatalf("old refresh survived password change: %d", res.status)
	}
	// New password logs in.
	login := env.do("POST", "/api/auth/login", map[string]any{"email": "chpw@example.com", "password": "new-password-9"}, "")
	if login.status != http.StatusOK {
		t.Fatalf("new password rejected: %d %s", login.status, login.raw)
	}
}
