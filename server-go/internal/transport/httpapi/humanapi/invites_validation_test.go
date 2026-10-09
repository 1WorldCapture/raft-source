package humanapi_test

import (
	"net/http"
	"raft.local/server-go/tests/testkit"
	"testing"
)

// TS servers.ts validates email before inviteMembers, then role; an explicit
// null role is invalid rather than a request for the default member role.
// The surrounding identity, workspace and guest guards still run first.
func TestInviteValidationPrecedenceAndExplicitNullRole(t *testing.T) {
	env := testkit.NewTestEnv(t)
	_, ownerToken, _ := env.FullAccount("iv-owner@example.com", "ivowner")
	memberID, memberToken, _ := env.FullAccount("iv-member@example.com", "ivmember")
	guestID, guestToken, _ := env.FullAccount("iv-guest@example.com", "ivguest")
	_, strangerToken, _ := env.FullAccount("iv-stranger@example.com", "ivstranger")
	workspaceID := env.CreateServer(t, ownerToken, "Invite Validation", "invite-validation-ws")
	env.AddMember(t, workspaceID, memberID, "member")
	env.AddMember(t, workspaceID, guestID, "guest")

	for _, tc := range []struct {
		name, token string
		body        map[string]any
		status      int
		message     string
	}{
		{"missing email before role", ownerToken, map[string]any{"role": "admin"}, 400, "Email is required"},
		{"member missing email", memberToken, map[string]any{}, 400, "Email is required"},
		{"member malformed email", memberToken, map[string]any{"email": "bad"}, 400, "Enter a valid email address"},
		{"email before role", ownerToken, map[string]any{"email": "bad", "role": nil}, 400, "Enter a valid email address"},
		{"member capability before role", memberToken, map[string]any{"email": "new@example.com", "role": nil}, 403, "Only server owners and admins can send invites"},
		{"explicit null role", ownerToken, map[string]any{"email": "new@example.com", "role": nil}, 400, "role must be one of: member, guest"},
		{"object role", ownerToken, map[string]any{"email": "new@example.com", "role": map[string]any{}}, 400, "role must be one of: member, guest"},
		{"array role", ownerToken, map[string]any{"email": "new@example.com", "role": []any{}}, 400, "role must be one of: member, guest"},
		{"guest guard before email", guestToken, map[string]any{}, 403, "Guests cannot access server management data"},
		{"foreign guard before email", strangerToken, map[string]any{}, 403, "Not a member of this server"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := env.Serve("POST", "/api/servers/"+workspaceID+"/invites", tc.body, testkit.Scoped(tc.token, workspaceID))
			if res.Status != tc.status || res.Body["error"] != tc.message {
				t.Fatalf("rec = %d %v, want %d %q", res.Status, res.Body, tc.status, tc.message)
			}
		})
	}
	if res := env.Serve("POST", "/api/servers/"+workspaceID+"/invites", map[string]any{}, nil); res.Status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated invalid body = %d, want 401", res.Status)
	}
	var rows int
	if err := env.App.DB.QueryRow(`SELECT COUNT(*) FROM workspace_invites`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("rejected requests created invitation rows: rows=%d err=%v", rows, err)
	}
}
