// Wire-level Computer attach + legacy roster contract: role gates, zero
// enumeration, collision, key issuance shape and roster filtering.
package computerapi_test

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"strings"
	"testing"
)

func TestComputerAttachContract(t *testing.T) {
	e := newComputerEnv(t)
	e.seedUser("owner")
	e.seedUser("admin")
	e.seedUser("member")
	e.seedUser("outsider")
	e.seedWorkspace("w1", "alpha", "owner")
	e.seedMembership("w1", "owner", "owner")
	e.seedMembership("w1", "admin", "admin")
	e.seedMembership("w1", "member", "member")

	// Validation first.
	if code, body, _ := e.Serve("POST", "/api/computer/attach", `{}`, testkit.Bearer(e.tokenFor("owner"))); code != http.StatusBadRequest || body["code"] != "server_slug_required" {
		t.Fatalf("missing slug = %d %v", code, body["code"])
	}
	if code, body, _ := e.Serve("POST", "/api/computer/attach", `{"serverSlug":"alpha","name":"`+strings.Repeat("n", 201)+`"}`, testkit.Bearer(e.tokenFor("owner"))); code != http.StatusBadRequest || body["code"] != "name_invalid" {
		t.Fatalf("long name = %d %v", code, body["code"])
	}
	if code, _, _ := e.Serve("POST", "/api/computer/attach", `{"serverSlug":"alpha"}`, nil); code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated attach = %d", code)
	}

	// Anti-enumeration: outsider + ghost slug both fold to the same 403.
	for _, user := range []string{"outsider"} {
		code, body, _ := e.Serve("POST", "/api/computer/attach", `{"serverSlug":"alpha"}`, testkit.Bearer(e.tokenFor(user)))
		if code != http.StatusForbidden || body["code"] != "not_authorized" {
			t.Fatalf("%s attach = %d %v", user, code, body["code"])
		}
	}
	code, body, _ := e.Serve("POST", "/api/computer/attach", `{"serverSlug":"ghost"}`, testkit.Bearer(e.tokenFor("owner")))
	if code != http.StatusForbidden || body["code"] != "not_authorized" {
		t.Fatalf("ghost slug attach = %d %v", code, body["code"])
	}
	// Member gets the distinct requires_admin.
	code, body, _ = e.Serve("POST", "/api/computer/attach", `{"serverSlug":"alpha"}`, testkit.Bearer(e.tokenFor("member")))
	if code != http.StatusForbidden || body["code"] != "requires_admin" {
		t.Fatalf("member attach = %d %v", code, body["code"])
	}

	// Happy path: admin attaches.
	code, body, raw := e.Serve("POST", "/api/computer/attach", `{"serverSlug":"alpha"}`, testkit.Bearer(e.tokenFor("admin")))
	if code != http.StatusCreated {
		t.Fatalf("admin attach = %d %s", code, raw)
	}
	apiKey := mustString(t, body, "apiKey")
	if !strings.HasPrefix(apiKey, "sk_computer_") {
		t.Fatalf("apiKey shape: %q", apiKey[:14])
	}
	if mustString(t, body, "serverMachineId") == "" || mustString(t, body, "machineId") == "" ||
		mustString(t, body, "serverMachineId") == mustString(t, body, "machineId") {
		t.Fatalf("serverMachineId/machineId must be distinct non-empty: %s", raw)
	}
	if mustString(t, body, "serverId") != "w1" || mustString(t, body, "serverSlug") != "alpha" || body["resumed"] != false {
		t.Fatalf("attach body: %s", raw)
	}

	// Same user + name collides; default name is "raft-computer".
	if code, body, _ := e.Serve("POST", "/api/computer/attach", `{"serverSlug":"alpha"}`, testkit.Bearer(e.tokenFor("admin"))); code != http.StatusConflict || body["code"] != "COMPUTER_NAME_COLLISION" {
		t.Fatalf("collision = %d %v", code, body["code"])
	}
	// A different admin may attach with the same display name (per-user namespace).
	if code, _, raw2 := e.Serve("POST", "/api/computer/attach", `{"serverSlug":"alpha"}`, testkit.Bearer(e.tokenFor("owner"))); code != http.StatusCreated {
		t.Fatalf("owner attach = %d %s", code, raw2)
	}
}

func TestComputerLegacyMachinesRoster(t *testing.T) {
	e := newComputerEnv(t)
	e.seedUser("owner")
	e.seedWorkspace("w1", "alpha", "owner")
	e.seedMembership("w1", "owner", "owner")

	// Seed a legacy machine through the real registration domain API (the
	// machine-management ROUTES live in humanapi now; the admission roster
	// still reads the machines table here).
	if _, err := e.handlers.Store.RegisterMachine(t.Context(), "w1", "owner", "dev-box"); err != nil {
		t.Fatalf("register machine: %v", err)
	}

	code, body, raw := e.Serve("GET", "/api/computer/legacy-machines?serverSlug=alpha", "", testkit.Bearer(e.tokenFor("owner")))
	if code != http.StatusOK {
		t.Fatalf("roster = %d %s", code, raw)
	}
	entries, _ := body["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("entries = %s", raw)
	}
	entry, _ := entries[0].(map[string]any)
	if entry["daemonId"] == "" || entry["apiKeyFingerprint"] == nil || entry["hasFingerprint"] != true {
		t.Fatalf("entry = %v", entry)
	}

	// includeAll=1 redacts the fingerprint even though it exists.
	code, body, raw = e.Serve("GET", "/api/computer/legacy-machines?serverSlug=alpha&includeAll=1", "", testkit.Bearer(e.tokenFor("owner")))
	if code != http.StatusOK {
		t.Fatalf("roster includeAll = %d %s", code, raw)
	}
	entries, _ = body["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("includeAll entries = %s", raw)
	}
	entry, _ = entries[0].(map[string]any)
	if _, present := entry["apiKeyFingerprint"]; present {
		t.Fatalf("includeAll must redact fingerprint: %v", entry)
	}

	// Anti-enumeration + validation.
	if code, body, _ := e.Serve("GET", "/api/computer/legacy-machines", "", testkit.Bearer(e.tokenFor("owner"))); code != http.StatusBadRequest || body["code"] != "server_slug_required" {
		t.Fatalf("missing slug = %d %v", code, body["code"])
	}
	e.seedUser("stranger")
	if code, body, _ := e.Serve("GET", "/api/computer/legacy-machines?serverSlug=alpha", "", testkit.Bearer(e.tokenFor("stranger"))); code != http.StatusForbidden || body["code"] != "not_authorized" {
		t.Fatalf("stranger roster = %d %v", code, body["code"])
	}
	if code, body, _ := e.Serve("GET", "/api/computer/legacy-machines?serverSlug=ghost", "", testkit.Bearer(e.tokenFor("owner"))); code != http.StatusForbidden || body["code"] != "not_authorized" {
		t.Fatalf("ghost roster = %d %v", code, body["code"])
	}
}
