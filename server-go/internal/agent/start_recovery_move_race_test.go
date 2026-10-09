package agent

import (
	"context"
	"testing"
	"time"
)

// The injected production clock provides a deterministic barrier AFTER the
// pending batch was read and BEFORE recovery reloads the live Agent. The
// move and new reservation use the real fenced services, not forged rows.
type recoveryMoveClock struct {
	at     time.Time
	before func()
}

func (c *recoveryMoveClock) Now() time.Time {
	if c.before != nil {
		fn := c.before
		c.before = nil // Nested timestamps during move/start must not reenter.
		fn()
	}
	return c.at
}

func TestStartRecoveryOldMachineCannotCancelNewLaunchAfterMove(t *testing.T) {
	handle, store, launches, service, gateway := newDispatchService(t)
	ctx := context.Background()
	if _, err := handle.Exec(`INSERT INTO machines (id, workspace_id, user_id, name, created_at)
		VALUES ('machine-2', 'ws', 'owner', 'new machine', 2)`); err != nil {
		t.Fatal(err)
	}
	row, err := store.GetAgent(ctx, "agent-1", false)
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.EnsureStartLaunch(ctx, row)
	if err != nil {
		t.Fatal(err)
	}
	persisted, err := launches.CurrentLaunch(ctx, "ws", "agent-1")
	if err != nil || persisted == nil || !persisted.LastDispatchAt.Valid {
		t.Fatalf("first dispatch must be persisted: %+v %v", persisted, err)
	}

	originalClock := launches.clock
	defer func() { launches.clock = originalClock }()
	var replacement *Launch
	launches.clock = &recoveryMoveClock{
		at: time.UnixMilli(persisted.LastDispatchAt.Int64 + StartResendBackoffMS + 1),
		before: func() {
			// RecoverPendingStarts already captured the old machine's batch.
			// The user moves the Agent and starts its replacement before the
			// recovery loop revalidates that captured row's current binding.
			machine := "machine-2"
			if err := store.AssignMachine(ctx, "ws", "agent-1", &machine); err != nil {
				t.Fatal(err)
			}
			fresh, err := store.GetAgent(ctx, "agent-1", false)
			if err != nil {
				t.Fatal(err)
			}
			replacement, err = service.EnsureStartLaunch(ctx, fresh)
			if err != nil {
				t.Fatal(err)
			}
		},
	}
	if err := service.RecoverPendingStarts(ctx, "machine-1"); err != nil {
		t.Fatal(err)
	}
	if replacement == nil || replacement.ID == first.ID {
		t.Fatal("the clock barrier did not create a real replacement generation")
	}
	current, err := launches.CurrentLaunch(ctx, "ws", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if current == nil || current.ID != replacement.ID || current.MachineID != "machine-2" || current.State != LaunchStateDispatched {
		t.Fatalf("old-machine recovery cancelled or replaced the new launch: current=%+v replacement=%+v", current, replacement)
	}
	var oldState string
	if err := handle.QueryRow(`SELECT state FROM agent_launches WHERE id = ?`, first.ID).Scan(&oldState); err != nil {
		t.Fatal(err)
	}
	if oldState != LaunchStateSuperseded {
		t.Fatalf("old recovery rewrote an already-terminal launch: %s", oldState)
	}
	if len(gateway.sent) != 2 {
		t.Fatalf("only the original and replacement starts may be sent, got %d", len(gateway.sent))
	}
}
