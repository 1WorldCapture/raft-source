package runtimecatalog

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"raft.local/server-go/internal/computer"
)

const (
	messageDetect = "machine:runtime_models:detect"
	messageResult = "machine:runtime_models:result"
	messageRescan = "machine:runtimes:rescan"

	defaultMaxPending      = 32
	defaultMaxPerMachine   = 4
	defaultMaxMessageBytes = 1 << 20
	defaultMaxModels       = 2048

	cursorModelProbeTimeout = 20 * time.Second
	defaultDetectTimeout    = 5 * time.Second
)

// DetectionTimeout is the server wait for machine:runtime_models:result.
// Cursor keeps the TS probe budget plus transport slack; every other runtime
// gets five seconds.
func DetectionTimeout(runtime string) time.Duration {
	if runtime == "cursor-sdk" {
		return cursorModelProbeTimeout + 5*time.Second
	}
	return defaultDetectTimeout
}

// Gateway is the outbound machine seam. The MACHINEWS hub satisfies it
// (IsOnline + Send). The broker does not import the hub.
type Gateway interface {
	IsOnline(machineID string) bool
	Send(ctx context.Context, machineID string, payload any) error
}

// GenerationFunc reports the live connection generation. ok is false when
// that machine has no current connection. Parent wires Hub.Snapshot.
type GenerationFunc func(machineID string) (generation uint64, ok bool)

// Clock arms a cancellable wait. Production uses wallClock; tests advance a
// manual clock instead of sleeping.
type Clock interface {
	After(d time.Duration) (<-chan time.Time, func())
}

type wallClock struct{}

func (wallClock) After(d time.Duration) (<-chan time.Time, func()) {
	timer := time.NewTimer(d)
	return timer.C, func() { timer.Stop() }
}

// Target is the machine/workspace pair a reply must match.
type Target struct {
	MachineID   string
	WorkspaceID string
}

var (
	// ErrOffline means the Computer has no live connection. Callers must not
	// substitute a successful catalog.
	ErrOffline = errors.New("runtimecatalog: computer offline")
	// ErrTimeout means the Computer did not answer before the budget.
	ErrTimeout = errors.New("runtimecatalog: runtime model detect timed out")
	// ErrStale means the connection generation changed before the reply was
	// accepted.
	ErrStale = errors.New("runtimecatalog: catalog generation changed")
	// ErrDisconnected means the parent cancelled this machine's waits.
	ErrDisconnected = errors.New("runtimecatalog: computer disconnected")
	// ErrBusy means the pending-reply table is at its cap.
	ErrBusy = errors.New("runtimecatalog: too many pending runtime catalog requests")
	// ErrForgedReply means a result named our request id but came from a
	// different machine or workspace. The wait is left open.
	ErrForgedReply = errors.New("runtimecatalog: runtime catalog reply failed principal binding")
	// ErrMalformed means the frame was a runtime-catalog result we will not
	// treat as success.
	ErrMalformed = errors.New("runtimecatalog: malformed runtime catalog message")
	// ErrMiswired means Generation was not provided.
	ErrMiswired = errors.New("runtimecatalog: broker generation source is required")
)

// BrokerConfig wires the metadata RPC. Generation is required: a detect that
// cannot name the connection generation fails closed.
type BrokerConfig struct {
	Gateway         Gateway
	Generation      GenerationFunc
	Clock           Clock
	MaxPending      int
	MaxPerMachine   int
	MaxMessageBytes int
	MaxModels       int
}

// Broker is the bounded request/reply table for runtime metadata.
type Broker struct {
	gateway         Gateway
	generation      GenerationFunc
	clock           Clock
	maxPending      int
	maxPerMachine   int
	maxMessageBytes int
	maxModels       int

	mu      sync.Mutex
	pending map[string]*pendingDetect
}

type pendingDetect struct {
	id          string
	machineID   string
	workspaceID string
	runtime     string
	generation  uint64
	ch          chan detectResult
	once        sync.Once
}

type detectResult struct {
	outcome Outcome
	err     error
}

func (p *pendingDetect) deliver(result detectResult) {
	p.once.Do(func() { p.ch <- result })
}

// NewBroker builds an idle broker. Gateway and Generation may be nil only
// until the parent finishes wiring; Detect and Rescan then fail closed.
func NewBroker(cfg BrokerConfig) *Broker {
	maxPending := cfg.MaxPending
	if maxPending <= 0 {
		maxPending = defaultMaxPending
	}
	maxPer := cfg.MaxPerMachine
	if maxPer <= 0 {
		maxPer = defaultMaxPerMachine
	}
	maxBytes := cfg.MaxMessageBytes
	if maxBytes <= 0 {
		maxBytes = defaultMaxMessageBytes
	}
	maxModels := cfg.MaxModels
	if maxModels <= 0 {
		maxModels = defaultMaxModels
	}
	clk := cfg.Clock
	if clk == nil {
		clk = wallClock{}
	}
	return &Broker{
		gateway:         cfg.Gateway,
		generation:      cfg.Generation,
		clock:           clk,
		maxPending:      maxPending,
		maxPerMachine:   maxPer,
		maxMessageBytes: maxBytes,
		maxModels:       maxModels,
		pending:         map[string]*pendingDetect{},
	}
}

type detectPayload struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Runtime   string `json:"runtime"`
}

type rescanPayload struct {
	Type string `json:"type"`
}

// Rescan asks the Computer to re-detect installed runtimes. There is no
// reply; the next ready/capabilities push is the result. Offline does not
// report success.
func (b *Broker) Rescan(ctx context.Context, machineID string) error {
	if b.gateway == nil || b.generation == nil {
		return ErrMiswired
	}
	if !b.gateway.IsOnline(machineID) {
		return ErrOffline
	}
	if _, ok := b.generation(machineID); !ok {
		return ErrOffline
	}
	return b.gateway.Send(ctx, machineID, rescanPayload{Type: messageRescan})
}

// DetectModels sends machine:runtime_models:detect and waits for the matching
// result. The reply is accepted only from the same machine, workspace and
// connection generation that the request was bound to.
func (b *Broker) DetectModels(ctx context.Context, target Target, runtime string) (Outcome, error) {
	if b.gateway == nil || b.generation == nil {
		return Outcome{}, ErrMiswired
	}
	if target.MachineID == "" || target.WorkspaceID == "" {
		return Outcome{}, ErrOffline
	}
	if !b.gateway.IsOnline(target.MachineID) {
		return Outcome{}, ErrOffline
	}
	generation, ok := b.generation(target.MachineID)
	if !ok {
		return Outcome{}, ErrOffline
	}
	requestID, err := newRequestID()
	if err != nil {
		return Outcome{}, err
	}
	pending := &pendingDetect{
		id:          requestID,
		machineID:   target.MachineID,
		workspaceID: target.WorkspaceID,
		runtime:     runtime,
		generation:  generation,
		ch:          make(chan detectResult, 1),
	}
	if err := b.reserve(pending); err != nil {
		return Outcome{}, err
	}
	timer, stop := b.clock.After(DetectionTimeout(runtime))
	defer stop()
	sendErr := b.gateway.Send(ctx, target.MachineID, detectPayload{
		Type:      messageDetect,
		RequestID: requestID,
		Runtime:   runtime,
	})
	if sendErr != nil {
		if b.abandon(pending) {
			return Outcome{}, sendErr
		}
		return b.takeDelivered(pending)
	}
	select {
	case result := <-pending.ch:
		return result.outcome, result.err
	case <-timer:
		if b.abandon(pending) {
			return Outcome{}, ErrTimeout
		}
		return b.takeDelivered(pending)
	case <-ctx.Done():
		if b.abandon(pending) {
			return Outcome{}, ctx.Err()
		}
		return b.takeDelivered(pending)
	}
}

func (b *Broker) takeDelivered(pending *pendingDetect) (Outcome, error) {
	result := <-pending.ch
	return result.outcome, result.err
}

func (b *Broker) reserve(pending *pendingDetect) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.pending) >= b.maxPending {
		return ErrBusy
	}
	perMachine := 0
	for _, existing := range b.pending {
		if existing.machineID == pending.machineID {
			perMachine++
		}
	}
	if perMachine >= b.maxPerMachine {
		return ErrBusy
	}
	b.pending[pending.id] = pending
	return nil
}

// abandon removes the wait if it is still pending. False means a reply
// already took it and deliver is in progress or done.
func (b *Broker) abandon(pending *pendingDetect) bool {
	b.mu.Lock()
	current, ok := b.pending[pending.id]
	if ok && current == pending {
		delete(b.pending, pending.id)
		b.mu.Unlock()
		return true
	}
	b.mu.Unlock()
	return false
}

// Online reports a live connection that still has a generation. A nil
// gateway, a nil generation source, or a missing connection is offline.
// Generation must not call back into the broker.
func (b *Broker) Online(machineID string) bool {
	if b == nil || b.gateway == nil || b.generation == nil || machineID == "" {
		return false
	}
	if !b.gateway.IsOnline(machineID) {
		return false
	}
	_, ok := b.generation(machineID)
	return ok
}

// Disconnect cancels every wait bound to machineID. Parent calls this from
// the hub disconnect path so a dropped Computer cannot time out into a
// successful catalog.
func (b *Broker) Disconnect(machineID string) {
	b.mu.Lock()
	var doomed []*pendingDetect
	for id, pending := range b.pending {
		if pending.machineID == machineID {
			delete(b.pending, id)
			doomed = append(doomed, pending)
		}
	}
	b.mu.Unlock()
	for _, pending := range doomed {
		pending.deliver(detectResult{err: ErrDisconnected})
	}
}

// OnMachineMessage is the parent callback for hub OnMessage. handled is
// false for frames that are not runtime-catalog results. A forged result
// (right request id, wrong machine or workspace) returns an error and does
// not complete the wait. A generation change completes the wait as stale
// and discards the payload.
func (b *Broker) OnMachineMessage(ctx context.Context, principal computer.Principal, raw json.RawMessage) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	var peek struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &peek) != nil || peek.Type != messageResult {
		return false, nil
	}
	if len(raw) > b.maxMessageBytes {
		return true, ErrMalformed
	}
	var msg struct {
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(raw, &msg) != nil || msg.RequestID == "" {
		return true, ErrMalformed
	}
	b.mu.Lock()
	pending := b.pending[msg.RequestID]
	b.mu.Unlock()
	if pending == nil {
		return true, nil
	}
	if principal.MachineID != pending.machineID || principal.WorkspaceID != pending.workspaceID || principal.MachineID == "" || principal.WorkspaceID == "" {
		return true, ErrForgedReply
	}
	if b.generation == nil {
		return true, ErrMiswired
	}
	generation, ok := b.generation(pending.machineID)
	if !ok || generation != pending.generation {
		if b.settle(pending, detectResult{err: ErrStale}) {
			return true, ErrStale
		}
		return true, nil
	}
	outcome := ProjectRuntimeModelResult(raw, pending.runtime, b.maxModels)
	if !b.settle(pending, detectResult{outcome: outcome}) {
		return true, nil
	}
	return true, nil
}

func (b *Broker) settle(pending *pendingDetect, result detectResult) bool {
	b.mu.Lock()
	current, ok := b.pending[pending.id]
	if !ok || current != pending {
		b.mu.Unlock()
		return false
	}
	// Re-check generation under the same lock section as the delete so a
	// disconnect that already removed the wait cannot be overwritten, and a
	// generation change observed here discards the payload.
	if result.err == nil && b.generation != nil {
		generation, live := b.generation(pending.machineID)
		if !live || generation != pending.generation {
			delete(b.pending, pending.id)
			b.mu.Unlock()
			pending.deliver(detectResult{err: ErrStale})
			return true
		}
	}
	delete(b.pending, pending.id)
	b.mu.Unlock()
	pending.deliver(result)
	return true
}

func newRequestID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("runtimecatalog: request id: %w", err)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}
