package agentdelivery

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"raft.local/server-go/internal/agent"
)

// A bounded recovery query must advance past machines whose sends keep
// failing. Those reserved launches never change last_dispatch_at, so sorting
// every query from the beginning permanently hides machines past the limit.
func TestColdStartRecoveryScansBeyondFailedFirstPage(t *testing.T) {
	env := newColdEnv(t)
	ctx := context.Background()
	env.gw.mu.Lock()
	env.gw.online = false
	env.gw.mu.Unlock()

	const machines = startRecoverFetchLimit + 7
	launchByMachine := make(map[string]string, machines)
	for i := range machines {
		machineID := fmt.Sprintf("recovery-machine-%03d", i)
		agentID := fmt.Sprintf("recovery-agent-%03d", i)
		env.addMachine(machineID)
		env.addAgent(agentID, fmt.Sprintf("Recovery%03d", i), agent.StatusActive, "claude", machineID)
		row, err := env.d.svc.directory.GetAgent(ctx, agentID, false)
		if err != nil {
			t.Fatal(err)
		}
		launch, err := env.d.svc.agents.EnsureStartLaunch(ctx, row)
		if err != nil {
			t.Fatal(err)
		}
		launchByMachine[machineID] = launch.ID
	}
	// Equal timestamps exercise the machine-id keyset tie-breaker, not
	// accidental wall-clock ordering during fixture creation.
	env.exec(`UPDATE agent_launches SET created_at = ?`, time.Now().Add(-time.Minute).UnixMilli())
	env.gw.mu.Lock()
	env.gw.online = true
	env.gw.fail = errors.New("send queue full")
	env.gw.mu.Unlock()

	if !env.d.recoverUnconfirmedStarts(ctx) {
		t.Fatal("first recovery page reported no progress")
	}
	if got := len(env.gw.starts()); got != startLaunchMaxScan {
		t.Fatalf("one recovery pass sent %d starts, want the bounded maximum %d", got, startLaunchMaxScan)
	}
	env.d.scan(ctx)
	starts := env.gw.starts()
	if len(starts) != machines {
		t.Fatalf("recovery attempted %d/%d machines; a failed first page must not starve the rest", len(starts), machines)
	}
	seen := make(map[string]bool, machines)
	for _, start := range starts {
		if seen[start.machineID] {
			t.Fatalf("machine %s retried inside the backoff window", start.machineID)
		}
		seen[start.machineID] = true
		if start.command.LaunchID != launchByMachine[start.machineID] {
			t.Fatalf("recovery replaced the reserved launch for %s", start.machineID)
		}
		assertNoWake(t, start.command)
	}

	// An immediate full sweep must still obey per-machine retry spacing,
	// and discard expired spacing entries for machines absent from the DB.
	env.d.noteStartAttempt("retired-machine", time.Now().Add(-time.Minute))
	env.d.scan(ctx)
	if got := len(env.gw.starts()); got != machines {
		t.Fatalf("immediate rescan sent %d starts, want %d", got, machines)
	}
	env.d.startRecoverMu.Lock()
	_, retained := env.d.startRecoverNotBefore["retired-machine"]
	cursor := env.d.startRecoverAfter
	env.d.startRecoverMu.Unlock()
	if retained || cursor.machineID != "" {
		t.Fatalf("completed sweep retained expired spacing or a cursor: retained=%v cursor=%+v", retained, cursor)
	}
	var reserved int
	if err := env.db.QueryRow(`SELECT COUNT(*) FROM agent_launches
		WHERE state = 'reserved' AND dispatch_count = 0 AND confirmed_session_id IS NULL`).Scan(&reserved); err != nil {
		t.Fatal(err)
	}
	if reserved != machines {
		t.Fatalf("failed sends lost or changed reserved launch facts: %d/%d", reserved, machines)
	}
}
