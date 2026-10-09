package httpx

import (
	"context"
	"net/http"

	"raft.local/server-go/internal/workspace"
)

type scopeMembershipKey struct{}

// WithScopeMembership stores the workspace membership resolved by the
// workspace scope middleware into the request context.
func WithScopeMembership(ctx context.Context, m *workspace.Membership) context.Context {
	return context.WithValue(ctx, scopeMembershipKey{}, m)
}

// ScopeMembership returns the workspace membership resolved by the scope
// middleware (nil when the handler was mounted without it).
func ScopeMembership(r *http.Request) *workspace.Membership {
	m, _ := r.Context().Value(scopeMembershipKey{}).(*workspace.Membership)
	return m
}
