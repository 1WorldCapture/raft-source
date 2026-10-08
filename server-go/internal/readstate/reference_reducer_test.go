package readstate

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// TestActivityWireAcceptedByReferenceReducer executes the ORIGINAL sync-core
// Activity reducer (packages/sync-core/src) over wire envelopes this package
// actually produced, closing the loop the contract demands: the TypeScript
// types existing is not evidence, the reducer consuming the real bytes is.
//
// The Go side writes a behavior-style envelope to a temp file; a small TS
// driver (also written to temp) imports the production createSyncCore +
// activity domain through tsx from the repository root and reports outcomes.
// The test skips honestly when node/tsx are unavailable.
func TestActivityWireAcceptedByReferenceReducer(t *testing.T) {
	repoRoot := findRepoRoot(t)
	tsx := filepath.Join(repoRoot, "node_modules", ".bin", "tsx")
	nodeBin, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node not available: %v", err)
	}
	if _, err := os.Stat(tsx); err != nil {
		t.Skipf("tsx not installed in the workspace: %v", err)
	}
	if runtime.GOOS == "windows" {
		tsx += ".cmd"
	}

	fx := newFixture(t)
	fx.seedThreadParents()
	fx.insertMessage(fxGeneral, fxBob, "one")
	fx.insertMessage(fxSecret, fxBob, "two", fxAlice)
	fx.follow(fxAlice, fxThread, false)
	fx.insertMessage(fxThread, fxBob, "reply", fxAlice)

	snapshot, err := fx.store.ActivitySnapshot(fx.ctx(), fx.claims[fxAlice], fxWS, SnapshotQuery{RequestID: "ref-1", Filter: ActivityFilterAll})
	if err != nil {
		t.Fatal(err)
	}
	difference, err := fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
		RequestID: "ref-2", Filter: ActivityFilterAll, Epoch: snapshot.Epoch, AfterWatermark: snapshot.Watermark})
	if err != nil {
		t.Fatal(err)
	}
	if difference.Status != 200 || difference.NotModified == nil {
		t.Fatalf("expected an initial notModified after the snapshot, got %+v", difference)
	}
	// One more fact so the difference branch carries real rows.
	fx.insertMessage(fxGeneral, fxBob, "three")
	difference, err = fx.store.ActivityDifference(fx.ctx(), fx.claims[fxAlice], fxWS, DifferenceQuery{
		RequestID: "ref-3", Filter: ActivityFilterAll, Epoch: snapshot.Epoch, AfterWatermark: snapshot.Watermark})
	if err != nil {
		t.Fatal(err)
	}
	if difference.Status != 200 || difference.Difference == nil || len(difference.Difference.Rows) == 0 {
		t.Fatalf("difference did not carry rows: %+v", difference)
	}

	envelope := map[string]any{
		"caseId":      "go-readstate-wire-v1",
		"description": "wire produced by internal/readstate, consumed by the original reducer",
		"steps": []any{
			map[string]any{"stepId": "snapshot", "ingress": snapshotBody(snapshot)},
			map[string]any{"stepId": "difference", "ingress": differenceBody(difference.Difference)},
		},
	}

	dir := t.TempDir()
	envelopePath := filepath.Join(dir, "envelope.json")
	buf, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(envelopePath, buf, 0o600); err != nil {
		t.Fatal(err)
	}

	script := `
import { readFileSync } from "node:fs";
import { createSyncCore } from "__CORE_PATH__";
import { createActivityDomain, encodeActivityScopeId } from "__ACTIVITY_PATH__";

const envelope = JSON.parse(readFileSync(process.argv[2], "utf8"));
const core = createSyncCore({ domains: [createActivityDomain()] });
const report = { steps: [], violations: [] };
for (const step of envelope.steps) {
  const ingress = step.ingress;
  const scopeId = encodeActivityScopeId({
    serverId: ingress.scope.serverId,
    principalId: ingress.scope.principalId,
    filter: ingress.scope.filter,
    windowId: ingress.scope.windowId,
  });
  let outcome;
  if (ingress.type === "snapshot") {
    outcome = core.ingestSnapshot("activity", {
      scopeId,
      watermark: BigInt(ingress.watermark),
      epoch: ingress.epoch,
      state: ingress,
    });
  } else if (ingress.type === "difference") {
    outcome = core.ingestDifference("activity", {
      scopeId,
      epoch: ingress.epoch,
      fromSeq: BigInt(ingress.fromSeq),
      toSeq: BigInt(ingress.toSeq),
      events: [{ seq: BigInt(ingress.toSeq), event: { ...ingress, type: "frame" } }],
    });
  } else {
    throw new Error("unexpected ingress type " + ingress.type);
  }
  if (outcome && outcome.kind === "violation") {
    report.violations.push(outcome.violation);
  }
  report.steps.push({ stepId: step.stepId, kind: outcome?.kind ?? "applied" });
}
const activityState = core.state("activity", scopeIdOfStep(envelope.steps[0].ingress));
report.statePresent = activityState !== undefined;
report.violations = core.violations().items ?? [];
function scopeIdOfStep(ingress) {
  return encodeActivityScopeId({
    serverId: ingress.scope.serverId,
    principalId: ingress.scope.principalId,
    filter: ingress.scope.filter,
    windowId: ingress.scope.windowId,
  });
}
console.log(JSON.stringify(report));
`
	corePath := filepath.ToSlash(filepath.Join(repoRoot, "packages", "sync-core", "src", "core.ts"))
	activityPath := filepath.ToSlash(filepath.Join(repoRoot, "packages", "sync-core", "src", "domains", "activity.ts"))
	script = replaceAll(script, "__CORE_PATH__", corePath)
	script = replaceAll(script, "__ACTIVITY_PATH__", activityPath)
	scriptPath := filepath.Join(dir, "driver.mts")
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}

	// The tsx CLI launcher creates an IPC pipe the sandbox forbids; the
	// --import registration form runs the same transform without it.
	cmd := exec.Command(nodeBin, "--import", "tsx", scriptPath, envelopePath)
	cmd.Dir = repoRoot
	out, err := cmd.CombinedOutput()
	if err != nil {
		scriptDump, _ := os.ReadFile(scriptPath)
		t.Fatalf("reference reducer execution failed: %v\n%s\n--- script ---\n%s", err, out, scriptDump)
	}
	var report struct {
		Steps []struct {
			StepID string `json:"stepId"`
			Kind   string `json:"kind"`
		} `json:"steps"`
		Violations   []any `json:"violations"`
		StatePresent bool  `json:"statePresent"`
	}
	if err := json.Unmarshal(lastJSONLine(out), &report); err != nil {
		t.Fatalf("decode reducer report %q: %v", string(out), err)
	}
	if len(report.Steps) != 2 {
		t.Fatalf("reducer steps = %+v", report.Steps)
	}
	for _, step := range report.Steps {
		if step.StepID == "" || step.Kind == "violation" {
			t.Fatalf("reducer rejected a step: %+v", report.Steps)
		}
	}
	if len(report.Violations) != 0 {
		t.Fatalf("reducer reported violations: %+v", report.Violations)
	}
	if !report.StatePresent {
		t.Fatal("reducer did not materialize the Activity state from the Go wire")
	}
}

func snapshotBody(snapshot *ActivitySnapshotResult) map[string]any {
	return map[string]any{
		"type":            "snapshot",
		"requestId":       snapshot.RequestID,
		"scope":           snapshot.Scope,
		"epoch":           snapshot.Epoch,
		"watermark":       snapshot.Watermark,
		"activityVersion": snapshot.ActivityVersion,
		"window":          windowBody(snapshot.Window),
	}
}

func differenceBody(d *DifferenceResult) map[string]any {
	return map[string]any{
		"type":             "difference",
		"requestId":        d.RequestID,
		"scope":            d.Scope,
		"epoch":            d.Epoch,
		"fromSeq":          d.FromSeq,
		"toSeq":            d.ToSeq,
		"activityVersion":  d.ActivityVersion,
		"rows":             d.Rows,
		"tombstones":       d.Tombstones,
		"nextCursor":       d.NextCursor,
		"hasMore":          d.HasMore,
		"complete":         d.Complete,
		"totalCount":       d.TotalCount,
		"totalUnreadCount": d.TotalUnreadCount,
		"nextFromSeq":      nil,
	}
}

func windowBody(window ActivityWindowResult) map[string]any {
	var nextCursor any
	if window.NextCursor != nil {
		nextCursor = *window.NextCursor
	}
	return map[string]any{
		"rows":             window.Rows,
		"tombstones":       window.Tombstones,
		"nextCursor":       nextCursor,
		"hasMore":          window.HasMore,
		"complete":         window.Complete,
		"totalCount":       window.TotalCount,
		"totalUnreadCount": window.TotalUnreadCount,
	}
}

func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir
		}
		if _, err := os.Stat(filepath.Join(dir, "server-go", "go.mod")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("repository root not found")
	return ""
}

func replaceAll(haystack, needle, replacement string) string {
	out := ""
	for {
		idx := indexOfStr(haystack, needle)
		if idx < 0 {
			return out + haystack
		}
		out += haystack[:idx] + replacement
		haystack = haystack[idx+len(needle):]
	}
}

func indexOfStr(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

func jsonString(v string) string {
	buf, err := json.Marshal(v)
	if err != nil {
		return "\"" + v + "\""
	}
	return string(buf)
}

func lastJSONLine(out []byte) []byte {
	lines := splitLines(string(out))
	for i := len(lines) - 1; i >= 0; i-- {
		line := lines[i]
		if len(line) > 0 && line[0] == '{' {
			return []byte(line)
		}
	}
	return out
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	out = append(out, s[start:])
	return out
}
