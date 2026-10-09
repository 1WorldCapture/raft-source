package httpapi_test

import (
	"strings"
	"testing"

	"raft.local/server-go/internal/transport/httpapi"
)

// TestRouteManifestHasNoDuplicates pins the manifest invariant: one owner
// and one policy per (method, pattern); duplicates would mean two adapters
// claim the same surface.
func TestRouteManifestHasNoDuplicates(t *testing.T) {
	seen := map[string]string{}
	for _, entry := range httpapi.Manifest() {
		key := entry.Method + " " + entry.Pattern
		if prev, dup := seen[key]; dup {
			t.Fatalf("duplicate manifest entry %s: %s and %s", key, prev, entry.Owner)
		}
		seen[key] = entry.Owner
	}
	if len(seen) < 30 {
		t.Fatalf("manifest unexpectedly small: %d entries", len(seen))
	}
}

// TestRouteManifestPolicyVocabulary keeps the policy dimensions honest: no
// invented wildcards, every dimension explicitly stated (never empty), and
// the gate vocabulary limited to the real middleware levels.
func TestRouteManifestPolicyVocabulary(t *testing.T) {
	gates := map[string]bool{
		"none": true, "Require": true, "RequireVerifiedProfileComplete": true,
		"agent-key": true, "computer-key": true, "device-grant": true,
		"bootstrap-token": true, "computer-registry": true,
		"agent-family-dispatch": true, "socketio-handshake": true, "daemon-proof": true,
	}
	identities := map[string]bool{
		"public": true, "human": true, "agent-key": true,
		"computer-key": true, "exchange": true, "daemon": true,
	}
	for _, entry := range httpapi.Manifest() {
		if strings.Contains(entry.Pattern, "*") {
			t.Errorf("%s %s uses an invented wildcard", entry.Method, entry.Pattern)
		}
		for name, value := range map[string]string{
			"Gate": entry.Gate, "Scope": entry.Scope,
			"RateLimit": entry.RateLimit, "Capability": entry.Capability,
		} {
			if strings.TrimSpace(value) == "" {
				t.Errorf("%s %s has no %s policy", entry.Method, entry.Pattern, name)
			}
		}
		if !identities[entry.Identity] {
			t.Errorf("%s has unknown identity %q", entry.Pattern, entry.Identity)
		}
		if entry.Kind != "mount" && entry.Kind != "dispatch" {
			t.Errorf("%s must distinguish mount from logical dispatcher child, got %q", entry.Pattern, entry.Kind)
		}
		if !gates[entry.Gate] {
			t.Errorf("%s %s has unknown gate policy %q", entry.Method, entry.Pattern, entry.Gate)
		}
	}
}
