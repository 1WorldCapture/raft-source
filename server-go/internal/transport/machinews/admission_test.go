package machinews

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/coder/websocket"

	"raft.local/server-go/internal/computer"
)

// provisionConnectedEnv seeds one workspace + attached computer, brings its
// machine online through a real handshake and returns the live socket.
func provisionConnectedEnv(t *testing.T) (*testEnv, string, string, *websocket.Conn) {
	t.Helper()
	env := newTestEnv(t, nil)
	env.seedUser("owner")
	env.seedWorkspace("ws", "ws", "owner")
	env.seedMembership("ws", "owner", "owner")
	computerID, machineID, apiKey := env.seedComputer("owner", "ws", "Laptop")
	ws := env.dial(apiKey)
	t.Cleanup(func() { _ = ws.CloseNow() })
	readFrameExpect(t, ws, "machine:context")
	sendJSON(t, ws, map[string]any{"type": "ready", "runtimes": []string{"claude"}})
	env.waitFor("ready persisted", func() bool { return env.readyCount() == 1 })
	sendFrame(t, ws, `{"type":"ping"}`)
	readFrameExpect(t, ws, "ping")
	env.waitFor("machine online", func() bool { return env.hub.IsOnline(machineID) })
	return env, computerID, machineID, ws
}

func TestSendWithAdmissionRequiresCallback(t *testing.T) {
	env, _, machineID, _ := provisionConnectedEnv(t)
	payload := map[string]any{"type": "agent:deliver", "agentId": "a1"}
	// Nil admission fails closed even for an online machine.
	if err := env.hub.SendWithAdmission(context.Background(), machineID, payload, nil); !errors.Is(err, errAdmissionRequired) {
		t.Fatalf("nil admission accepted: %v", err)
	}
	// Missing machines keep the typed offline refusal, also with a callback.
	if err := env.hub.SendWithAdmission(context.Background(), "m_missing", payload,
		func(context.Context, computer.Principal, func() error) error {
			t.Fatal("admission ran for a missing machine")
			return nil
		}); err == nil {
		t.Fatal("missing machine dispatched")
	}
}

func TestSendWithAdmissionHoldsSlotThroughCallback(t *testing.T) {
	env, _, machineID, _ := provisionConnectedEnv(t)
	payload := map[string]any{"type": "agent:deliver", "agentId": "a1", "seq": 1}
	entered := make(chan struct{})
	finish := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- env.hub.SendWithAdmission(context.Background(), machineID, payload,
			func(_ context.Context, _ computer.Principal, enqueue func() error) error {
				close(entered)
				<-finish // hold the callback (and the slot) until the test says so
				return enqueue()
			})
	}()
	<-entered
	competing := make(chan error, 1)
	go func() {
		competing <- env.hub.Send(context.Background(), machineID,
			map[string]any{"type": "agent:stop", "agentId": "a1"})
	}()
	// While the admission callback holds the slot, a competing Send must not
	// complete — the guard covers the callback THROUGH the enqueue.
	select {
	case err := <-competing:
		t.Fatalf("competing Send completed while admission held the slot: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	close(finish)
	if err := <-done; err != nil {
		t.Fatalf("admission dispatch: %v", err)
	}
	select {
	case err := <-competing:
		if err != nil {
			t.Fatalf("competing Send after release: %v", err)
		}
	case <-time.After(dialWait):
		t.Fatal("competing Send never completed after release")
	}
}

func TestSendWithAdmissionBarrierRevocationBeforeEnqueueRefuses(t *testing.T) {
	env, computerID, machineID, _ := provisionConnectedEnv(t)
	payload := map[string]any{"type": "agent:deliver", "agentId": "a1", "seq": 7}
	refusal := errors.New("agent_removed_from_channel")

	// The revocation-to-send race the dispatcher must close: AFTER the
	// prepare step and BEFORE enqueue, the authorization facts change. The
	// callback re-reads them (here: the machine principal itself is revoked)
	// and refuses — zero frames queued.
	sent := make(chan error, 1)
	go func() {
		sent <- env.hub.SendWithAdmission(context.Background(), machineID, payload,
			func(ctx context.Context, p computer.Principal, enqueue func() error) error {
				mustExec(t, env.db, `UPDATE computers SET revoked_at = ? WHERE id = ?`,
					env.clock.Now().UnixMilli(), computerID)
				if err := env.store.ValidatePrincipal(ctx, p); computer.AsAuthError(err) == nil {
					// Not revoked (or an infrastructure error we cannot
					// classify): refuse rather than enqueue unverified.
					return refusal
				}
				return refusal
			})
	}()
	if err := <-sent; !errors.Is(err, refusal) {
		t.Fatalf("revocation barrier did not refuse inside admission: %v", err)
	}

	// A subsequent dispatch never reaches the callback: the revoked
	// principal is denied at revalidation, before admission runs.
	called := false
	err := env.hub.SendWithAdmission(context.Background(), machineID, payload,
		func(context.Context, computer.Principal, func() error) error {
			called = true
			return nil
		})
	if err == nil || computer.AsAuthError(err) == nil {
		t.Fatalf("revoked principal admitted: %v", err)
	}
	if called {
		t.Fatal("admission ran for a revoked principal")
	}
}

func TestSendWithAdmissionRejectsRetiredConnection(t *testing.T) {
	env, _, machineID, _ := provisionConnectedEnv(t)
	// Retire the published connection out-of-band (the in-package test can
	// reach the slot): dispatch must refuse instead of queueing onto a
	// connection a replacement already displaced.
	s := env.hub.slotExisting(machineID)
	s.Lock()
	c := s.conn
	s.Unlock()
	if c == nil {
		t.Fatal("no published connection")
	}
	c.markRetired()
	payload := map[string]any{"type": "agent:deliver", "agentId": "a1"}
	err := env.hub.SendWithAdmission(context.Background(), machineID, payload,
		func(context.Context, computer.Principal, func() error) error {
			return errors.New("must not be called")
		})
	if err == nil || !errors.Is(err, ErrMachineOffline) {
		t.Fatalf("retired connection accepted: %v", err)
	}
}

func TestSendWithAdmissionEnqueueDeliversExactPayload(t *testing.T) {
	env, _, machineID, ws := provisionConnectedEnv(t)
	payload := map[string]any{"type": "agent:deliver", "agentId": "a1", "seq": 3, "deliveryId": "occ-1"}
	principalSeen := ""
	err := env.hub.SendWithAdmission(context.Background(), machineID, payload,
		func(_ context.Context, p computer.Principal, enqueue func() error) error {
			principalSeen = p.MachineID
			return enqueue()
		})
	if err != nil {
		t.Fatal(err)
	}
	if principalSeen != machineID {
		t.Fatalf("principal is not the authenticated machine identity: %q", principalSeen)
	}
	frame := readFrameExpect(t, ws, "agent:deliver")
	if frame["deliveryId"] != "occ-1" || frame["agentId"] != "a1" {
		t.Fatalf("payload mutated: %v", frame)
	}
}
