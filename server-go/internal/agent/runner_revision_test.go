package agent

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"raft.local/server-go/internal/computer"
)

func TestRunnerWriteGuardRejectsCredentialRotation(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		name := "computer"
		if legacy {
			name = "legacy-machine"
		}
		t.Run(name, func(t *testing.T) {
			f := openRunnerFixture(t)
			binding := f.binding
			table, id := "computers", "comp"
			if legacy {
				binding = f.authenticatedBinding(t, "", "mach")
				table, id = "machines", "mach"
			}
			ctx := context.Background()
			minted, err := f.access.Mint(ctx, binding, f.agentID, []string{"read"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			_, replacement, _, err := computer.GenerateComputerKeyMaterial(computer.Argon2Config{
				MemoryKiB: 16, Iterations: 1, Parallelism: 1,
			})
			if err != nil {
				t.Fatal(err)
			}
			// The first mint read has already accepted the old principal. A
			// changed verifier at the final write guard must still deny it.
			f.access.beforeGuard = func(ctx context.Context, tx *sql.Tx) error {
				_, err := tx.ExecContext(ctx, "UPDATE "+table+" SET api_key_hash = ? WHERE id = ?", replacement, id)
				return err
			}
			if _, err := f.access.Mint(ctx, binding, f.agentID, []string{"read"}, nil); AsError(err) != ErrRunnerComputerDenied {
				t.Fatalf("mint with a rotated verifier: %v", err)
			}
			if f.credentialCount(t, f.agentID) != 1 {
				t.Fatal("old credential minted a new Agent key after rotation")
			}
			if err := f.access.Revoke(ctx, binding, f.agentID, minted.CredentialID); AsError(err) != ErrRunnerComputerDenied {
				t.Fatalf("revoke with a rotated verifier: %v", err)
			}
			var revoked sql.NullInt64
			if err := f.db.QueryRow(`SELECT revoked_at FROM agent_credentials WHERE id = ?`, minted.CredentialID).Scan(&revoked); err != nil {
				t.Fatal(err)
			}
			if revoked.Valid {
				t.Fatal("unauthorized revocation committed")
			}

			// Also cover a real committed rotation between HTTP authentication
			// and a later domain read, without relying on the transaction hook.
			f.access.beforeGuard = nil
			if _, err := f.db.Exec("UPDATE "+table+" SET api_key_hash = ? WHERE id = ?", replacement, id); err != nil {
				t.Fatal(err)
			}
			if _, err := f.access.List(ctx, binding, "server"); AsError(err) != ErrRunnerComputerDenied {
				t.Fatalf("list after committed rotation: %v", err)
			}
			if err := f.access.Authorize(ctx, binding, true); AsError(err) != ErrRunnerComputerDenied {
				t.Fatalf("authorize after committed rotation: %v", err)
			}
		})
	}
}

func TestRunnerRequiresOriginalAuthenticatedPrincipal(t *testing.T) {
	f := openRunnerFixture(t)
	ctx := context.Background()
	cases := map[string]func(*RunnerBinding){
		"missing proof":       func(b *RunnerBinding) { b.Principal = computer.Principal{} },
		"missing revision":    func(b *RunnerBinding) { b.Principal.CredentialRevision = "" },
		"wrong workspace":     func(b *RunnerBinding) { b.WorkspaceID = "ws-b" },
		"wrong machine":       func(b *RunnerBinding) { b.MachineID = "mach-b" },
		"wrong computer":      func(b *RunnerBinding) { b.ComputerID = "comp-b" },
		"forged legacy alias": func(b *RunnerBinding) { b.LegacyMachine = true },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			binding := f.binding
			mutate(&binding)
			if _, err := f.access.Mint(ctx, binding, f.agentID, nil, nil); AsError(err) != ErrRunnerComputerDenied {
				t.Fatalf("unproved runner binding accepted: %v", err)
			}
		})
	}
	if f.credentialCount(t, f.agentID) != 0 {
		t.Fatal("invalid bindings minted credentials")
	}
}

func TestRunnerNameMatchesUTF16Boundary(t *testing.T) {
	for _, text := range []string{strings.Repeat("😀", 100), strings.Repeat("a", 198) + "😀"} {
		if err := ValidateRunnerName(&text); err != nil {
			t.Fatalf("200 UTF-16 units rejected: %v", err)
		}
	}
	for _, text := range []string{strings.Repeat("😀", 101), strings.Repeat("a", 199) + "😀"} {
		if AsError(ValidateRunnerName(&text)) != ErrRunnerNameInvalid {
			t.Fatal("overlong UTF-16 name accepted")
		}
	}
}
