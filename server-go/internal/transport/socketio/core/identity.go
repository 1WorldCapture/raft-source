package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Identity is the immutable per-connection authorization snapshot frozen at
// handshake admission (phase-4-messaging.md §7.2): incoming bodies can never
// override any of these fields. Generation fields snapshot the shared
// authorization fence at admission time; publish paths compare them against
// the live fence before enqueueing any payload (fail closed on revocation).
//
// The token proof (IssuedAt/ExpiresAt) is copied verbatim from the VERIFIED
// access token at admission: callbacks revalidate this exact proof, never a
// newer token for the same user/family, and each socket dies at its own
// token's expiry (m4-authority-contract.md §"ordering").
type Identity struct {
	// UserID is the authenticated human principal (token sub).
	UserID string
	// SessionFamilyID groups sessions rotated from one login.
	SessionFamilyID string
	// WorkspaceID is the serverId the client bound this connection to. Empty
	// means an account-level connection: it may receive account events only
	// and may never join workspace rooms or resume.
	WorkspaceID string
	// ClientKind is the parsed platform kind ("web" when absent).
	ClientKind string
	// ServerRole is the role at admission time ("guest", "member", ...),
	// used to match guest-scoped revocations. Empty when no workspace is
	// bound.
	ServerRole string
	// TokenIssuedAt / TokenExpiresAt are the verified token's timestamps as
	// frozen at admission. A zero ExpiresAt means the authenticator did not
	// supply one and only admission-time validation applies. TokenIssuedAt
	// is carried so revocation paths can distinguish re-issued families.
	TokenIssuedAt  time.Time
	TokenExpiresAt time.Time
	// UserGeneration, FamilyGeneration and WorkspaceGeneration are the fence
	// values observed at admission (one per authority kind, mirroring
	// db.AuthorityGeneration(handle, kind, id)); any later mismatch revokes
	// publish eligibility. Family and user generations are independent: a
	// logout bumps only the family, a password reset bumps the user.
	UserGeneration      uint64
	FamilyGeneration    uint64
	WorkspaceGeneration uint64
}

// Expired reports whether the connection's own access token has reached
// its verified expiry at the given instant. RFC 7519 semantics: valid only
// while now < exp, so expiry at EXACTLY the exp instant counts as expired
// (now >= exp) — matching admission's !ExpiresAt.After(now) rejection and
// avoiding an off-by-one second between the two checks.
func (id Identity) Expired(now time.Time) bool {
	return !id.TokenExpiresAt.IsZero() && !now.Before(id.TokenExpiresAt)
}

// AccountLevel reports whether this connection bound no workspace.
func (id Identity) AccountLevel() bool { return id.WorkspaceID == "" }

// FenceKind names one authority domain. Kinds mirror the parent's
// db.AuthorityGeneration(handle, kind, id) taxonomy exactly: user (account,
// all families), family (one login family: logout revokes only it) and
// workspace (conservative workspace-wide invalidation).
type FenceKind uint8

const (
	FenceKindUser FenceKind = iota + 1
	FenceKindFamily
	FenceKindWorkspace
)

// FenceScope identifies one fence domain: a kind plus its id (user id,
// family id or workspace id). Scopes are matched exactly.
type FenceScope struct {
	Kind FenceKind
	ID   string
}

func (s FenceScope) String() string {
	switch s.Kind {
	case FenceKindUser:
		return "fence:user:" + s.ID
	case FenceKindFamily:
		return "fence:family:" + s.ID
	default:
		return "fence:workspace:" + s.ID
	}
}

// UserFenceScope is the user's account-wide fence domain.
func UserFenceScope(userID string) FenceScope {
	return FenceScope{Kind: FenceKindUser, ID: userID}
}

// FamilyFenceScope is one login family's fence domain.
func FamilyFenceScope(familyID string) FenceScope {
	return FenceScope{Kind: FenceKindFamily, ID: familyID}
}

// WorkspaceFenceScope is a workspace's fence domain.
func WorkspaceFenceScope(workspaceID string) FenceScope {
	return FenceScope{Kind: FenceKindWorkspace, ID: workspaceID}
}

// AuthorizationFence is the shared authorization fence between the
// revoking write path and publish eligibility (phase-4-messaging.md §8.2).
//
// Contract for implementors (enforced by tests in this package):
//
//   - Generation MUST be cheap, lock-bounded and non-blocking; it is called
//     on every publish to every connection.
//   - Generation MUST NOT perform network I/O and MUST NOT be called while
//     the caller holds a database transaction that waits on anything.
//   - Revocation commits bump the generation(s) covering the affected
//     scope(s); after the bump, connections admitted against an older
//     generation are no longer authorized for new payloads.
//
// The production implementation is injected by the parent (backed by the
// revocation write path); MemFence below covers tests and bootstrapping.
type AuthorizationFence interface {
	Generation(scope FenceScope) uint64
}

// HandshakeAuth is the parsed auth object of the Socket.IO CONNECT packet:
// auth = {token, serverId: string|null, clientKind: "web"} (web
// packages/web/src/api/socket.ts:23-49). Exactly these fields, same shapes.
type HandshakeAuth struct {
	Token      string
	ServerID   *string // nil = account-level connection
	ClientKind string
}

// AuthShapeError distinguishes malformed auth objects (rejected with
// ReasonAuthenticationRequired) from authentication failures.
type AuthShapeError struct{ Reason string }

func (e *AuthShapeError) Error() string {
	return "socketio: malformed handshake auth: " + e.Reason
}

// ParseHandshakeAuth mirrors TS parseSocketHandshakeAuth field by field:
// a missing/blank token, an invalid serverId shape or an invalid clientKind
// all yield an *AuthShapeError (the TS server answers each of those with
// "Authentication required").
func ParseHandshakeAuth(v any) (*HandshakeAuth, error) {
	m, ok := v.(map[string]any)
	if !ok {
		return nil, &AuthShapeError{Reason: "auth_not_object"}
	}
	token, ok := m["token"].(string)
	if !ok || strings.TrimSpace(token) == "" {
		return nil, &AuthShapeError{Reason: "token_missing"}
	}
	auth := &HandshakeAuth{Token: token}
	rawServer, present := m["serverId"]
	if !present || rawServer == nil {
		auth.ServerID = nil
	} else if s, ok := rawServer.(string); ok && s != "" {
		id := s
		auth.ServerID = &id
	} else {
		return nil, &AuthShapeError{Reason: "server_id_invalid"}
	}
	kind, ok := ParseClientKind(m["clientKind"])
	if !ok {
		return nil, &AuthShapeError{Reason: "client_kind_invalid"}
	}
	auth.ClientKind = kind
	return auth, nil
}

// Revocation is a committed authorization change that must invalidate live
// and pending subscriptions. It mirrors the TS SocketAccessRevocation union
// (packages/server/src/socket/accessRevocation.ts) with Go-tagged fields.
//
//   - User-set (UserID != ""): evict the user's sockets; SessionFamilyID
//     optionally narrows to one family (logout vs password reset).
//   - Family-set (SessionFamilyID != "", UserID optional): evict the exact
//     login family even after its database row/owning user has been deleted.
//   - Workspace-set (WorkspaceID != "", UserID == ""): ScopeAll evicts
//     every socket attached to the workspace; ScopeGuests evicts sockets
//     whose admitted role is "guest" or unknown (a handshake that has not
//     resolved its role yet fails closed); ScopeNonMembers evicts sockets of
//     users absent from MemberUserIDs (the membership snapshot travels with
//     the revocation so the decision stays deterministic).
type Revocation struct {
	UserID          string
	SessionFamilyID string

	WorkspaceID   string
	Scope         RevocationScope
	MemberUserIDs []string

	// BeforeGeneration optionally bounds a delayed committed notification to
	// connections admitted BEFORE that generation in its authority domain.
	// Zero preserves explicit/unconditional revocations. Equal or newer
	// connections have already reauthenticated and must survive stale wakes.
	BeforeGeneration uint64
}

// RevocationScope qualifies workspace-scoped revocations.
type RevocationScope string

const (
	// ScopeAll is the zero value: every connection on the workspace.
	ScopeAll RevocationScope = ""
	// ScopeGuests evicts guest (and unresolved) roles only.
	ScopeGuests RevocationScope = "guests"
	// ScopeNonMembers evicts users missing from MemberUserIDs.
	ScopeNonMembers RevocationScope = "non-members"
)

// Validate normalizes and checks the union shape.
func (r *Revocation) Validate() error {
	if r.UserID != "" || r.SessionFamilyID != "" {
		if r.WorkspaceID != "" || r.Scope != ScopeAll || len(r.MemberUserIDs) > 0 {
			return errors.New("socketio: revocation: user/family-scoped revocation carries workspace fields")
		}
		return nil
	}
	if r.WorkspaceID == "" {
		return errors.New("socketio: revocation: no user, family or workspace scope set")
	}
	switch r.Scope {
	case ScopeAll, ScopeGuests:
		if len(r.MemberUserIDs) > 0 {
			return errors.New("socketio: revocation: member snapshot only valid with scope non-members")
		}
		return nil
	case ScopeNonMembers:
		if len(r.MemberUserIDs) == 0 {
			return errors.New("socketio: revocation: scope non-members requires a member snapshot")
		}
		return nil
	default:
		return fmt.Errorf("socketio: revocation: unknown scope %q", r.Scope)
	}
}

// MatchesIdentity reports whether an admitted identity falls in this
// revocation's blast radius. Pending handshakes whose role has not resolved
// fail closed for guest scope (identity.ServerRole == ""), mirroring
// socket/index.ts evict().
func (r *Revocation) MatchesIdentity(id Identity) bool {
	if r.UserID != "" || r.SessionFamilyID != "" {
		if r.UserID != "" && id.UserID != r.UserID {
			return false
		}
		generation := id.UserGeneration
		if r.SessionFamilyID != "" {
			if r.SessionFamilyID != id.SessionFamilyID {
				return false
			}
			generation = id.FamilyGeneration
		}
		return r.BeforeGeneration == 0 || generation < r.BeforeGeneration
	}
	if id.WorkspaceID != r.WorkspaceID {
		return false
	}
	if r.BeforeGeneration != 0 && id.WorkspaceGeneration >= r.BeforeGeneration {
		return false
	}
	switch r.Scope {
	case ScopeGuests:
		// Unresolved role (pending handshake) fails closed.
		return id.ServerRole == "" || id.ServerRole == "guest"
	case ScopeNonMembers:
		for _, uid := range r.MemberUserIDs {
			if uid == id.UserID {
				return false
			}
		}
		return true
	default: // ScopeAll
		return true
	}
}

// Frame is one serialized outbound envelope. Payload is the exact single
// JSON value emitted as the event's first (and only) argument; it is
// marshaled once per publish so byte accounting and wire delivery share one
// encoding.
type Frame struct {
	Event   string
	Payload json.RawMessage
}

// Bytes is the frame's accounted size: event name plus JSON payload.
func (f Frame) Bytes() int64 {
	return int64(len(f.Event)) + int64(len(f.Payload)) + 16
}
