// Wire-level device-code login contract: authorize/approve/token shapes,
// flag gating, session issuance and the closed error-code matrix.
package legacyweb_test

import (
	"net/http"
	"strings"
	"testing"

	"raft.local/server-go/internal/transport/legacyweb"
)

func TestDeviceAuthorizeHappyShape(t *testing.T) {
	e := newComputerEnv(t)
	e.seedUser("u1")

	code, body, raw := e.serve("POST", "/api/auth/device/authorize", `{"clientName":"raft-computer"}`, nil)
	if code != http.StatusCreated {
		t.Fatalf("authorize: %d %s", code, raw)
	}
	if v, _ := body["deviceCode"].(string); !strings.HasPrefix(v, "dvc_") {
		t.Fatalf("deviceCode = %v", body["deviceCode"])
	}
	userCode, _ := body["userCode"].(string)
	if len(userCode) != 9 || userCode[4] != '-' {
		t.Fatalf("userCode = %q", userCode)
	}
	uri, _ := body["verificationUri"].(string)
	complete, _ := body["verificationUriComplete"].(string)
	if uri != "http://127.0.0.1:5175/login/device" {
		t.Fatalf("verificationUri = %q", uri)
	}
	if !strings.HasPrefix(complete, uri+"?user_code=") || !strings.Contains(complete, userCode) {
		t.Fatalf("verificationUriComplete = %q", complete)
	}
	if body["expiresIn"] != float64(600) || body["interval"] != float64(5) {
		t.Fatalf("expiresIn/interval = %v/%v", body["expiresIn"], body["interval"])
	}

	// Approve requires a user session.
	if code, _, _ := e.serve("POST", "/api/auth/device/approve", `{"userCode":"`+userCode+`"}`, nil); code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated approve = %d, want 401", code)
	}
	// Approve with the raw (unnormalized) code.
	code, body, raw = e.serve("POST", "/api/auth/device/approve",
		`{"userCode":"`+strings.ToLower(userCode)+`"}`, e.bearer(e.tokenFor("u1")))
	if code != http.StatusOK || body["ok"] != true || body["action"] != "approved" {
		t.Fatalf("approve: %d %s", code, raw)
	}

	// Poll: pending is gone; consume issues a REAL user session.
}

func mustString(t *testing.T, body map[string]any, key string) string {
	t.Helper()
	v, _ := body[key].(string)
	return v
}

func TestDeviceTokenIssuesUserSession(t *testing.T) {
	e := newComputerEnv(t)
	e.seedUser("u1")

	_, grantBody, _ := e.serve("POST", "/api/auth/device/authorize", `{}`, nil)
	deviceCode := mustString(t, grantBody, "deviceCode")
	userCode := mustString(t, grantBody, "userCode")

	// Pending poll answers the RFC-8628-ish code.
	if code, body, _ := e.serve("POST", "/api/auth/device/token", `{"deviceCode":"`+deviceCode+`"}`, nil); code != http.StatusBadRequest || body["code"] != "authorization_pending" {
		t.Fatalf("pending poll = %d %v", code, body["code"])
	}
	_, _, _ = e.serve("POST", "/api/auth/device/approve", `{"userCode":"`+userCode+`"}`, e.bearer(e.tokenFor("u1")))
	code, body, raw := e.serve("POST", "/api/auth/device/token", `{"deviceCode":"`+deviceCode+`"}`, nil)
	if code != http.StatusOK {
		t.Fatalf("token: %d %s", code, raw)
	}
	accessToken := mustString(t, body, "accessToken")
	refreshToken := mustString(t, body, "refreshToken")
	if accessToken == "" || refreshToken == "" || body["userId"] != "u1" {
		t.Fatalf("session fields: %s", raw)
	}
	// The issued token is a real access token for the approving user.
	claims, err := e.signer.VerifyAccessToken(accessToken)
	if err != nil || claims.Subject != "u1" {
		t.Fatalf("verify issued token: %v %+v", err, claims)
	}
	// Second poll: consumed.
	if code, body, _ := e.serve("POST", "/api/auth/device/token", `{"deviceCode":"`+deviceCode+`"}`, nil); code != http.StatusGone || body["code"] != "device_code_consumed" {
		t.Fatalf("re-poll = %d %v", code, body["code"])
	}
}

func TestDeviceDenialAndValidation(t *testing.T) {
	e := newComputerEnv(t)
	e.seedUser("u1")

	// denial path
	_, grant, _ := e.serve("POST", "/api/auth/device/authorize", `{}`, nil)
	_, _, _ = e.serve("POST", "/api/auth/device/approve", `{"userCode":"`+mustString(t, grant, "userCode")+`","approve":false}`, e.bearer(e.tokenFor("u1")))
	if code, body, _ := e.serve("POST", "/api/auth/device/token", `{"deviceCode":"`+mustString(t, grant, "deviceCode")+`"}`, nil); code != http.StatusForbidden || body["code"] != "access_denied" {
		t.Fatalf("denied poll = %d %v", code, body["code"])
	}

	// input validation
	if code, body, _ := e.serve("POST", "/api/auth/device/token", `{}`, nil); code != http.StatusBadRequest || body["code"] != "device_code_required" {
		t.Fatalf("missing deviceCode = %d %v", code, body["code"])
	}
	if code, body, _ := e.serve("POST", "/api/auth/device/approve", `{"approve":true}`, e.bearer(e.tokenFor("u1"))); code != http.StatusBadRequest || body["code"] != "user_code_required" {
		t.Fatalf("missing userCode = %d %v", code, body["code"])
	}
	if code, body, _ := e.serve("POST", "/api/auth/device/authorize", `{"clientName":"`+strings.Repeat("a", 201)+`"}`, nil); code != http.StatusBadRequest || body["code"] != "client_name_invalid" {
		t.Fatalf("long clientName = %d %v", code, body["code"])
	}
	// unknown approve code folds to 404 user_code_invalid
	if code, body, _ := e.serve("POST", "/api/auth/device/approve", `{"userCode":"AAAA-AAAA"}`, e.bearer(e.tokenFor("u1"))); code != http.StatusNotFound || body["code"] != "user_code_invalid" {
		t.Fatalf("unknown userCode = %d %v", code, body["code"])
	}
	// already-resolved grant answers 409
	_, grant2, _ := e.serve("POST", "/api/auth/device/authorize", `{}`, nil)
	_, _, _ = e.serve("POST", "/api/auth/device/approve", `{"userCode":"`+mustString(t, grant2, "userCode")+`"}`, e.bearer(e.tokenFor("u1")))
	if code, body, _ := e.serve("POST", "/api/auth/device/approve", `{"userCode":"`+mustString(t, grant2, "userCode")+`"}`, e.bearer(e.tokenFor("u1"))); code != http.StatusConflict || body["code"] != "already_resolved" {
		t.Fatalf("re-approve = %d %v", code, body["code"])
	}
}

func TestDeviceSurfaceFlagAndURLGates(t *testing.T) {
	disabled := newComputerEnvWith(t, func(h *legacyweb.ComputerHandlers) { h.DeviceLoginEnabled = false })
	disabled.seedUser("u1")
	if code, body, _ := disabled.serve("POST", "/api/auth/device/authorize", `{}`, nil); code != http.StatusNotFound || body["code"] != "device_login_disabled" {
		t.Fatalf("flag off authorize = %d %v", code, body["code"])
	}
	if code, body, _ := disabled.serve("POST", "/api/computer/attach", `{"serverSlug":"x"}`, disabled.bearer(disabled.tokenFor("u1"))); code != http.StatusNotFound || body["code"] != "computer_attach_disabled" {
		t.Fatalf("flag off attach = %d %v", code, body["code"])
	}
	if code, body, _ := disabled.serve("GET", "/api/computer/legacy-machines?serverSlug=x", "", disabled.bearer(disabled.tokenFor("u1"))); code != http.StatusNotFound || body["code"] != "computer_legacy_roster_disabled" {
		t.Fatalf("flag off roster = %d %v", code, body["code"])
	}

	noURL := newComputerEnvWith(t, func(h *legacyweb.ComputerHandlers) { h.VerificationBaseURL = nil })
	if code, body, _ := noURL.serve("POST", "/api/auth/device/authorize", `{}`, nil); code != http.StatusServiceUnavailable || body["code"] != "DEVICE_LOGIN_URL_UNAVAILABLE" {
		t.Fatalf("no app url = %d %v", code, body["code"])
	}
}
