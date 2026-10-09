// Wire-level /internal/computer/* contract: preflight happy shape, principal
// aliasing, wrong-principal rejection, fail-close on unregistered sibling
// paths and revocation taking effect between requests.
package computerapi_test

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"strings"
	"testing"

	"raft.local/server-go/internal/computer"
)

func (e *computerEnv) attachComputerKey(t *testing.T, workspaceSlug, name string) string {
	t.Helper()
	code, body, raw := e.Serve("POST", "/api/computer/attach",
		`{"serverSlug":"`+workspaceSlug+`","name":"`+name+`"}`, testkit.Bearer(e.tokenFor("owner")))
	if code != http.StatusCreated {
		t.Fatalf("attach: %d %s", code, raw)
	}
	return mustString(t, body, "apiKey")
}

func TestInternalPreflightHappyShape(t *testing.T) {
	e := newComputerEnv(t)
	e.seedUser("owner")
	e.seedWorkspace("w1", "alpha", "owner")
	e.seedMembership("w1", "owner", "owner")
	apiKey := e.attachComputerKey(t, "alpha", "host")

	code, body, raw := e.Serve("POST", "/internal/computer/preflight", `{}`, map[string]string{
		"Authorization": "Bearer " + apiKey,
	})
	if code != http.StatusOK {
		t.Fatalf("preflight = %d %s", code, raw)
	}
	if body["ok"] != true || body["serverSlug"] != "alpha" {
		t.Fatalf("preflight body: %s", raw)
	}
	if v, _ := body["surfaceVersion"].(string); v == "" {
		t.Fatalf("surfaceVersion missing: %s", raw)
	}
	if claimed, _ := body["claimedPrefixes"].([]any); len(claimed) != 1 || claimed[0] != "/internal/computer/" {
		t.Fatalf("claimedPrefixes = %v", body["claimedPrefixes"])
	}
	if principals, _ := body["registeredPrincipals"].([]any); len(principals) != 1 || principals[0] != "sk_computer" {
		t.Fatalf("registeredPrincipals = %v", body["registeredPrincipals"])
	}
	surface, _ := body["computerSurface"].([]any)
	if len(surface) != 1 {
		t.Fatalf("computerSurface = %v", body["computerSurface"])
	}
	row, _ := surface[0].(map[string]any)
	if row["method"] != "POST" || row["path"] != "/preflight" || row["principal"] != "sk_computer" {
		t.Fatalf("surface row = %v", row)
	}
	principal, _ := body["principal"].(map[string]any)
	if principal["kind"] != "computer" || principal["computerId"] == nil || principal["serverId"] != "w1" {
		t.Fatalf("principal echo = %v", principal)
	}
}

func TestInternalComputerAuthMatrix(t *testing.T) {
	e := newComputerEnv(t)
	e.seedUser("owner")
	e.seedUser("other")
	e.seedWorkspace("w1", "alpha", "owner")
	e.seedMembership("w1", "owner", "owner")
	e.seedMembership("w1", "other", "admin")
	apiKey := e.attachComputerKey(t, "alpha", "host")

	// No bearer.
	if code, body, _ := e.Serve("POST", "/internal/computer/preflight", `{}`, nil); code != http.StatusUnauthorized || body["error"] != "Missing computer credential" {
		t.Fatalf("no bearer = %d %v", code, body["error"])
	}
	// Wrong principal class (sk_agent_*): invalid_principal before any lookup.
	if code, body, _ := e.Serve("POST", "/internal/computer/preflight", `{}`, testkit.Bearer("sk_agent_deadbeefdeadbeef")); code != http.StatusUnauthorized || body["code"] != "invalid_principal" {
		t.Fatalf("agent key = %d %v", code, body["code"])
	}
	// A user JWT is also the wrong principal here.
	if code, body, _ := e.Serve("POST", "/internal/computer/preflight", `{}`, testkit.Bearer(e.tokenFor("owner"))); code != http.StatusUnauthorized || body["code"] != "invalid_principal" {
		t.Fatalf("jwt = %d %v", code, body["code"])
	}
	// Computer-shaped but unknown key.
	if code, body, _ := e.Serve("POST", "/internal/computer/preflight", `{}`, testkit.Bearer("sk_computer_0000000000000000000000000000000000000000000000000000000000000000")); code != http.StatusUnauthorized || body["error"] != "Invalid computer credential" {
		t.Fatalf("unknown key = %d %v", code, body["error"])
	}
	// Unregistered sibling path fails closed BEFORE auth.
	if code, body, _ := e.Serve("POST", "/internal/computer/runners", `{}`, testkit.Bearer(apiKey)); code != http.StatusUnauthorized || body["code"] != "auth_policy_unregistered_path" {
		t.Fatalf("unregistered path = %d %v", code, body["code"])
	}
	if code, body, _ := e.Serve("GET", "/internal/computer/preflight", ``, testkit.Bearer(apiKey)); code != http.StatusUnauthorized || body["code"] != "auth_policy_unregistered_path" {
		t.Fatalf("wrong method = %d %v", code, body["code"])
	}

	// Revocation lands between requests: the same key dies immediately.
	var computerID string
	if err := e.db.QueryRow(`SELECT id FROM computers WHERE api_key_prefix = ?`, apiKey[:16]).Scan(&computerID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.db.Exec(`UPDATE computers SET revoked_at = ? WHERE id = ?`, e.fixed.Now().UnixMilli(), computerID); err != nil {
		t.Fatal(err)
	}
	if code, body, _ := e.Serve("POST", "/internal/computer/preflight", `{}`, testkit.Bearer(apiKey)); code != http.StatusUnauthorized || body["error"] != "Invalid computer credential" {
		t.Fatalf("revoked key = %d %v", code, body["error"])
	}
}

func TestInternalComputerMachineAlias(t *testing.T) {
	e := newComputerEnv(t)
	e.seedUser("owner")
	e.seedWorkspace("w1", "alpha", "owner")
	e.seedMembership("w1", "owner", "owner")

	// Register a legacy machine through the real registration domain API
	// (the management routes live in humanapi); its key is the phase-1
	// alias on the computer surface.
	created, err := e.handlers.Store.RegisterMachine(t.Context(), "w1", "owner", "alias-box")
	if err != nil {
		t.Fatalf("register machine: %v", err)
	}
	machineKey := created.APIKey
	machineID := created.ReadModel["id"].(string)

	code, body, raw := e.Serve("POST", "/internal/computer/preflight", `{}`, testkit.Bearer(machineKey))
	if code != http.StatusOK {
		t.Fatalf("alias preflight = %d %s", code, raw)
	}
	principal, _ := body["principal"].(map[string]any)
	if principal["kind"] != "computer" {
		t.Fatalf("alias must present as computer: %v", principal)
	}
	// TS alias contract: req.computerId = req.machineId = machine.id.
	if principal["computerId"] != machineID {
		t.Fatalf("alias computerId = %v, want machine id %s", principal["computerId"], machineID)
	}

	// Once migrated the alias fails closed.
	if _, err := e.db.Exec(`UPDATE machines SET legacy_key_migrated_at = ? WHERE id = ?`, e.fixed.Now().UnixMilli(), machineID); err != nil {
		t.Fatal(err)
	}
	if code, body, _ := e.Serve("POST", "/internal/computer/preflight", `{}`, testkit.Bearer(machineKey)); code != http.StatusUnauthorized || body["code"] != computer.ReasonLegacyKeyMigrated {
		t.Fatalf("migrated alias = %d %v", code, body["code"])
	}

	// sk_daemon_* is NOT an alias on this surface (invalid principal).
	if code, body, _ := e.Serve("POST", "/internal/computer/preflight", `{}`, testkit.Bearer("sk_daemon_"+strings.Repeat("a", 64))); code != http.StatusUnauthorized || body["code"] != "invalid_principal" {
		t.Fatalf("daemon key = %d %v", code, body["code"])
	}
}
