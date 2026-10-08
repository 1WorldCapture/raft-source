// Wire-level legacy machine management: register (registerMachines gate) and
// rotate-key (capability OR machine-creator authority), plus scope behavior
// when the shared middleware is not wired.
package legacyweb_test

import (
	"net/http"
	"testing"
)

// registerMachineOK drives the real POST /api/servers/{id}/machines route.
func (e *computerEnv) registerMachineOK(workspaceID, userID, name string) map[string]any {
	e.t.Helper()
	code, body, raw := e.serve("POST", "/api/servers/"+workspaceID+"/machines",
		`{"name":"`+name+`"}`, e.bearer(e.tokenFor(userID)))
	if code != http.StatusOK {
		e.t.Fatalf("register machine: %d %s", code, raw)
	}
	return body
}

func TestRegisterMachineContract(t *testing.T) {
	e := newComputerEnv(t)
	e.seedUser("owner")
	e.seedUser("member")
	e.seedUser("admin")
	e.seedWorkspace("w1", "alpha", "owner")
	e.seedMembership("w1", "owner", "owner")
	e.seedMembership("w1", "member", "member")
	e.seedMembership("w1", "admin", "admin")

	// Non-member -> the TS "Server not found" (scope middleware absent, so
	// the handler's own role read decides).
	e.seedUser("stranger")
	if code, body, _ := e.serve("POST", "/api/servers/w1/machines", `{"name":"m1"}`, e.bearer(e.tokenFor("stranger"))); code != http.StatusNotFound || body["error"] != "Server not found" {
		t.Fatalf("stranger register = %d %v", code, body["error"])
	}
	// Member has a role but lacks the capability.
	if code, body, _ := e.serve("POST", "/api/servers/w1/machines", `{"name":"m1"}`, e.bearer(e.tokenFor("member"))); code != http.StatusForbidden || body["error"] != "The `registerMachines` capability is required to register machines" {
		t.Fatalf("member register = %d %v", code, body["error"])
	}
	// Name required.
	if code, body, _ := e.serve("POST", "/api/servers/w1/machines", `{}`, e.bearer(e.tokenFor("owner"))); code != http.StatusBadRequest || body["error"] != "Name is required" {
		t.Fatalf("nameless register = %d %v", code, body["error"])
	}

	body := e.registerMachineOK("w1", "admin", "Admin Box")
	apiKey, _ := body["apiKey"].(string)
	if len(apiKey) <= len("sk_machine_") {
		t.Fatalf("apiKey = %q", apiKey)
	}
	machine, _ := body["machine"].(map[string]any)
	if machine == nil || machine["id"] == "" || machine["serverId"] != "w1" || machine["userId"] != "admin" {
		t.Fatalf("machine read model = %v", machine)
	}
	if machine["status"] != "offline" || machine["isComputer"] != false || machine["agentCount"] != float64(0) {
		t.Fatalf("read model derived fields = %v", machine)
	}
	if prefix, _ := machine["apiKeyPrefix"].(string); prefix != apiKey[:20] {
		t.Fatalf("apiKeyPrefix = %q, want first 20 of the raw key", prefix)
	}
}

func TestRotateMachineKeyContract(t *testing.T) {
	e := newComputerEnv(t)
	e.seedUser("creator")
	e.seedUser("member")
	e.seedUser("admin")
	e.seedWorkspace("w1", "alpha", "creator")
	e.seedMembership("w1", "creator", "admin")
	e.seedMembership("w1", "member", "member")
	e.seedMembership("w1", "admin", "admin")

	created := e.registerMachineOK("w1", "creator", "box")
	machine, _ := created["machine"].(map[string]any)
	machineID, _ := machine["id"].(string)
	path := "/api/servers/w1/machines/" + machineID + "/rotate-key"

	// Creator authority beats the missing role capability.
	code, body, raw := e.serve("POST", path, ``, e.bearer(e.tokenFor("creator")))
	if code != http.StatusOK {
		t.Fatalf("creator rotate = %d %s", code, raw)
	}
	rotated, _ := body["apiKey"].(string)
	if rotated == "" || rotated == created["apiKey"] {
		t.Fatalf("rotated key = %v", body)
	}

	// Non-creator member is denied with the capability message.
	code, body, _ = e.serve("POST", path, ``, e.bearer(e.tokenFor("member")))
	if code != http.StatusForbidden || body["error"] != "The `rotateMachineKeys` capability or machine creator authority is required to rotate machine keys" {
		t.Fatalf("member rotate = %d %v", code, body["error"])
	}
	// Admin rotates by capability.
	if code, _, raw2 := e.serve("POST", path, ``, e.bearer(e.tokenFor("admin"))); code != http.StatusOK {
		t.Fatalf("admin rotate = %d %s", code, raw2)
	}
	// Machine of another workspace is a uniform miss.
	e.seedWorkspace("w2", "beta", "admin")
	e.seedMembership("w2", "admin", "owner")
	if code, body, _ := e.serve("POST", "/api/servers/w2/machines/"+machineID+"/rotate-key", ``, e.bearer(e.tokenFor("admin"))); code != http.StatusNotFound || body["error"] != "Machine not found in this server" {
		t.Fatalf("cross-workspace rotate = %d %v", code, body["error"])
	}
	// Non-member caller gets the "Server not found" answer.
	e.seedUser("stranger")
	if code, body, _ := e.serve("POST", path, ``, e.bearer(e.tokenFor("stranger"))); code != http.StatusNotFound || body["error"] != "Server not found" {
		t.Fatalf("stranger rotate = %d %v", code, body["error"])
	}
}
