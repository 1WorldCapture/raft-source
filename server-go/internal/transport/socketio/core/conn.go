package core

import (
	"net/http"
	"sync"
	"time"
)

// ConnState is everything the gateway tracks for one connection. It is
// created the moment a handshake is ADMITTED (auth passed, identity frozen)
// and lives until the transport reports the connection closed — including
// the pending window between Admit and namespace connect, so revocations
// can find it (socket/index.ts pendingHandshakes semantics).
type ConnState struct {
	id         string
	identity   Identity
	queue      *OutboundQueue
	limiter    *Limiter
	fence      *FenceView
	remoteAddr string
	origin     string
	admittedAt time.Time

	mu         sync.Mutex
	rooms      map[string]struct{}
	roomsReady bool // authorized room setup barrier completed
	opened     bool // namespace connect observed
	revoked    bool // a revocation matched before/while connected
}

// NewConnState freezes a connection's immutable state. queue/limiter/fence
// must already be bound to identity.
func NewConnState(id string, idt Identity, queue *OutboundQueue, limiter *Limiter, fence *FenceView, r *http.Request, now time.Time) *ConnState {
	cs := &ConnState{
		id: id, identity: idt, queue: queue, limiter: limiter, fence: fence,
		admittedAt: now,
		rooms:      make(map[string]struct{}),
	}
	if r != nil {
		cs.remoteAddr = r.RemoteAddr
		cs.origin = r.Header.Get("Origin")
	}
	return cs
}

// ID is the connection key used across the gateway.
func (c *ConnState) ID() string { return c.id }

// Identity returns the immutable authorization snapshot.
func (c *ConnState) Identity() Identity { return c.identity }

// Queue exposes the bounded outbound backlog (owned by the wire drainer).
func (c *ConnState) Queue() *OutboundQueue { return c.queue }

// AllowInboundEvent applies the inbound rate limit.
func (c *ConnState) AllowInboundEvent() bool { return c.limiter.Allow() }

// AdmittedAt is the admission timestamp.
func (c *ConnState) AdmittedAt() time.Time { return c.admittedAt }

// RemoteAddr returns the handshake peer (diagnostics only).
func (c *ConnState) RemoteAddr() string { return c.remoteAddr }

// MarkOpened records the namespace connect. It refuses promotion when a
// revocation already matched this connection while it was pending: the
// gateway must then close the transport immediately (TS: "A handshake that
// has not resolved its role yet fails closed" + connection-handler check of
// accessRevoked).
func (c *ConnState) MarkOpened() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.opened = true
	return !c.revoked
}

// MarkRevoked flags the connection: no new payloads may be enqueued and the
// transport must be closed.
func (c *ConnState) MarkRevoked() {
	c.mu.Lock()
	c.revoked = true
	c.mu.Unlock()
	c.queue.Close()
}

// Revoked reports the flag.
func (c *ConnState) Revoked() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.revoked
}

// JoinRooms adds subscription rooms. It refuses on revoked connections;
// callers treat that as a close trigger.
func (c *ConnState) JoinRooms(rooms ...string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.revoked {
		return false
	}
	for _, r := range rooms {
		if r != "" {
			c.rooms[r] = struct{}{}
		}
	}
	return true
}

// LeaveRoom removes one subscription room (leaving a subscription is not
// leaving business membership).
func (c *ConnState) LeaveRoom(room string) {
	c.mu.Lock()
	delete(c.rooms, room)
	c.mu.Unlock()
}

// Rooms snapshots the current subscription set.
func (c *ConnState) Rooms() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.rooms))
	for r := range c.rooms {
		out = append(out, r)
	}
	return out
}

// MarkRoomsReady completes the authorized room-setup barrier; rooms:joined
// may be emitted only after this.
func (c *ConnState) MarkRoomsReady() {
	c.mu.Lock()
	c.roomsReady = true
	c.mu.Unlock()
}

// RoomsReady reports barrier completion.
func (c *ConnState) RoomsReady() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.roomsReady
}

// PublishEligible combines the fence check with the revoked flag: the
// final pre-send gate every frame must pass.
func (c *ConnState) PublishEligible() bool {
	if c.Revoked() {
		return false
	}
	return c.fence.Eligible(c.identity)
}

// Enqueue is the publish path for one frame: fence gate first, bounded
// queue second. Errors tell the caller to disconnect this connection.
func (c *ConnState) Enqueue(f Frame) error {
	if !c.PublishEligible() {
		return ErrConnectionUnauthorized
	}
	return c.queue.Offer(f)
}

// ErrConnectionUnauthorized marks a connection that lost publish
// eligibility (fence mismatch or revocation): it must be closed, not
// silently starved.
var ErrConnectionUnauthorized = errUnauthorized{}

type errUnauthorized struct{}

func (errUnauthorized) Error() string { return "socketio: connection no longer authorized" }

// openedFlag reports whether the namespace connect was observed. Called
// only from the registry, which does not hold the ConnState lock while
// calling, so taking the lock here is safe.
func (c *ConnState) openedFlag() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.opened
}
