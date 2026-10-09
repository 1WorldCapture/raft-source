package httpapi_test

import (
	"strings"
	"testing"

	"raft.local/server-go/internal/transport/httpapi"
)

// These are inventory regressions for factual errors found during independent
// source review, not substitutes for the actual HTTP auth/rollback suites.
func TestManifestRetainsReviewedPolicyDistinctions(t *testing.T) {
	entries := httpapi.Manifest()
	mounts, children := 0, 0
	for _, entry := range entries {
		if entry.Kind == "mount" {
			mounts++
		} else {
			children++
		}
	}
	t.Logf("inventory: %d entries (%d actual mounts, %d logical dispatcher children)", len(entries), mounts, children)
	for _, tc := range []struct {
		key        string
		gate       string
		allow      string
		kind       string
		capability string
	}{
		{"* /internal/agent-api", "none", "", "mount", "401"},
		{"POST /api/auth/device/approve", "Require", "", "mount", "admission"},
		{"GET /api/computer/legacy-machines", "Require", "", "mount", "admission"},
		{"* /api/servers/{id}/machines", "RequireVerifiedProfileComplete", "GET", "mount", "405"},
		{"PATCH /api/servers/unread-summary", "RequireVerifiedProfileComplete", "GET", "mount", "405"},
		{"DELETE /api/messages/{messageId}/reactions", "RequireVerifiedProfileComplete", "", "dispatch", "implemented"},
		{"GET /api/messages/{messageId}/reactions/actors", "RequireVerifiedProfileComplete", "", "dispatch", "implemented"},
		{"GET /api/messages/{messageId}/reactions/viewer", "RequireVerifiedProfileComplete", "", "dispatch", "implemented"},
		{"POST /internal/computer/preflight", "computer-key", "", "dispatch", "preflight"},
	} {
		t.Run(tc.key, func(t *testing.T) {
			for _, entry := range entries {
				if entry.Method+" "+entry.Pattern != tc.key {
					continue
				}
				if entry.Gate != tc.gate || entry.Allow != tc.allow || entry.Kind != tc.kind || !strings.Contains(entry.Capability, tc.capability) {
					t.Fatalf("policy drift for %s: %+v", tc.key, entry)
				}
				return
			}
			t.Fatal("reviewed route missing from inventory")
		})
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Pattern, "/api/agents/") && (strings.Contains(entry.Pattern, "credentials") || entry.Pattern == "/api/agents/manageable") && entry.RateLimit != "none" {
			t.Errorf("human Agent credential route has no account limiter: %+v", entry)
		}
		if entry.Pattern == "/api/channels/{id}/read" && entry.Method == "POST" && !strings.HasPrefix(entry.Scope, "ReadstateHandlers.RequireServerScope;") {
			t.Errorf("readstate scope confused with channel or URL-workspace scope: %+v", entry)
		}
		if strings.Contains(entry.Pattern, "/reactions/{emoji}") || entry.Pattern == "/api/servers/{id}/" || strings.HasPrefix(entry.Pattern, "/api/runtime-catalog/") {
			t.Errorf("invented route reintroduced: %+v", entry)
		}
	}
}
