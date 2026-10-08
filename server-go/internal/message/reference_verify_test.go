package message

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"raft.local/server-go/internal/channel"
)

// TestReferenceVerifierRunsOriginalManifestAndViewerReducer feeds REAL
// Go-produced wire JSON (message DTOs from the actual projection path and
// ordered viewer snapshots from the actual reaction mutations) through the
// original TS/Web sources via the owned Node runner in testdata/. The runner
// imports the frozen modules directly (packages/shared manifest +
// packages/web reactionReadModels reducer); nothing is re-implemented here.
//
// A missing node/tsx toolchain is a FAILURE, not a skip: this check is part
// of the M4 contract-freeze evidence.
func TestReferenceVerifierRunsOriginalManifestAndViewerReducer(t *testing.T) {
	repoRoot := findRepoRoot(t)
	bundled := buildReferenceVerifier(t, repoRoot)

	f := newFixture(t)
	f.seed()
	f.seedChannel(txGeneral, "general", channel.TypeChannel, txAlice, txBob)
	msg := f.sendMsg(t, txGeneral, "reference verify")

	// Real ordered snapshots: add, add, remove, re-add (repeated payload,
	// strictly increasing versions) then a stale replay is asserted by the
	// expected verdict list.
	alice := claimsFor(txAlice, txFamAlice)
	type snap struct {
		ServerID      string   `json:"serverId"`
		MessageID     string   `json:"messageId"`
		ViewerVersion int64    `json:"viewerVersion"`
		ReactedEmojis []string `json:"reactedEmojis"`
	}
	var snapshots []snap
	collect := func() {
		t.Helper()
		state, _, err := f.store.ViewerSnapshot(context.Background(), NewClaims(alice), txWS, msg.ID)
		if err != nil {
			t.Fatal(err)
		}
		snapshots = append(snapshots, snap{
			ServerID: txWS, MessageID: msg.ID,
			ViewerVersion: state.ViewerVersion,
			ReactedEmojis: state.ReactedEmojis,
		})
	}
	for _, step := range []struct {
		add   bool
		emoji string
	}{
		{true, "a"}, {true, "b"}, {false, "b"}, {true, "b"},
	} {
		var err error
		if step.add {
			_, err = f.store.AddReaction(context.Background(), NewClaims(alice), txWS, msg.ID, step.emoji)
		} else {
			_, err = f.store.RemoveReaction(context.Background(), NewClaims(alice), txWS, msg.ID, step.emoji)
		}
		if err != nil {
			t.Fatal(err)
		}
		collect()
	}
	// Replays the ORIGINAL reducer must classify: the ordered sequence is
	// applied/applied/applied/applied; a stale repeat of snapshot #2 must be
	// "stale"; repeating the final snapshot must be "duplicate" (same
	// version, same payload — never equal-version-different-payload).
	seq := map[string]any{
		"principalId": txAlice,
		"snapshots":   append(snapshots, snapshots[1], snapshots[len(snapshots)-1]),
		"expected":    []string{"applied", "applied", "applied", "applied", "stale", "duplicate"},
	}

	// Real message DTOs from the same projection the HTTP surface renders.
	page, err := f.store.ListChannelPage(context.Background(), NewClaims(alice), txWS, txGeneral, PageQuery{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	seqRaw, err := json.Marshal(seq)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "viewer_sequence.json"), seqRaw, 0o644); err != nil {
		t.Fatal(err)
	}
	for i, dto := range page.DTOs {
		raw, err := json.Marshal(dto)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("message_%03d.json", i)), raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	out, err := exec.Command("node", bundled, dir).CombinedOutput()
	if err != nil {
		t.Fatalf("reference verifier failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "REFERENCE-VERIFY-OK") {
		t.Fatalf("reference verifier did not confirm: %s", out)
	}
}

// buildReferenceVerifier bundles the runner plus the ORIGINAL TS modules
// with the workspace's own esbuild, so plain node executes it without any
// TS service or daemon (the sandbox forbids local socket listeners).
func buildReferenceVerifier(t *testing.T, repoRoot string) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Fatalf("node is required for the reference verifier: %v", err)
	}
	esbuild := findEsbuild(t, repoRoot)
	bundled := filepath.Join(t.TempDir(), "reference_verify.bundle.mjs")
	cmd := exec.Command(esbuild,
		filepath.Join("internal", "message", "testdata", "reference_verify.mjs"),
		"--bundle", "--platform=node", "--format=esm",
		"--outfile="+bundled)
	cmd.Dir = filepath.Join(repoRoot, "server-go")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("esbuild bundle failed: %v\n%s", err, out)
	}
	return bundled
}

// findEsbuild locates the workspace's esbuild CLI under .pnpm.
func findEsbuild(t *testing.T, repoRoot string) string {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(repoRoot, "node_modules", ".pnpm", "esbuild@*", "node_modules", "esbuild", "bin", "esbuild"))
	if err != nil || len(matches) == 0 {
		t.Fatalf("workspace esbuild not found: %v", err)
	}
	return matches[len(matches)-1]
}

// findRepoRoot walks up from the working directory to the pnpm workspace root.
func findRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 6; i++ {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("pnpm workspace root not found")
	return ""
}
