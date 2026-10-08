package core

import (
	"testing"
)

func TestParseHandshakeAuth(t *testing.T) {
	ws := "ws1"
	cases := []struct {
		name    string
		in      any
		check   func(*HandshakeAuth) bool
		wantErr string
	}{
		{"full web", map[string]any{"token": "t", "serverId": ws, "clientKind": "web"},
			func(a *HandshakeAuth) bool { return a.ServerID != nil && *a.ServerID == "ws1" && a.ClientKind == "web" }, ""},
		{"account-level null server", map[string]any{"token": "t", "serverId": nil, "clientKind": "web"},
			func(a *HandshakeAuth) bool { return a.ServerID == nil }, ""},
		{"account-level missing server", map[string]any{"token": "t", "clientKind": "web"},
			func(a *HandshakeAuth) bool { return a.ServerID == nil }, ""},
		{"default clientKind web", map[string]any{"token": "t", "clientKind": nil},
			func(a *HandshakeAuth) bool { return a.ClientKind == "web" }, ""},
		{"desktop kind", map[string]any{"token": "t", "serverId": ws, "clientKind": "desktop"},
			func(a *HandshakeAuth) bool { return a.ClientKind == "desktop" }, ""},
		{"not object", "nope", nil, "auth_not_object"},
		{"array", []any{"t"}, nil, "auth_not_object"},
		{"missing token", map[string]any{"serverId": ws}, nil, "token_missing"},
		{"blank token", map[string]any{"token": "  "}, nil, "token_missing"},
		{"non-string token", map[string]any{"token": 42}, nil, "token_missing"},
		{"invalid serverId type", map[string]any{"token": "t", "serverId": 7}, nil, "server_id_invalid"},
		{"blank serverId", map[string]any{"token": "t", "serverId": ""}, nil, "server_id_invalid"},
		{"invalid clientKind", map[string]any{"token": "t", "clientKind": "toaster"}, nil, "client_kind_invalid"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a, err := ParseHandshakeAuth(c.in)
			if c.wantErr != "" {
				if err == nil {
					t.Fatalf("want shape error %q, got %+v", c.wantErr, a)
				}
				shape, ok := err.(*AuthShapeError)
				if !ok || shape.Reason != c.wantErr {
					t.Fatalf("want %q got %v", c.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected: %v", err)
			}
			if !c.check(a) {
				t.Fatalf("bad parse: %+v", a)
			}
		})
	}
}

func TestRevocationValidation(t *testing.T) {
	if err := (&Revocation{UserID: "u"}).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (&Revocation{WorkspaceID: "w"}).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (&Revocation{WorkspaceID: "w", Scope: ScopeGuests}).Validate(); err != nil {
		t.Fatal(err)
	}
	if err := (&Revocation{WorkspaceID: "w", Scope: ScopeNonMembers, MemberUserIDs: []string{"a"}}).Validate(); err != nil {
		t.Fatalf("non-members with snapshot must validate: %v", err)
	}
	if err := (&Revocation{WorkspaceID: "w", Scope: ScopeNonMembers}).Validate(); err == nil {
		t.Fatal("non-members without snapshot accepted")
	}
	if err := (&Revocation{}).Validate(); err == nil {
		t.Fatal("empty accepted")
	}
}

func TestRevocationMatching(t *testing.T) {
	id := Identity{UserID: "u1", SessionFamilyID: "f1", WorkspaceID: "w1", ServerRole: "member"}
	idGuest := Identity{UserID: "u2", WorkspaceID: "w1", ServerRole: "guest"}
	idPending := Identity{UserID: "u2", WorkspaceID: "w1", ServerRole: ""} // role unresolved
	idOtherWS := Identity{UserID: "u1", WorkspaceID: "w2"}

	if !(&Revocation{UserID: "u1"}).MatchesIdentity(id) {
		t.Fatal("user revocation must match")
	}
	if (&Revocation{UserID: "u1", SessionFamilyID: "f2"}).MatchesIdentity(id) {
		t.Fatal("family-scoped revocation leaked to other family")
	}
	if !(&Revocation{UserID: "u1", SessionFamilyID: "f1"}).MatchesIdentity(id) {
		t.Fatal("family match failed")
	}
	if (&Revocation{WorkspaceID: "w1", Scope: ScopeGuests}).MatchesIdentity(id) {
		t.Fatal("guest scope matched member")
	}
	if !(&Revocation{WorkspaceID: "w1", Scope: ScopeGuests}).MatchesIdentity(idGuest) {
		t.Fatal("guest scope missed guest")
	}
	if !(&Revocation{WorkspaceID: "w1", Scope: ScopeGuests}).MatchesIdentity(idPending) {
		t.Fatal("guest scope must fail closed on unresolved role")
	}
	if !(&Revocation{WorkspaceID: "w1", Scope: ScopeNonMembers, MemberUserIDs: []string{"u1"}}).MatchesIdentity(id) == false {
		// u1 IS a member: must NOT match.
		t.Log("ok")
	}
	if (&Revocation{WorkspaceID: "w1", Scope: ScopeNonMembers, MemberUserIDs: []string{"u1"}}).MatchesIdentity(id) {
		t.Fatal("member matched non-members scope")
	}
	if !(&Revocation{WorkspaceID: "w1", Scope: ScopeNonMembers, MemberUserIDs: []string{"u1"}}).MatchesIdentity(idGuest) {
		t.Fatal("non-member missed")
	}
	if (&Revocation{WorkspaceID: "w1"}).MatchesIdentity(idOtherWS) {
		t.Fatal("workspace leak")
	}
	if !(&Revocation{WorkspaceID: "w1"}).MatchesIdentity(id) {
		t.Fatal("scope all missed")
	}
}
