package core

import (
	"sync"
	"sync/atomic"
)

// MemFence is the in-process AuthorizationFence: atomic per-scope
// generations with no I/O anywhere. It implements the exact contract the
// production (parent-injected) fence must satisfy, and is the reference
// used by this package's tests.
//
// Scalability note: MemFence never persists generations. Production use
// MUST inject a fence whose generations are coordinated with the revocation
// write transaction (bumped after commit) so a restarted process does not
// honor pre-revocation snapshots.
type MemFence struct {
	mu     sync.Mutex
	scopes map[FenceScope]*atomic.Uint64
}

// NewMemFence returns an empty fence; every scope starts at generation 0.
func NewMemFence() *MemFence {
	return &MemFence{scopes: make(map[FenceScope]*atomic.Uint64)}
}

func (f *MemFence) slot(scope FenceScope) *atomic.Uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	slot := f.scopes[scope]
	if slot == nil {
		slot = &atomic.Uint64{}
		f.scopes[scope] = slot
	}
	return slot
}

// Generation implements AuthorizationFence: lock-bounded map lookup plus
// one atomic load; never blocks on I/O.
func (f *MemFence) Generation(scope FenceScope) uint64 {
	return f.slot(scope).Load()
}

// Bump advances a scope's generation (revocation committed) and returns the
// new value. Connections admitted below it lose publish eligibility.
func (f *MemFence) Bump(scope FenceScope) uint64 {
	return f.slot(scope).Add(1)
}

// FenceView is the read side shared by ConnState: it pins the scopes a
// connection depends on (user, family when known, workspace when bound) so
// a pre-send check is two or three lock-bounded loads.
//
// Note the family independence: a logout bumps ONLY the family scope; a
// password reset / account change bumps the user scope; workspace
// mutations bump the workspace scope. A connection fails eligibility on
// ANY of its pinned scopes changing.
type FenceView struct {
	user      FenceScope
	family    FenceScope
	workspace FenceScope
	fence     AuthorizationFence
}

// NewFenceView pins a connection's fence scopes. An account-level
// connection (no workspace) pins user + family only; a connection without
// a family pins user (+ workspace).
func NewFenceView(fence AuthorizationFence, id Identity) *FenceView {
	v := &FenceView{
		user:  UserFenceScope(id.UserID),
		fence: fence,
	}
	if id.SessionFamilyID != "" {
		v.family = FamilyFenceScope(id.SessionFamilyID)
	}
	if id.WorkspaceID != "" {
		v.workspace = WorkspaceFenceScope(id.WorkspaceID)
	}
	return v
}

// Eligible reports whether the fence generations observed at admission are
// still current. Any mismatch means an authorization change committed after
// this connection was admitted: the connection is no longer authorized to
// receive new payloads.
func (v *FenceView) Eligible(id Identity) bool {
	if v.fence.Generation(v.user) != id.UserGeneration {
		return false
	}
	if id.SessionFamilyID != "" && v.fence.Generation(v.family) != id.FamilyGeneration {
		return false
	}
	if id.WorkspaceID != "" && v.fence.Generation(v.workspace) != id.WorkspaceGeneration {
		return false
	}
	return true
}
