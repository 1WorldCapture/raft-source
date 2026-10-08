package core

import "sync"

// ConnRegistry indexes every admitted connection (pending + opened) by
// connection id, user, workspace and subscription room. It is the adapter's
// internal delivery index — NOT an authorization fact; authorization lives
// in Identity + the fence and is re-checked at every publish.
//
// One mutex guards the whole index: publish paths copy a member snapshot
// under the lock and enqueue outside it, so the critical section stays
// short and bounded.
type ConnRegistry struct {
	mu     sync.Mutex
	conns  map[string]*ConnState
	byUser map[string]map[string]*ConnState
	byWS   map[string]map[string]*ConnState
	byRoom map[string]map[string]*ConnState
}

// NewConnRegistry returns an empty registry.
func NewConnRegistry() *ConnRegistry {
	return &ConnRegistry{
		conns:  make(map[string]*ConnState),
		byUser: make(map[string]map[string]*ConnState),
		byWS:   make(map[string]map[string]*ConnState),
		byRoom: make(map[string]map[string]*ConnState),
	}
}

func (r *ConnRegistry) index(m map[string]map[string]*ConnState, key, id string, cs *ConnState) {
	set := m[key]
	if set == nil {
		set = make(map[string]*ConnState)
		m[key] = set
	}
	set[id] = cs
}

func (r *ConnRegistry) unindex(m map[string]map[string]*ConnState, key, id string) {
	if set := m[key]; set != nil {
		delete(set, id)
		if len(set) == 0 {
			delete(m, key)
		}
	}
}

// AddPending registers an admitted handshake before its namespace connect.
// Pending connections are findable by user/workspace (revocation scanning)
// but join no rooms.
func (r *ConnRegistry) AddPending(cs *ConnState) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.conns[cs.ID()] = cs
	r.index(r.byUser, cs.Identity().UserID, cs.ID(), cs)
	if ws := cs.Identity().WorkspaceID; ws != "" {
		r.index(r.byWS, ws, cs.ID(), cs)
	}
}

// JoinRooms subscribes an opened connection to rooms. Refused (false) when
// the connection was revoked in between; callers close the transport.
func (r *ConnRegistry) JoinRooms(cs *ConnState, rooms ...string) bool {
	if !cs.JoinRooms(rooms...) {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, room := range rooms {
		if room != "" {
			r.index(r.byRoom, room, cs.ID(), cs)
		}
	}
	return true
}

// LeaveRoom unsubscribes one room.
func (r *ConnRegistry) LeaveRoom(cs *ConnState, room string) {
	cs.LeaveRoom(room)
	r.mu.Lock()
	defer r.mu.Unlock()
	r.unindex(r.byRoom, room, cs.ID())
}

// RemoveClosed drops a connection from every index (transport reported it
// gone). Safe to call twice.
func (r *ConnRegistry) RemoveClosed(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cs := r.conns[id]
	if cs == nil {
		return
	}
	delete(r.conns, id)
	r.unindex(r.byUser, cs.Identity().UserID, id)
	if ws := cs.Identity().WorkspaceID; ws != "" {
		r.unindex(r.byWS, ws, id)
	}
	for _, room := range cs.roomSnapshotLocked() {
		r.unindex(r.byRoom, room, id)
	}
}

// roomSnapshotLocked reads the room set while holding the registry lock;
// ConnState uses its own finer lock, which is safe in this direction
// (never call registry methods while holding a ConnState lock).
func (c *ConnState) roomSnapshotLocked() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.rooms))
	for r := range c.rooms {
		out = append(out, r)
	}
	return out
}

// Get returns the connection state by id, if still tracked.
func (r *ConnRegistry) Get(id string) (*ConnState, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cs, ok := r.conns[id]
	return cs, ok
}

// RoomMembers returns the OPENED connections joined to ANY of rooms,
// deduplicated. This is a delivery index only; publish paths re-check the
// fence per connection.
func (r *ConnRegistry) RoomMembers(rooms ...string) []*ConnState {
	r.mu.Lock()
	defer r.mu.Unlock()
	seen := make(map[string]struct{})
	var out []*ConnState
	for _, room := range rooms {
		for id, cs := range r.byRoom[room] {
			if !cs.openedFlag() {
				continue
			}
			if _, dup := seen[id]; dup {
				continue
			}
			seen[id] = struct{}{}
			out = append(out, cs)
		}
	}
	return out
}

// UserMembers returns opened connections of one user across workspaces.
func (r *ConnRegistry) UserMembers(userID string) []*ConnState {
	return r.membersOf(r.byUser, userID)
}

// WorkspaceMembers returns opened connections bound to one workspace
// (heartbeat fanout set).
func (r *ConnRegistry) WorkspaceMembers(workspaceID string) []*ConnState {
	return r.membersOf(r.byWS, workspaceID)
}

func (r *ConnRegistry) membersOf(m map[string]map[string]*ConnState, key string) []*ConnState {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []*ConnState
	for _, cs := range m[key] {
		if cs.openedFlag() {
			out = append(out, cs)
		}
	}
	return out
}

// CountUserOpened counts a user's opened connections (per-user cap).
func (r *ConnRegistry) CountUserOpened(userID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, cs := range r.byUser[userID] {
		if cs.openedFlag() {
			n++
		}
	}
	return n
}

// OpenedSnapshot returns every OPENED connection (predicate publication
// audience: authority is decided by the caller's predicate, not rooms).
func (r *ConnRegistry) OpenedSnapshot() []*ConnState {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*ConnState, 0, len(r.conns))
	for _, cs := range r.conns {
		if cs.openedFlag() {
			out = append(out, cs)
		}
	}
	return out
}

// MatchRevocation returns every tracked connection (pending included)
// inside the revocation's blast radius.
func (r *ConnRegistry) MatchRevocation(rv *Revocation) []*ConnState {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []*ConnState
	for _, cs := range r.conns {
		if rv.MatchesIdentity(cs.Identity()) {
			out = append(out, cs)
		}
	}
	return out
}

// IDs snapshots every tracked connection id (pending + opened).
func (r *ConnRegistry) IDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.conns))
	for id := range r.conns {
		out = append(out, id)
	}
	return out
}

// Len reports tracked connections (pending + opened).
func (r *ConnRegistry) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.conns)
}

// WorkspaceIDs snapshots the distinct workspace ids with at least one
// OPENED connection (heartbeat fanout scope).
func (r *ConnRegistry) WorkspaceIDs() map[string]struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]struct{})
	for ws, set := range r.byWS {
		for _, cs := range set {
			if cs.openedFlag() {
				out[ws] = struct{}{}
				break
			}
		}
	}
	return out
}
