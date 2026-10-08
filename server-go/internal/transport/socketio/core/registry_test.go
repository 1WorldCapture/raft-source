package core

import (
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func newConn(id, user, ws, role string, fence *MemFence) *ConnState {
	return newConnFam(id, user, ws, role, "f1", fence)
}

func newConnFam(id, user, ws, role, family string, fence *MemFence) *ConnState {
	genu := fence.Generation(UserFenceScope(user))
	genf := uint64(0)
	if family != "" {
		genf = fence.Generation(FamilyFenceScope(family))
	}
	genw := uint64(0)
	if ws != "" {
		genw = fence.Generation(WorkspaceFenceScope(ws))
	}
	idt := Identity{UserID: user, SessionFamilyID: family, WorkspaceID: ws, ServerRole: role, UserGeneration: genu, FamilyGeneration: genf, WorkspaceGeneration: genw}
	return NewConnState(id, idt, NewOutboundQueue(8, 1<<20), NewLimiter(1000, 1000, nil), NewFenceView(fence, idt), httptest.NewRequest("GET", "/", nil), time.Unix(0, 0))
}

func TestRegistryPendingAndOpen(t *testing.T) {
	f := NewMemFence()
	r := NewConnRegistry()
	cs := newConn("c1", "u1", "w1", "member", f)
	r.AddPending(cs)
	if got := r.Len(); got != 1 {
		t.Fatalf("len %d", got)
	}
	// Pending connections are findable by revocation but hold no rooms.
	if hits := r.MatchRevocation(&Revocation{UserID: "u1"}); len(hits) != 1 {
		t.Fatalf("pending not matched: %d", len(hits))
	}
	if rooms := r.RoomMembers(UserRoom("u1")); len(rooms) != 0 {
		t.Fatalf("pending delivered before open: %v", rooms)
	}
	if !cs.MarkOpened() {
		t.Fatal("opened refused without revocation")
	}
	r.JoinRooms(cs, UserRoom("u1"))
	if got := r.RoomMembers(UserRoom("u1")); len(got) != 1 {
		t.Fatalf("opened not delivered")
	}
	r.RemoveClosed("c1")
	if r.Len() != 0 || len(r.RoomMembers(UserRoom("u1"))) != 0 {
		t.Fatal("remove left residue")
	}
	r.RemoveClosed("c1") // idempotent
}

func TestRegistryRevokedPendingRefusesOpen(t *testing.T) {
	f := NewMemFence()
	r := NewConnRegistry()
	cs := newConn("c1", "u1", "w1", "", f)
	r.AddPending(cs)
	cs.MarkRevoked()
	if cs.MarkOpened() {
		t.Fatal("revoked pending connection must not promote")
	}
}

func TestRegistryRoomDedup(t *testing.T) {
	f := NewMemFence()
	r := NewConnRegistry()
	a := newConn("a", "u1", "w1", "member", f)
	b := newConn("b", "u2", "w1", "member", f)
	r.AddPending(a)
	r.AddPending(b)
	a.MarkOpened()
	b.MarkOpened()
	r.JoinRooms(a, ChannelRoom("ch1"), ChannelRoom("ch2"))
	r.JoinRooms(b, ChannelRoom("ch2"))
	got := r.RoomMembers(ChannelRoom("ch1"), ChannelRoom("ch2"))
	if len(got) != 2 {
		t.Fatalf("dedup failed: %d", len(got))
	}
	r.LeaveRoom(b, ChannelRoom("ch2"))
	if got := r.RoomMembers(ChannelRoom("ch2")); len(got) != 1 {
		t.Fatalf("leave failed: %d", len(got))
	}
}

func TestConnEnqueueFenceGate(t *testing.T) {
	f := NewMemFence()
	cs := newConn("c1", "u1", "w1", "member", f)
	payload := []byte(`{}`)
	if err := cs.Enqueue(Frame{Event: "e", Payload: payload}); err != nil {
		t.Fatalf("fresh enqueue: %v", err)
	}
	f.Bump(UserFenceScope("u1"))
	if err := cs.Enqueue(Frame{Event: "e", Payload: payload}); err != ErrConnectionUnauthorized {
		t.Fatalf("post-bump enqueue must be unauthorized, got %v", err)
	}
	cs2 := newConn("c2", "u1", "w1", "member", f) // admitted at new generation
	if err := cs2.Enqueue(Frame{Event: "e", Payload: payload}); err != nil {
		t.Fatalf("re-admitted connection must pass: %v", err)
	}
	// Family-scope bump alone must also revoke (logout semantics).
	f.Bump(FamilyFenceScope("f1"))
	if err := cs2.Enqueue(Frame{Event: "e", Payload: payload}); err != ErrConnectionUnauthorized {
		t.Fatalf("family bump must revoke, got %v", err)
	}
	cs3 := newConnFam("c3", "u1", "w1", "member", "f2", f)
	if err := cs3.Enqueue(Frame{Event: "e", Payload: payload}); err != nil {
		t.Fatalf("other family must stay eligible: %v", err)
	}
	// Workspace bump revokes only workspace-bound connections.
	f.Bump(WorkspaceFenceScope("w1"))
	if err := cs3.Enqueue(Frame{Event: "e", Payload: payload}); err != ErrConnectionUnauthorized {
		t.Fatalf("workspace bump must revoke, got %v", err)
	}
}

func TestRegistryConcurrentChurn(t *testing.T) {
	f := NewMemFence()
	r := NewConnRegistry()
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				id := string(rune('A'+seed)) + "-" + time.Now().Format("150405.000000000")
				cs := newConn(id, "shared-user", "w1", "member", f)
				r.AddPending(cs)
				cs.MarkOpened()
				r.JoinRooms(cs, ChannelRoom("ch"), ServerRoom("w1"))
				r.RoomMembers(ChannelRoom("ch"), ServerRoom("w1"))
				if i%2 == 0 {
					r.LeaveRoom(cs, ChannelRoom("ch"))
				}
				r.RemoveClosed(id)
			}
		}(w)
	}
	wg.Wait()
	if r.Len() != 0 {
		t.Fatalf("residue: %d", r.Len())
	}
}

func TestLifetimeCloseWait(t *testing.T) {
	l := &Lifetime{}
	started := make(chan struct{})
	release := make(chan struct{})
	if !l.Go(func() {
		close(started)
		<-release
	}) {
		t.Fatal("spawn refused")
	}
	<-started
	l.MarkClosed()
	if l.Go(func() {}) {
		t.Fatal("spawn after close accepted")
	}
	go func() {
		<-started
		close(release)
	}()
	l.Wait()
	if l.Active() != 0 {
		t.Fatal("active count wrong")
	}
}
