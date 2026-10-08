package machinews

import "testing"

func TestFailedReconnectRestoresPendingOfflineProjection(t *testing.T) {
	env := newTestEnv(t, nil)
	machineID, key, first := dialLegacy(t, env)
	env.waitCond("first connection published", func() bool { return env.hub.IsOnline(machineID) })
	closeQuietly(first)
	slot := env.hub.slotExisting(machineID)
	env.waitCond("first disconnect scheduled", func() bool {
		slot.Lock()
		defer slot.Unlock()
		return slot.conn == nil && slot.pending == nil && slot.offline != nil
	})

	entered := make(chan struct{})
	release := make(chan struct{})
	env.hub.testBeforePublish = func(id string) {
		if id != machineID {
			return
		}
		close(entered)
		<-release
	}
	t.Cleanup(func() { closeReady(release) })
	second := env.dial(key)
	defer closeQuietly(second)
	readFrameExpect(t, second, "machine:context")
	<-entered

	// The new handshake has displaced the old disconnect timer, but has
	// never become a published connection. Cancel this handshake before
	// its write transaction so publish fails deterministically.
	slot.Lock()
	pending := slot.pending
	suspended := slot.displaced
	slot.Unlock()
	if pending == nil || suspended == nil {
		t.Fatal("pending reconnect lost the previous offline projection")
	}
	pending.cancel()
	close(release)
	// Drain the closing socket so its net.Pipe peer can join cleanly.
	_ = expectClose(t, second)
	env.waitCond("offline projection restored after failed publish", func() bool {
		slot.Lock()
		defer slot.Unlock()
		return slot.pending == nil && slot.conn == nil && slot.offline == suspended
	})
	env.advance(env.hub.cfg.DisconnectGrace)
	env.waitCond("restored offline callback", func() bool { return env.disconnectCount() == 1 })
	if env.hub.IsOnline(machineID) {
		t.Fatal("failed reconnect reported online")
	}
	row := env.machineRow(machineID)
	if row.lastStatus.String != "offline" {
		t.Fatalf("stored status = %v, want offline after failed reconnect", row.lastStatus)
	}
	env.advance(2 * env.hub.cfg.DisconnectGrace)
	if env.disconnectCount() != 1 {
		t.Fatal("restored offline transition ran more than once")
	}
}
