package core

import "testing"

func TestRevocationGenerationCutoff(t *testing.T) {
	identity := Identity{
		UserID: "user", SessionFamilyID: "family", WorkspaceID: "workspace", ServerRole: "member",
		UserGeneration: 10, FamilyGeneration: 20, WorkspaceGeneration: 30,
	}
	cases := []struct {
		name       string
		revocation Revocation
		generation uint64
	}{
		{"user", Revocation{UserID: "user"}, 10},
		{"family-with-owner", Revocation{UserID: "user", SessionFamilyID: "family"}, 20},
		{"family-without-owner", Revocation{SessionFamilyID: "family"}, 20},
		{"workspace", Revocation{WorkspaceID: "workspace"}, 30},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			rv := test.revocation
			if err := rv.Validate(); err != nil {
				t.Fatal(err)
			}
			if !rv.MatchesIdentity(identity) {
				t.Fatal("zero cutoff must preserve explicit unconditional revocation")
			}
			for _, cutoff := range []uint64{test.generation - 1, test.generation} {
				rv.BeforeGeneration = cutoff
				if rv.MatchesIdentity(identity) {
					t.Fatalf("cutoff %d matched equal/newer admitted generation %d", cutoff, test.generation)
				}
			}
			rv.BeforeGeneration = test.generation + 1
			if !rv.MatchesIdentity(identity) {
				t.Fatal("new committed generation must evict an older identity")
			}
		})
	}
}

func TestDeletedFamilyRevocationScopeValidationAndIsolation(t *testing.T) {
	rv := Revocation{SessionFamilyID: "deleted-family", BeforeGeneration: 2}
	if err := rv.Validate(); err != nil {
		t.Fatal(err)
	}
	if !rv.MatchesIdentity(Identity{UserID: "user", SessionFamilyID: "deleted-family", FamilyGeneration: 1}) {
		t.Fatal("family tombstone must match without a resolvable owner")
	}
	if rv.MatchesIdentity(Identity{UserID: "user", SessionFamilyID: "independent-family", FamilyGeneration: 1}) {
		t.Fatal("family tombstone evicted another login of the same user")
	}
	for _, invalid := range []Revocation{
		{SessionFamilyID: "f", WorkspaceID: "w"},
		{SessionFamilyID: "f", Scope: ScopeGuests},
		{SessionFamilyID: "f", MemberUserIDs: []string{"u"}},
		{BeforeGeneration: 2},
	} {
		if err := invalid.Validate(); err == nil {
			t.Fatalf("invalid mixed/empty authority scope accepted: %+v", invalid)
		}
	}
}
