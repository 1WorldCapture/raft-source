package humanapi_test

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"strings"
	"testing"
)

func TestMeContract(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, access, _ := env.RegisterOK("me@example.com")

	noAuth := env.Do("GET", "/api/auth/me", nil, "")
	if noAuth.Status != http.StatusUnauthorized || noAuth.Body["code"] != "auth_required" {
		t.Fatalf("no auth: %d %s", noAuth.Status, noAuth.Raw)
	}
	bad := env.Do("GET", "/api/auth/me", nil, "not-a-token")
	if bad.Status != http.StatusUnauthorized || bad.Body["error"] != "Invalid or expired token" {
		t.Fatalf("bad token: %d %s", bad.Status, bad.Raw)
	}
	ok := env.Do("GET", "/api/auth/me", nil, access)
	if ok.Status != http.StatusOK {
		t.Fatalf("me failed: %d %s", ok.Status, ok.Raw)
	}
	// /me returns the user object itself, not {user: ...}.
	if _, nested := ok.Body["user"]; nested {
		t.Error("me must not nest the user")
	}
	if ok.Body["email"].(string) != "me@example.com" {
		t.Error("me email mismatch")
	}
}

func TestUsernameAvailability(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, access, _ := env.FullAccount("avail@example.com", "availability")

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
		res := env.Do("GET", "/api/auth/me/username-available?name="+tc.query, nil, access)
		if res.Status != http.StatusOK {
			t.Fatalf("%s: status %d", tc.query, res.Status)
		}
		if res.Body["available"] != tc.avail {
			t.Errorf("%s: available=%v want %v", tc.query, res.Body["available"], tc.avail)
		}
		if tc.reason != "" && res.Body["reason"] != tc.reason {
			t.Errorf("%s: reason=%v want %s", tc.query, res.Body["reason"], tc.reason)
		}
	}
	// Advisory precheck requires auth.
	if res := env.Do("GET", "/api/auth/me/username-available?name=freshname", nil, ""); res.Status != http.StatusUnauthorized {
		t.Errorf("unauthenticated precheck: %d", res.Status)
	}
}

func TestCompleteProfileContract(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, access, _ := env.RegisterOK("complete@example.com")

	// Strict schema: extra keys rejected.
	res := env.Do("POST", "/api/auth/me/complete-profile", map[string]any{
		"name": "completer", "displayName": "Completer", "extra": 1,
	}, access)
	if res.Status != http.StatusBadRequest || res.Body["code"] != "PROFILE_SETUP_BODY_INVALID" {
		t.Fatalf("strict schema: %d %s", res.Status, res.Raw)
	}
	// Short name.
	res = env.Do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "abc", "displayName": "X"}, access)
	if res.Status != http.StatusBadRequest || res.Body["code"] != "PROFILE_SETUP_NAME_INVALID" ||
		res.Body["error"] != "Name must be at least 5 characters" {
		t.Fatalf("short name: %d %s", res.Status, res.Raw)
	}
	// Reserved name.
	res = env.Do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "agents", "displayName": "X"}, access)
	if res.Status != http.StatusBadRequest || res.Body["code"] != "PROFILE_SETUP_NAME_RESERVED" {
		t.Fatalf("reserved: %d %s", res.Status, res.Raw)
	}
	// DisplayName bounds.
	res = env.Do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "completer", "displayName": strings.Repeat("x", 81)}, access)
	if res.Status != http.StatusBadRequest || res.Body["code"] != "PROFILE_SETUP_BODY_INVALID" {
		t.Fatalf("long display must fail the request schema: %d %s", res.Status, res.Raw)
	}

	// Success.
	res = env.Do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "completer", "displayName": "Completer"}, access)
	if res.Status != http.StatusOK {
		t.Fatalf("complete failed: %d %s", res.Status, res.Raw)
	}
	if res.Body["name"] != "completer" || res.Body["displayName"] != "Completer" {
		t.Errorf("completion payload wrong: %s", res.Raw)
	}
	if res.Body["profileSetupCompletedAt"] == nil {
		t.Error("completion stamp missing")
	}
	if res.Body["profileSetupSuggestedHandle"] != nil {
		t.Error("suggested handle must clear after completion")
	}
	stamp := res.Body["profileSetupCompletedAt"].(string)
	if !strings.HasSuffix(stamp, "Z") || !strings.Contains(stamp, ".") {
		t.Errorf("date not millisecond UTC ISO: %q", stamp)
	}

	// Same-payload replay is idempotent success.
	res = env.Do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "completer", "displayName": "Completer"}, access)
	if res.Status != http.StatusOK {
		t.Fatalf("replay failed: %d %s", res.Status, res.Raw)
	}
	// Different payload on a completed account conflicts.
	res = env.Do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "completer2", "displayName": "Completer"}, access)
	if res.Status != http.StatusConflict || res.Body["code"] != "PROFILE_SETUP_ALREADY_COMPLETED" {
		t.Fatalf("re-complete: %d %s", res.Status, res.Raw)
	}

	// Username collision across accounts.
	_, access2, _ := env.RegisterOK("complete2@example.com")
	env.VerifyEmailOf(env.LatestOutboxLink("verify"))
	res = env.Do("POST", "/api/auth/me/complete-profile", map[string]any{"name": "completer", "displayName": "X"}, access2)
	if res.Status != http.StatusConflict || res.Body["code"] != "PROFILE_SETUP_NAME_TAKEN" {
		t.Fatalf("name taken: %d %s", res.Status, res.Raw)
	}
}

func TestPatchProfilePreferences(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, access, _ := env.FullAccount("patch@example.com", "patcher")

	res := env.Do("PATCH", "/api/auth/me", map[string]any{
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
	if res.Status != http.StatusOK {
		t.Fatalf("patch failed: %d %s", res.Status, res.Raw)
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
		if res.Body[field] != want {
			t.Errorf("%s = %v, want %v", field, res.Body[field], want)
		}
	}
	if res.Body["signupSurveyCompletedAt"] == nil {
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
		res := env.Do("PATCH", "/api/auth/me", map[string]any{tc.field: tc.value}, access)
		if res.Status != http.StatusBadRequest || res.Body["error"] != tc.want {
			t.Errorf("%s=%v: %d %s", tc.field, tc.value, res.Status, res.Raw)
		}
	}
	// referralSourceOther without referralSource.
	res = env.Do("PATCH", "/api/auth/me", map[string]any{"referralSourceOther": "x"}, access)
	if res.Status != http.StatusBadRequest || res.Body["error"] != "referralSource is required when referralSourceOther is provided" {
		t.Fatalf("orphan other: %d %s", res.Status, res.Raw)
	}
	// Description cap.
	res = env.Do("PATCH", "/api/auth/me", map[string]any{"description": strings.Repeat("d", 3001)}, access)
	if res.Status != http.StatusBadRequest {
		t.Fatalf("long description: %d", res.Status)
	}
	// Nulls clear.
	res = env.Do("PATCH", "/api/auth/me", map[string]any{"description": nil, "preferredTimeFormat": nil}, access)
	if res.Status != http.StatusOK || res.Body["description"] != nil || res.Body["preferredTimeFormat"] != nil {
		t.Fatalf("null clear failed: %d %s", res.Status, res.Raw)
	}
	// avatarUrl hardening: arbitrary URLs rejected.
	res = env.Do("PATCH", "/api/auth/me", map[string]any{"avatarUrl": "https://evil.example/x.png"}, access)
	if res.Status != http.StatusBadRequest {
		t.Fatalf("arbitrary avatarUrl accepted: %d", res.Status)
	}
}

func TestTimezoneObservation(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, access, _ := env.FullAccount("tz@example.com", "tzwatcher")

	bad := env.Do("POST", "/api/auth/me/timezone-observation", map[string]any{"timezone": "Mars/Olympus_Mons"}, access)
	if bad.Status != http.StatusBadRequest {
		t.Fatalf("bad tz: %d %s", bad.Status, bad.Raw)
	}
	strict := env.Do("POST", "/api/auth/me/timezone-observation", map[string]any{"timezone": "UTC", "extra": true}, access)
	if strict.Status != http.StatusBadRequest || strict.Body["code"] != "timezone_observation_body_invalid" {
		t.Fatalf("strict schema: %d %s", strict.Status, strict.Raw)
	}

	ok := env.Do("POST", "/api/auth/me/timezone-observation", map[string]any{"timezone": "Asia/Shanghai"}, access)
	if ok.Status != http.StatusOK {
		t.Fatalf("observation failed: %d %s", ok.Status, ok.Raw)
	}
	if ok.Body["firstObservedTimezone"] != "Asia/Shanghai" || ok.Body["lastObservedTimezone"] != "Asia/Shanghai" {
		t.Errorf("observation payload wrong: %s", ok.Raw)
	}
	if ok.Body["firstObservedTimezoneAt"] == nil {
		t.Error("first stamp missing")
	}

	// me reflects the observation.
	me := env.Do("GET", "/api/auth/me", nil, access)
	if me.Body["firstObservedTimezone"] != "Asia/Shanghai" {
		t.Errorf("me missing observation: %s", me.Raw)
	}
}

func TestChangePasswordViaPatch(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, access, refresh := env.FullAccount("chpw@example.com", "changepw")

	wrong := env.Do("PATCH", "/api/auth/me", map[string]any{"currentPassword": "nope-nope", "newPassword": "new-password-9"}, access)
	if wrong.Status != http.StatusUnauthorized || wrong.Body["code"] != "AUTH_CURRENT_PASSWORD_INCORRECT" {
		t.Fatalf("wrong current: %d %s", wrong.Status, wrong.Raw)
	}
	short := env.Do("PATCH", "/api/auth/me", map[string]any{"currentPassword": "password-123", "newPassword": "short"}, access)
	if short.Status != http.StatusBadRequest || short.Body["error"] != "New password must be at least 8 characters" {
		t.Fatalf("short new: %d %s", short.Status, short.Raw)
	}
	ok := env.Do("PATCH", "/api/auth/me", map[string]any{"currentPassword": "password-123", "newPassword": "new-password-9"}, access)
	if ok.Status != http.StatusOK {
		t.Fatalf("change failed: %d %s", ok.Status, ok.Raw)
	}
	// Every session died with the credential change.
	if res := env.Do("POST", "/api/auth/refresh", map[string]any{"refreshToken": refresh}, ""); res.Status != http.StatusUnauthorized {
		t.Fatalf("old refresh survived password change: %d", res.Status)
	}
	// New password logs in.
	login := env.Do("POST", "/api/auth/login", map[string]any{"email": "chpw@example.com", "password": "new-password-9"}, "")
	if login.Status != http.StatusOK {
		t.Fatalf("new password rejected: %d %s", login.Status, login.Raw)
	}
}
