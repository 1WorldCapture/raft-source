//go:build reference

package workspace

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// TestM2TSProjectorReference is invoked by workspaces-reference.mjs, which
// executes the unchanged baseline TS projector to generate expected results.
// The build tag keeps Node and repository-source availability out of ordinary
// Go unit tests and out of the standalone server's runtime dependencies.
func TestM2TSProjectorReference(t *testing.T) {
	fixturePath := os.Getenv("RAFT_M2_PROJECTOR_REFERENCE")
	if fixturePath == "" {
		t.Fatal("run node tests/acceptance/workspaces-reference.mjs to provide the executed TS reference")
	}
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		SourceBaseline string `json:"sourceBaseline"`
		SourceSHA256   string `json:"sourceSHA256"`
		Cases          []struct {
			Label string `json:"label"`
			State struct {
				ServerID         string  `json:"serverId"`
				UserID           string  `json:"userId"`
				Status           string  `json:"status"`
				CompletionReason *string `json:"completionReason"`
				ContractVersion  string  `json:"contractVersion"`
			} `json:"state"`
			Live     SetupLiveFacts `json:"live"`
			Expected map[string]any `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.SourceBaseline != "c4a5015deb7dcc8b800df96675d899f384f76e36" || fixture.SourceSHA256 != "d1df92725f9a0abbf0789d23f400120fba4d98acd5c430fd7c6808bb371cb7e7" {
		t.Fatal("reference fixture was not produced from the reviewed TS baseline")
	}
	if len(fixture.Cases) != 1216 {
		t.Fatalf("expected all 1216 reference cases, received %d", len(fixture.Cases))
	}
	for _, tc := range fixture.Cases {
		state := SetupState{
			WorkspaceID: tc.State.ServerID, UserID: tc.State.UserID,
			Status: tc.State.Status, CompletionReason: tc.State.CompletionReason,
			ContractVersion: tc.State.ContractVersion,
		}
		wire, err := json.Marshal(ProjectServerSetup(state, tc.Live))
		if err != nil {
			t.Fatalf("%s: marshal Go projection: %v", tc.Label, err)
		}
		var got map[string]any
		if err := json.Unmarshal(wire, &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, tc.Expected) {
			want, _ := json.Marshal(tc.Expected)
			t.Fatalf("%s: TS/Go projection mismatch\nGo: %s\nTS: %s", tc.Label, wire, want)
		}
	}
	t.Logf("Compared %d executed TS reference cases with the Go pure projector", len(fixture.Cases))
}
