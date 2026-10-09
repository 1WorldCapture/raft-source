package app

// Build failure-path cleanup regressions (architecture review R9): every exit
// after db.Open must flow through one reverse-order unwind — the realtime
// runtime, then the control plane, then the database handle, then the global
// authority fence entry — so no fence entry outlives its database and no
// control worker can touch an already-closed handle.

import (
	"os"
	"path/filepath"
	"testing"

	"raft.local/server-go/internal/platform/config"
	"raft.local/server-go/internal/platform/db"
)

// TestBuildFailureReleasesAuthorityFence drives a real post-open failure (the
// outbox mailer cannot create its directory because the configured path sits
// under a regular file) and asserts the failed Build leaves no authority
// fence entry behind. Before this fix the mailer branch closed the handle but
// never released the fence entry db.Open had registered.
func TestBuildFailureReleasesAuthorityFence(t *testing.T) {
	dataDir := t.TempDir()
	// A regular file where a directory is required: MkdirAll underneath it
	// fails with ENOTDIR only after the database is already open.
	blocker := filepath.Join(dataDir, "outbox-blocker")
	if err := os.WriteFile(blocker, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t, dataDir)
	cfg.MailMode = config.MailModeOutbox
	cfg.OutboxDir = filepath.Join(blocker, "outbox")

	before := db.AuthorityFenceCount()
	if _, err := Build(Options{Config: cfg}); err == nil {
		t.Fatal("an unusable outbox path must fail the build")
	}
	if after := db.AuthorityFenceCount(); after != before {
		t.Fatalf("a failed Build leaked an authority fence entry: before=%d after=%d", before, after)
	}
}

// TestBuildCloseIsFenceNeutral proves the success path hands the fence entry
// to App.Close, that Build+Close is net zero on registered entries, and that
// both are repeatable: the build/close cycle runs twice and each Close runs
// twice to re-verify close idempotency releases the entry exactly once.
func TestBuildCloseIsFenceNeutral(t *testing.T) {
	before := db.AuthorityFenceCount()
	for range 2 {
		built, err := Build(Options{Config: testConfig(t, t.TempDir())})
		if err != nil {
			t.Fatal(err)
		}
		if !db.AuthorityFenceHeld(built.DB) {
			t.Fatal("an assembled app must hold exactly one authority fence entry")
		}
		for range 2 {
			if err := built.Close(); err != nil {
				t.Fatal(err)
			}
		}
		if db.AuthorityFenceHeld(built.DB) {
			t.Fatal("Close must release the authority fence entry")
		}
	}
	if after := db.AuthorityFenceCount(); after != before {
		t.Fatalf("Build+Close must be net zero on authority fence entries: before=%d after=%d", before, after)
	}
}
