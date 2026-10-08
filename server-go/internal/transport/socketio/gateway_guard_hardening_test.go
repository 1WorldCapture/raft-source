package socketio

// Deterministic regressions for the M4 F3 admission-contract hardening:
// rooms:joined, sync:resume:response and heartbeat frames are admitted
// INSIDE opts.Guard (check+use atomic with authority commits), guard
// acquisition is bounded and cancellable, and no guard is ever held across
// the ChannelRooms / SyncVisible / WorkspaceSeq provider reads. All tests
// drive the existing seams only (fakeGuard-family stubs, MemFence,
// fakeTransport/providers); no clock sleeps decide outcomes.

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"raft.local/server-go/internal/transport/socketio/core"
)

// ---- guard stubs --------------------------------------------------------

// armGuard models the production guard's semantics: the context is checked
// BEFORE the critical section (like db.WithAuthorityReadContext's
// authorityFence.enter), then fn runs. Until armed it is a plain
// pass-through; once armed each call may bump state before fn (pre), skip
// fn entirely (refuse), or block until the caller's context is done
// (block). Tests arm it only after the handshake guard call finished, so
// every subsequent call is exactly the emission under test.
type armGuard struct {
	mu     sync.Mutex
	calls  int
	armed  bool
	pre    func() // runs inside the guard, before fn
	refuse error  // armed + non-nil: returned WITHOUT running fn
	block  bool   // armed: wait for ctx.Done(), return its error, skip fn
}

func (a *armGuard) Guard(ctx context.Context, fn func() error) error {
	a.mu.Lock()
	a.calls++
	armed, pre, refuse, block := a.armed, a.pre, a.refuse, a.block
	a.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if !armed {
		return fn()
	}
	if block {
		<-ctx.Done()
		return ctx.Err()
	}
	if refuse != nil {
		return refuse
	}
	if pre != nil {
		pre()
	}
	return fn()
}

func (a *armGuard) count() int      { a.mu.Lock(); defer a.mu.Unlock(); return a.calls }
func (a *armGuard) armNow()         { a.mu.Lock(); a.armed = true; a.mu.Unlock() }
func (a *armGuard) setPre(f func()) { a.mu.Lock(); a.pre = f; a.mu.Unlock() }

// deadlineSpyGuard records the deadline state its critical sections ran
// with, proving which context the gateway handed to the guard.
type deadlineSpyGuard struct {
	mu        sync.Mutex
	deadlines []time.Time
	saw       []bool
}

func (d *deadlineSpyGuard) Guard(ctx context.Context, fn func() error) error {
	dl, ok := ctx.Deadline()
	d.mu.Lock()
	d.deadlines = append(d.deadlines, dl)
	d.saw = append(d.saw, ok)
	d.mu.Unlock()
	return fn()
}

func (d *deadlineSpyGuard) recorded() ([]time.Time, []bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]time.Time(nil), d.deadlines...), append([]bool(nil), d.saw...)
}

// activeGuard tracks whether its critical section is currently running, so
// provider probes can assert they are NEVER entered under the guard.
type activeGuard struct {
	active atomic.Bool
}

func (a *activeGuard) Guard(ctx context.Context, fn func() error) error {
	a.active.Store(true)
	defer a.active.Store(false)
	return fn()
}

// roomsProbe records whether the guard was active when ChannelRooms ran.
type roomsProbe struct {
	inner InitialRoomsResolver
	g     *activeGuard
	saw   atomic.Bool
}

func (p *roomsProbe) ChannelRooms(ctx context.Context, id core.Identity) ([]string, error) {
	p.saw.Store(p.g.active.Load())
	return p.inner.ChannelRooms(ctx, id)
}

// resumeProbe records whether the guard was active when SyncVisible ran.
type resumeProbe struct {
	inner ResumeProvider
	g     *activeGuard
	saw   atomic.Bool
}

func (p *resumeProbe) SyncVisible(ctx context.Context, id core.Identity, lastSeq int64, maxMessages int, byteBudget int64) (ResumePage, error) {
	p.saw.Store(p.g.active.Load())
	return p.inner.SyncVisible(ctx, id, lastSeq, maxMessages, byteBudget)
}

// heartbeatProbe records whether the guard was active when WorkspaceSeq ran.
type heartbeatProbe struct {
	inner HeartbeatSource
	g     *activeGuard
	saw   atomic.Bool
}

func (p *heartbeatProbe) WorkspaceSeq(ctx context.Context, ws string) (int64, error) {
	p.saw.Store(p.g.active.Load())
	return p.inner.WorkspaceSeq(ctx, ws)
}

func hasEvent(ft *fakeTransport, id, event string) bool {
	for _, f := range ft.frames(id) {
		if f.Event == event {
			return true
		}
	}
	return false
}

// ---- rooms:joined admission ----------------------------------------------

func TestRoomsJoinedAdmissionRunsInsideGuard(t *testing.T) {
	g, ft, _, _ := newTestGateway(t, nil)
	guard := &fakeGuard{}
	g.opts.Guard = guard
	if _, err := admitWS(t, g, "c1", "u1", "w1", "u1/f1"); err != nil {
		t.Fatal(err)
	}
	g.Opened("c1")
	waitUntil(t, time.Second, func() bool { return hasEvent(ft, "c1", core.EventRoomsJoined) }, "rooms:joined missing")
	// Exactly two guarded sections: the admission handshake and the
	// rooms:joined emission. The old unguarded barrier left this at 1.
	if guard.count() != 2 {
		t.Fatalf("guard calls = %d want 2 (admission + rooms:joined)", guard.count())
	}
	if s := g.Snapshot(); s.Guarded != 2 {
		t.Fatalf("Guarded = %d want 2", s.Guarded)
	}
}

func TestRoomsJoinedStaleAuthorityDeniedInsideGuard(t *testing.T) {
	g, ft, _, fence := newTestGateway(t, nil)
	guard := &armGuard{}
	g.opts.Guard = guard
	if _, err := admitWS(t, g, "c1", "u1", "w1", "u1/f1"); err != nil {
		t.Fatal(err)
	}
	// From here on every guarded section observes a committed workspace
	// revocation before its check: the rooms:joined admission must refuse.
	guard.setPre(func() { fence.Bump(core.WorkspaceFenceScope("w1")) })
	guard.armNow()
	g.Opened("c1")
	waitUntil(t, time.Second, func() bool { return ft.closeCount("c1") >= 1 }, "stale-authorized barrier emission did not disconnect")
	if hasEvent(ft, "c1", core.EventRoomsJoined) {
		t.Fatal("rooms:joined admitted under a committed revocation")
	}
	if s := g.Snapshot(); s.GuardAbandoned != 0 {
		t.Fatalf("deny misrouted as abandon: %+v", s)
	}
}

func TestRoomsJoinedGuardAbandonedFailsClosed(t *testing.T) {
	g, ft, _, _ := newTestGateway(t, nil)
	guard := &armGuard{refuse: context.DeadlineExceeded}
	g.opts.Guard = guard
	if _, err := admitWS(t, g, "c1", "u1", "w1", "u1/f1"); err != nil {
		t.Fatal(err)
	}
	guard.armNow()
	g.Opened("c1")
	waitUntil(t, time.Second, func() bool { return ft.closeCount("c1") >= 1 }, "abandoned rooms:joined admission did not fail closed")
	if hasEvent(ft, "c1", core.EventRoomsJoined) {
		t.Fatal("rooms:joined emitted without a guarded admission")
	}
	if s := g.Snapshot(); s.GuardAbandoned != 1 || s.BarrierFailed != 0 {
		t.Fatalf("counters: %+v", s)
	}
}

func TestRoomBarrierGuardWaitBoundedByBarrierContext(t *testing.T) {
	// The barrier context (RoomSetupTimeout) bounds the guard wait: a
	// wedged fence fails the barrier closed within the configured timeout
	// instead of pinning the barrier goroutine forever.
	g, ft, _, _ := newTestGateway(t, func(o *Options) { o.RoomSetupTimeout = 80 * time.Millisecond })
	guard := &armGuard{block: true}
	g.opts.Guard = guard
	if _, err := admitWS(t, g, "c1", "u1", "w1", "u1/f1"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	guard.armNow()
	g.Opened("c1")
	waitUntil(t, 2*time.Second, func() bool { return ft.closeCount("c1") >= 1 }, "blocked guard did not fail the barrier closed")
	if elapsed := time.Since(start); elapsed > 1500*time.Millisecond {
		t.Fatalf("barrier waited %v despite RoomSetupTimeout=80ms", elapsed)
	}
	if hasEvent(ft, "c1", core.EventRoomsJoined) {
		t.Fatal("rooms:joined emitted while the guard never admitted it")
	}
	if s := g.Snapshot(); s.GuardAbandoned != 1 {
		t.Fatalf("GuardAbandoned = %d want 1", s.GuardAbandoned)
	}
}

// ---- sync:resume:response admission --------------------------------------

func TestResumeAdmissionRunsInsideGuard(t *testing.T) {
	g, ft, _, _ := newTestGateway(t, nil)
	g.opts.Resume = &fakeResume{pages: map[int64]ResumePage{10: {
		Messages: []json.RawMessage{json.RawMessage(`{"id":"m11","seq":11}`)}, Seqs: []int64{11}, CurrentSeq: 11,
	}}}
	guard := &fakeGuard{}
	g.opts.Guard = guard
	openReady(t, g, ft, "c1", "u1", "w1", "u1/f1")
	before := guard.count() // admission + rooms:joined
	g.InboundEvent(context.Background(), "c1", core.EventSyncResume, []json.RawMessage{json.RawMessage(`{"lastSeq":10}`)})
	waitUntil(t, time.Second, func() bool { return hasEvent(ft, "c1", core.EventSyncResumeResp) }, "resume response missing")
	// The old unguarded handler never touched the guard for the response.
	if guard.count() != before+1 {
		t.Fatalf("guard calls = %d want %d (response admission guarded)", guard.count(), before+1)
	}
}

func TestResumeStaleAuthorityDeniedInsideGuard(t *testing.T) {
	g, ft, _, fence := newTestGateway(t, nil)
	g.opts.Resume = &fakeResume{pages: map[int64]ResumePage{10: {
		Messages: []json.RawMessage{json.RawMessage(`{"id":"m11","seq":11}`)}, Seqs: []int64{11}, CurrentSeq: 11,
	}}}
	guard := &armGuard{}
	g.opts.Guard = guard
	openReady(t, g, ft, "c1", "u1", "w1", "u1/f1")
	guard.setPre(func() { fence.Bump(core.UserFenceScope("u1")) })
	guard.armNow()
	g.InboundEvent(context.Background(), "c1", core.EventSyncResume, []json.RawMessage{json.RawMessage(`{"lastSeq":10}`)})
	waitUntil(t, time.Second, func() bool { return ft.closeCount("c1") >= 1 }, "stale-authorized resume response did not disconnect")
	if hasEvent(ft, "c1", core.EventSyncResumeResp) {
		t.Fatal("sync:resume:response admitted under a committed revocation")
	}
}

func TestResumeGuardAbandonedFailsClosed(t *testing.T) {
	g, ft, _, _ := newTestGateway(t, nil)
	g.opts.Resume = &fakeResume{pages: map[int64]ResumePage{10: {
		Messages: []json.RawMessage{json.RawMessage(`{"id":"m11","seq":11}`)}, Seqs: []int64{11}, CurrentSeq: 11,
	}}}
	guard := &armGuard{refuse: context.Canceled}
	g.opts.Guard = guard
	openReady(t, g, ft, "c1", "u1", "w1", "u1/f1")
	guard.armNow()
	g.InboundEvent(context.Background(), "c1", core.EventSyncResume, []json.RawMessage{json.RawMessage(`{"lastSeq":10}`)})
	waitUntil(t, time.Second, func() bool { return ft.closeCount("c1") >= 1 }, "abandoned resume admission did not fail closed")
	if hasEvent(ft, "c1", core.EventSyncResumeResp) {
		t.Fatal("resume response emitted without a guarded admission")
	}
	s := g.Snapshot()
	if s.GuardAbandoned != 1 || s.ResumeDenied != 1 {
		t.Fatalf("counters: %+v", s)
	}
}

// ---- heartbeat admission --------------------------------------------------

func TestHeartbeatAdmissionRunsInsideGuard(t *testing.T) {
	g, ft, _, _ := newTestGateway(t, nil)
	g.opts.Heartbeat = &fakeHeartbeat{seqs: map[string]int64{"w1": 7}}
	guard := &fakeGuard{}
	g.opts.Guard = guard
	openReady(t, g, ft, "c1", "u1", "w1", "u1/f1")
	before := guard.count() // admission + rooms:joined
	g.heartbeatTick()
	waitUntil(t, time.Second, func() bool { return hasEvent(ft, "c1", core.EventHeartbeat) }, "heartbeat missing")
	// One guarded section per workspace batch; the old sweep enqueued
	// unguarded.
	if guard.count() != before+1 {
		t.Fatalf("guard calls = %d want %d", guard.count(), before+1)
	}
}

func TestHeartbeatStaleAuthorityDeniedInsideGuard(t *testing.T) {
	g, ft, _, fence := newTestGateway(t, nil)
	g.opts.Heartbeat = &fakeHeartbeat{seqs: map[string]int64{"w1": 7}}
	guard := &armGuard{}
	g.opts.Guard = guard
	openReady(t, g, ft, "c1", "u1", "w1", "u1/f1")
	guard.setPre(func() { fence.Bump(core.WorkspaceFenceScope("w1")) })
	guard.armNow()
	g.heartbeatTick()
	waitUntil(t, time.Second, func() bool { return ft.closeCount("c1") >= 1 }, "stale-authorized heartbeat did not disconnect")
	if hasEvent(ft, "c1", core.EventHeartbeat) {
		t.Fatal("heartbeat admitted under a committed revocation")
	}
}

func TestHeartbeatGuardAbandonedSkipsTickWithoutDisconnect(t *testing.T) {
	// Heartbeats are periodic telemetry: an abandoned admission skips the
	// tick (self-healing, revocation eviction still applies) instead of
	// disconnecting every connection while the fence is saturated.
	g, ft, _, _ := newTestGateway(t, nil)
	g.opts.Heartbeat = &fakeHeartbeat{seqs: map[string]int64{"w1": 7}}
	guard := &armGuard{refuse: context.DeadlineExceeded}
	g.opts.Guard = guard
	openReady(t, g, ft, "c1", "u1", "w1", "u1/f1")
	guard.armNow()
	g.heartbeatTick()
	waitUntil(t, time.Second, func() bool { return g.Snapshot().GuardAbandoned == 1 }, "abandoned heartbeat not counted")
	if hasEvent(ft, "c1", core.EventHeartbeat) {
		t.Fatal("heartbeat emitted without a guarded admission")
	}
	if ft.closeCount("c1") != 0 {
		t.Fatalf("abandoned heartbeat tick disconnected the connection: %d", ft.closeCount("c1"))
	}
}

// ---- publish guard cancellation -------------------------------------------

func TestPublishContextCanceledAbandonsBeforeOffer(t *testing.T) {
	g, ft, _, _ := newTestGateway(t, nil)
	guard := &armGuard{}
	g.opts.Guard = guard
	openReady(t, g, ft, "c1", "u1", "w1", "u1/f1")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	g.PublishContext(ctx, []string{core.ChannelRoom("ch1")}, core.EventMessageNew, map[string]int{"i": 1})
	waitUntil(t, time.Second, func() bool { return g.Snapshot().GuardAbandoned == 1 }, "canceled publish not counted as abandoned")
	if hasEvent(ft, "c1", core.EventMessageNew) {
		t.Fatal("frame offered after the guard was abandoned")
	}
	if ft.closeCount("c1") != 0 {
		t.Fatalf("abandoned publish disconnected the connection: %d", ft.closeCount("c1"))
	}
}

func TestPublishWhereContextCanceledAbandonsBeforeOffer(t *testing.T) {
	g, ft, _, _ := newTestGateway(t, nil)
	guard := &armGuard{}
	g.opts.Guard = guard
	openReady(t, g, ft, "c1", "u1", "w1", "u1/f1")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	g.PublishWhereContext(ctx, core.EventReadState, map[string]int{"v": 1}, func(core.Identity) bool { return true })
	waitUntil(t, time.Second, func() bool { return g.Snapshot().GuardAbandoned == 1 }, "canceled predicate publish not counted as abandoned")
	if hasEvent(ft, "c1", core.EventReadState) {
		t.Fatal("frame offered after the guard was abandoned")
	}
}

func TestPublishGuardAcquisitionBoundedWithoutCallerDeadline(t *testing.T) {
	g, _, _, _ := newTestGateway(t, nil)
	spy := &deadlineSpyGuard{}
	g.opts.Guard = spy
	// Legacy wrapper: no caller deadline, so withGuard must impose
	// guardAcquireTimeout — an unbounded fence wait is a stuck publisher.
	g.Publish([]string{core.ChannelRoom("ch1")}, "probe:event", map[string]int{"i": 1})
	// Caller-bound deadline passes through verbatim.
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(30*time.Second))
	defer cancel()
	g.PublishContext(ctx, []string{core.ChannelRoom("ch1")}, "probe:event", map[string]int{"i": 2})
	deadlines, saw := spy.recorded()
	if len(deadlines) != 2 {
		t.Fatalf("recorded %d guard calls want 2", len(deadlines))
	}
	if !saw[0] {
		t.Fatal("legacy Publish reached the guard without any deadline bound")
	}
	if slack := time.Until(deadlines[0]); slack > guardAcquireTimeout+time.Second || slack < guardAcquireTimeout-time.Second {
		t.Fatalf("legacy Publish guard deadline = %v (want ~%v)", deadlines[0], guardAcquireTimeout)
	}
	want, _ := ctx.Deadline()
	if !saw[1] || !deadlines[1].Equal(want) {
		t.Fatalf("caller deadline not passed through: got %v want %v", deadlines[1], want)
	}
}

// ---- guard never spans provider reads -------------------------------------

func TestNoGuardHeldAcrossProviderReads(t *testing.T) {
	g, ft, _, _ := newTestGateway(t, nil)
	guard := &activeGuard{}
	g.opts.Guard = guard
	rooms := &roomsProbe{inner: &fakeRooms{rooms: []string{"channel:ch1"}}, g: guard}
	resume := &resumeProbe{inner: &fakeResume{pages: map[int64]ResumePage{10: {
		Messages: []json.RawMessage{json.RawMessage(`{"id":"m11","seq":11}`)}, Seqs: []int64{11}, CurrentSeq: 11,
	}}}, g: guard}
	heart := &heartbeatProbe{inner: &fakeHeartbeat{seqs: map[string]int64{"w1": 3}}, g: guard}
	g.opts.ChannelRooms = rooms
	g.opts.Resume = resume
	g.opts.Heartbeat = heart

	openReady(t, g, ft, "c1", "u1", "w1", "u1/f1") // exercises ChannelRooms
	g.InboundEvent(context.Background(), "c1", core.EventSyncResume, []json.RawMessage{json.RawMessage(`{"lastSeq":10}`)})
	waitUntil(t, time.Second, func() bool { return hasEvent(ft, "c1", core.EventSyncResumeResp) }, "resume response missing")
	g.heartbeatTick() // exercises WorkspaceSeq

	if rooms.saw.Load() {
		t.Fatal("admission guard held across the ChannelRooms provider read")
	}
	if resume.saw.Load() {
		t.Fatal("admission guard held across the SyncVisible provider read")
	}
	if heart.saw.Load() {
		t.Fatal("admission guard held across the WorkspaceSeq provider read")
	}
}
