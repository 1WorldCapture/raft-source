package runtimecatalog

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"raft.local/server-go/internal/computer"
)

type scriptGateway struct {
	mu     sync.Mutex
	online bool
	sent   chan any
	err    error
}

func (g *scriptGateway) IsOnline(string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.online
}

func (g *scriptGateway) Send(_ context.Context, _ string, payload any) error {
	g.mu.Lock()
	err := g.err
	g.mu.Unlock()
	if err != nil {
		return err
	}
	g.sent <- payload
	return nil
}

type manualClock struct {
	mu    sync.Mutex
	now   time.Time
	waits []manualWait
}

type manualWait struct {
	at time.Time
	ch chan time.Time
}

func newManualClock() *manualClock {
	return &manualClock{now: time.Date(2026, 10, 8, 8, 0, 0, 0, time.UTC)}
}

func (c *manualClock) After(d time.Duration) (<-chan time.Time, func()) {
	ch := make(chan time.Time, 1)
	c.mu.Lock()
	c.waits = append(c.waits, manualWait{at: c.now.Add(d), ch: ch})
	c.mu.Unlock()
	return ch, func() {}
}

func (c *manualClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	var keep []manualWait
	var fire []chan time.Time
	now := c.now
	for _, wait := range c.waits {
		if wait.at.After(c.now) {
			keep = append(keep, wait)
			continue
		}
		fire = append(fire, wait.ch)
	}
	c.waits = keep
	c.mu.Unlock()
	for _, ch := range fire {
		ch <- now
	}
}

func TestDetectBindsReplyAndRejectsForgedPrincipal(t *testing.T) {
	gw := &scriptGateway{online: true, sent: make(chan any, 1)}
	var generation uint64 = 7
	broker := NewBroker(BrokerConfig{
		Gateway: gw,
		Generation: func(string) (uint64, bool) {
			return generation, true
		},
		Clock: newManualClock(),
	})
	type result struct {
		outcome Outcome
		err     error
	}
	done := make(chan result, 1)
	go func() {
		outcome, err := broker.DetectModels(context.Background(), Target{MachineID: "machine-1", WorkspaceID: "ws-1"}, "codex")
		done <- result{outcome, err}
	}()
	sent := (<-gw.sent).(detectPayload)
	if sent.Type != messageDetect || sent.Runtime != "codex" || sent.RequestID == "" {
		t.Fatalf("detect payload = %+v", sent)
	}
	forged := resultFrame(sent.RequestID, `{"kind":"live","value":{"models":[{"id":"forged","label":"Forged"}]}}`)
	handled, err := broker.OnMachineMessage(context.Background(), computer.Principal{MachineID: "machine-2", WorkspaceID: "ws-1"}, forged)
	if !handled || !errors.Is(err, ErrForgedReply) {
		t.Fatalf("forged machine handled=%v err=%v", handled, err)
	}
	handled, err = broker.OnMachineMessage(context.Background(), computer.Principal{MachineID: "machine-1", WorkspaceID: "ws-2"}, forged)
	if !handled || !errors.Is(err, ErrForgedReply) {
		t.Fatalf("forged workspace handled=%v err=%v", handled, err)
	}
	select {
	case got := <-done:
		t.Fatalf("forged reply completed the wait: %+v %v", got.outcome, got.err)
	default:
	}
	real := resultFrame(sent.RequestID, `{"kind":"live","value":{"models":[{"id":"machine-model","label":"From computer"}],"default":"machine-model"}}`)
	handled, err = broker.OnMachineMessage(context.Background(), computer.Principal{MachineID: "machine-1", WorkspaceID: "ws-1"}, real)
	if !handled || err != nil {
		t.Fatalf("real reply handled=%v err=%v", handled, err)
	}
	got := <-done
	if got.err != nil || got.outcome.Kind != "live" || len(got.outcome.Value.Models) != 1 || got.outcome.Value.Models[0].ID != "machine-model" {
		t.Fatalf("accepted forged or empty catalog: %+v %v", got.outcome, got.err)
	}
}

func TestDetectGenerationChangeAndDisconnectDoNotSucceed(t *testing.T) {
	gw := &scriptGateway{online: true, sent: make(chan any, 1)}
	var generation uint64 = 1
	broker := NewBroker(BrokerConfig{
		Gateway:    gw,
		Generation: func(string) (uint64, bool) { return generation, true },
		Clock:      newManualClock(),
	})
	done := make(chan error, 1)
	go func() {
		_, err := broker.DetectModels(context.Background(), Target{MachineID: "machine-1", WorkspaceID: "ws-1"}, "codex")
		done <- err
	}()
	sent := (<-gw.sent).(detectPayload)
	generation = 2
	handled, err := broker.OnMachineMessage(context.Background(), computer.Principal{MachineID: "machine-1", WorkspaceID: "ws-1"}, resultFrame(sent.RequestID, `{"kind":"live","value":{"models":[{"id":"stale","label":"Stale"}]}}`))
	if !handled || !errors.Is(err, ErrStale) {
		t.Fatalf("stale handled=%v err=%v", handled, err)
	}
	if got := <-done; !errors.Is(got, ErrStale) {
		t.Fatalf("wait err = %v", got)
	}

	go func() {
		_, err := broker.DetectModels(context.Background(), Target{MachineID: "machine-1", WorkspaceID: "ws-1"}, "codex")
		done <- err
	}()
	<-gw.sent
	broker.Disconnect("machine-1")
	if got := <-done; !errors.Is(got, ErrDisconnected) {
		t.Fatalf("disconnect err = %v", got)
	}
}

func TestDetectTimeoutAndOfflineDoNotInventModels(t *testing.T) {
	clock := newManualClock()
	gw := &scriptGateway{online: true, sent: make(chan any, 1)}
	broker := NewBroker(BrokerConfig{
		Gateway:    gw,
		Generation: func(string) (uint64, bool) { return 1, true },
		Clock:      clock,
	})
	done := make(chan error, 1)
	go func() {
		_, err := broker.DetectModels(context.Background(), Target{MachineID: "machine-1", WorkspaceID: "ws-1"}, "codex")
		done <- err
	}()
	<-gw.sent
	clock.Advance(DetectionTimeout("codex"))
	if got := <-done; !errors.Is(got, ErrTimeout) {
		t.Fatalf("timeout err = %v", got)
	}

	gw.mu.Lock()
	gw.online = false
	gw.mu.Unlock()
	if _, err := broker.DetectModels(context.Background(), Target{MachineID: "machine-1", WorkspaceID: "ws-1"}, "claude"); !errors.Is(err, ErrOffline) {
		t.Fatalf("offline err = %v", err)
	}
	select {
	case payload := <-gw.sent:
		t.Fatalf("offline detect sent %#v", payload)
	default:
	}
	if err := broker.Rescan(context.Background(), "machine-1"); !errors.Is(err, ErrOffline) {
		t.Fatalf("offline rescan err = %v", err)
	}
}

func TestLegacyUnsupportedUsesStaticSourceOnlyAfterAReply(t *testing.T) {
	raw := []byte(`{"type":"machine:runtime_models:result","requestId":"r","error":"unsupported"}`)
	live := ProjectRuntimeModelResult(raw, "claude", 100)
	if live.Kind != "live" || len(live.Value.Models) != len(staticRuntimeModels["claude"].models) {
		t.Fatalf("claude static = %+v", live)
	}
	if live.Value.Models[0].Verified != "launchable" {
		t.Fatalf("claude verified = %s", live.Value.Models[0].Verified)
	}
	gemini := ProjectRuntimeModelResult(raw, "gemini", 100)
	if gemini.Kind != "live" || gemini.Value.Models[1].Verified != "suggestion_only" {
		t.Fatalf("gemini = %+v", gemini)
	}
	other := ProjectRuntimeModelResult(raw, "codex", 100)
	if other.Kind != "unsupported" {
		t.Fatalf("codex unsupported = %+v", other)
	}
	typed := ProjectRuntimeModelResult([]byte(`{"type":"machine:runtime_models:result","requestId":"r","outcome":{"kind":"unsupported"},"error":"unsupported"}`), "claude", 100)
	if typed.Kind != "unsupported" {
		t.Fatalf("typed outcome must win: %+v", typed)
	}
}

func TestPendingCapAndOversizedResult(t *testing.T) {
	gw := &scriptGateway{online: true, sent: make(chan any, 2)}
	broker := NewBroker(BrokerConfig{
		Gateway:         gw,
		Generation:      func(string) (uint64, bool) { return 1, true },
		Clock:           newManualClock(),
		MaxPending:      1,
		MaxPerMachine:   1,
		MaxMessageBytes: 32,
	})
	done := make(chan error, 1)
	go func() {
		_, err := broker.DetectModels(context.Background(), Target{MachineID: "m", WorkspaceID: "w"}, "codex")
		done <- err
	}()
	<-gw.sent
	if _, err := broker.DetectModels(context.Background(), Target{MachineID: "m", WorkspaceID: "w"}, "codex"); !errors.Is(err, ErrBusy) {
		t.Fatalf("busy err = %v", err)
	}
	broker.Disconnect("m")
	<-done
	handled, err := broker.OnMachineMessage(context.Background(), computer.Principal{MachineID: "m", WorkspaceID: "w"}, []byte(`{"type":"machine:runtime_models:result","requestId":"x","models":[{"id":"too-big"}]}`))
	if !handled || !errors.Is(err, ErrMalformed) {
		t.Fatalf("oversized handled=%v err=%v", handled, err)
	}
	handled, err = broker.OnMachineMessage(context.Background(), computer.Principal{}, []byte(`{"type":"agent:status","agentId":"a"}`))
	if handled || err != nil {
		t.Fatalf("foreign frame handled=%v err=%v", handled, err)
	}
}

func resultFrame(requestID, outcome string) json.RawMessage {
	return json.RawMessage(`{"type":"machine:runtime_models:result","requestId":"` + requestID + `","outcome":` + outcome + `}`)
}
