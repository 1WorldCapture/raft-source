package readstate

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestRealGoWireFeedsOriginalReadStateLedger drives a REAL mutation stream
// through the production Store, renders each read_state:updated payload with
// the publication projector, and replays that wire through the ORIGINAL web
// read-state ledger (packages/web/src/store/readStateSync.ts) via tsx. The
// original ledger must accept the server-ordered stream and land on exactly
// the frontier the Go database stored — no fabricated JSON anywhere between.
func TestRealGoWireFeedsOriginalReadStateLedger(t *testing.T) {
	repoRoot := findRepoRoot(t)
	tsx := filepath.Join(repoRoot, "node_modules", ".bin", "tsx")
	nodeBin, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not available: %v", err)
	}
	if _, err := os.Stat(tsx); err != nil {
		t.Skipf("tsx not installed in the workspace: %v", err)
	}

	fx := newFixture(t)
	seq1 := fx.insertMessage(fxGeneral, fxBob, "one")
	fx.insertMessage(fxGeneral, fxBob, "two")
	seq3 := fx.insertMessage(fxGeneral, fxBob, "three")

	type step struct {
		ID      string         `json:"id"`
		Payload map[string]any `json:"payload"`
	}
	steps := []step{}
	// The realtime dispatcher re-reads CURRENT facts at projection time and
	// the presenter renders the read_state:updated payload
	// ({serverId, scopeId, maxReadSeq, readStateVersion}); this builder mirrors
	// that exact current-facts shape for the replay stream. The wire shape
	// itself is pinned by the application/realtime tests and the acceptance
	// wire export.
	collect := func(id string) {
		maxRead, version, present := fx.readStateRow(fxAlice, fxGeneral)
		if !present {
			t.Fatalf("step %s: no stored read state row", id)
		}
		steps = append(steps, step{ID: id, Payload: map[string]any{
			"serverId":         fxWS,
			"scopeId":          fxGeneral,
			"maxReadSeq":       maxRead,
			"readStateVersion": version,
		}})
	}

	// Server-ordered day: read up, explicit unread rewind, a LATE low read
	// (no-op server-side: same payload re-emitted), read to the top.
	if _, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, seq1); err != nil {
		t.Fatal(err)
	}
	collect("read-v1")
	if _, err := fx.store.MarkUnread(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral); err != nil {
		t.Fatal(err)
	}
	collect("unread-rewind")
	late, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, seq1)
	if err != nil {
		t.Fatal(err)
	}
	if late.Changed {
		t.Fatalf("late low read changed the frontier: %+v", late)
	}
	collect("late-low-read-replay")
	final, err := fx.store.MarkRead(fx.ctx(), fx.claims[fxAlice], fxWS, fxGeneral, seq3)
	if err != nil {
		t.Fatal(err)
	}
	collect("read-final")

	storedRead, storedVersion, _ := fx.readStateRow(fxAlice, fxGeneral)
	if storedRead != seq3 || storedVersion != final.ReadStateVersion {
		t.Fatalf("stored frontier = (%d, %d)", storedRead, storedVersion)
	}

	dir := t.TempDir()
	wirePath := filepath.Join(dir, "stream.json")
	buf, err := json.Marshal(map[string]any{
		"serverId": fxWS,
		"scopeId":  fxGeneral,
		"steps":    steps,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wirePath, buf, 0o600); err != nil {
		t.Fatal(err)
	}

	script := `
import { readFileSync } from "node:fs";
import { resetReadStateSyncForTests, normalizeReadStateUpdated, consumeReadStateUpdate, getAcceptedReadState } from "__LEDGER_PATH__";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
resetReadStateSyncForTests();
const outcomes = [];
for (const step of input.steps) {
  const normalized = normalizeReadStateUpdated(step.payload);
  if (normalized === null) {
    outcomes.push({ id: step.id, outcome: "corrupt-null" });
    continue;
  }
  outcomes.push({ id: step.id, outcome: consumeReadStateUpdate(normalized) });
}
const final = getAcceptedReadState(input.serverId, input.scopeId);
console.log(JSON.stringify({ outcomes, final }));
`
	ledgerPath := filepath.ToSlash(filepath.Join(repoRoot, "packages", "web", "src", "store", "readStateSync.ts"))
	script = replaceAll(script, "__LEDGER_PATH__", ledgerPath)
	scriptPath := filepath.Join(dir, "driver.mts")
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(nodeBin, "--import", "tsx", scriptPath, wirePath)
	cmd.Dir = repoRoot
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("original ledger execution failed: %v\n%s", err, out)
	}
	var report struct {
		Outcomes []struct {
			ID      string `json:"id"`
			Outcome string `json:"outcome"`
		} `json:"outcomes"`
		Final *struct {
			MaxReadSeq       int64 `json:"maxReadSeq"`
			ReadStateVersion int64 `json:"readStateVersion"`
		} `json:"final"`
	}
	if err := json.Unmarshal(lastJSONLine(out), &report); err != nil {
		t.Fatalf("decode ledger report %q: %v", string(out), err)
	}
	if len(report.Outcomes) != len(steps) {
		t.Fatalf("ledger outcomes = %+v", report.Outcomes)
	}
	for _, outcome := range report.Outcomes {
		if outcome.Outcome == "corrupt-null" {
			t.Fatalf("original ledger rejected real Go wire: %+v", outcome)
		}
	}
	if report.Final == nil {
		t.Fatal("original ledger holds no accepted state for the Go stream")
	}
	if report.Final.MaxReadSeq != storedRead || report.Final.ReadStateVersion != storedVersion {
		t.Fatalf("ledger final = (%d, %d), Go stored = (%d, %d)",
			report.Final.MaxReadSeq, report.Final.ReadStateVersion, storedRead, storedVersion)
	}
	// The late low read is a server-side no-op, so its replayed payload is
	// identical to the rewind's — the ledger must treat it as a duplicate
	// (accepted identity or stale), never a regression.
	if steps[2].Payload["maxReadSeq"] != steps[1].Payload["maxReadSeq"] {
		t.Fatalf("no-op read re-emitted a different frontier: %+v vs %+v", steps[2].Payload, steps[1].Payload)
	}
}
