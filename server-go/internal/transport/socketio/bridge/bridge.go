// Package bridge adapts the application realtime fact sources and the
// notification sink onto the Socket.IO gateway: handshake authentication,
// the authority fence/guard, room setup, join authorization, resume pages,
// heartbeats and verified semantic notifications. It only converts protocols
// and calls injected capabilities — it never reads a database itself.
package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	apprealtime "raft.local/server-go/internal/application/realtime"
	"raft.local/server-go/internal/transport/presenter"
	"raft.local/server-go/internal/transport/socketio"
	"raft.local/server-go/internal/transport/socketio/core"
)

// Config carries the bridge's required dependencies. Every field is
// mandatory at construction; the authority capabilities arrive as injected
// functions (the composition root binds them to the shared database) so the
// transport never holds a raw SQL handle.
type Config struct {
	Facts  *apprealtime.SocketFacts
	Serial apprealtime.SerialSource
	// AuthorityGeneration resolves the per-scope committed authority
	// generation (memory-only; bound to db.AuthorityGeneration at assembly).
	AuthorityGeneration func(kind, id string) uint64
	// AuthorityGuard serializes eligibility checks against authority-changing
	// commits (bound to db.WithAuthorityReadContext at assembly).
	AuthorityGuard func(ctx context.Context, fn func() error) error
}

// HandshakeAuth implements socketio.HandshakeAuth over the verified access
// token and the application fact source.
type HandshakeAuth struct{ cfg Config }

// Identify is the synchronous decode: the returned proof is THIS verified
// token's own IssuedAt/ExpiresAt — never a lookup of the newest token for
// the user.
func (a *HandshakeAuth) Identify(ctx context.Context, token string) (string, string, socketio.TokenProof, error) {
	subject, family, proof, err := a.cfg.Facts.IdentifyToken(ctx, token)
	if err != nil {
		switch {
		case errors.Is(err, apprealtime.ErrHandshakeWrongType):
			return "", "", socketio.TokenProof{}, socketio.ErrInvalidTokenType
		default:
			return "", "", socketio.TokenProof{}, socketio.ErrInvalidOrExpiredToken
		}
	}
	return subject, family,
		socketio.TokenProof{IssuedAt: proof.IssuedAt, ExpiresAt: proof.ExpiresAt}, nil
}

// Authenticate performs the database-backed validation through the fact
// source on one pinned read snapshot.
func (a *HandshakeAuth) Authenticate(ctx context.Context, req socketio.HandshakeRequest) (*socketio.Admission, error) {
	role, err := a.cfg.Facts.Authenticate(ctx, req.Auth.Token, req.Auth.ServerID)
	if err != nil {
		switch {
		case errors.Is(err, apprealtime.ErrHandshakeNotAMember):
			return nil, socketio.ErrNotAMember
		case errors.Is(err, apprealtime.ErrHandshakeInvalidToken):
			return nil, socketio.ErrInvalidOrExpiredToken
		case errors.Is(err, apprealtime.ErrHandshakeWrongType):
			return nil, socketio.ErrInvalidTokenType
		default:
			// Infrastructure failures fail closed (the gateway classifies
			// unknown as invalid/expired); the real cause is preserved for
			// the caller to log.
			return nil, err
		}
	}
	return &socketio.Admission{ServerRole: role}, nil
}

// Fence maps the gateway's fence scopes onto the per-database authority
// generations. Memory-only, non-blocking, no network — it runs on every
// publish to every connection.
type Fence struct{ cfg Config }

func (f *Fence) Generation(scope core.FenceScope) uint64 {
	var kind string
	switch scope.Kind {
	case core.FenceKindUser:
		kind = "user"
	case core.FenceKindFamily:
		kind = "family"
	case core.FenceKindWorkspace:
		kind = "workspace"
	default:
		return 0
	}
	return f.cfg.AuthorityGeneration(kind, scope.ID)
}

// Guard serializes eligibility checks with bounded queue admission against
// authority-changing commits. The wrapped function only reads fence
// generations and offers frames to bounded queues — never a network write,
// never a wait on a consumer, never a nested transaction.
type Guard struct{ cfg Config }

func (g *Guard) Guard(ctx context.Context, fn func() error) error {
	return g.cfg.AuthorityGuard(ctx, fn)
}

// ChannelRooms resolves a freshly opened connection's authorized
// subscription set from CURRENT channel facts.
type ChannelRooms struct{ cfg Config }

func (r *ChannelRooms) ChannelRooms(ctx context.Context, id core.Identity) ([]string, error) {
	if id.AccountLevel() {
		return []string{}, nil
	}
	ids, err := r.cfg.Facts.SubscribedChannels(ctx, id.WorkspaceID, id.UserID)
	if err != nil {
		return nil, err
	}
	rooms := make([]string, 0, len(ids))
	for _, ch := range ids {
		rooms = append(rooms, core.ChannelRoom(ch))
	}
	return rooms, nil
}

// Join authorizes join:channel by base content authorization; fail-closed
// on every denial and error, silently to the client like the original.
type Join struct{ cfg Config }

func (j *Join) CanJoin(ctx context.Context, id core.Identity, channelID string) (bool, error) {
	if id.AccountLevel() {
		return false, nil
	}
	return j.cfg.Facts.CanJoin(ctx, id.WorkspaceID, id.UserID, channelID)
}

// Resume serves sync:resume pages from the message worker's persistent read
// model with the EXACT claims frozen at admission.
type Resume struct{ cfg Config }

func (r *Resume) SyncVisible(ctx context.Context, id core.Identity, lastSeq int64, maxMessages int, byteBudget int64) (socketio.ResumePage, error) {
	facts, err := r.cfg.Facts.ResumePage(ctx, apprealtime.ViewerIdentity{
		UserID: id.UserID, WorkspaceID: id.WorkspaceID, SessionFamilyID: id.SessionFamilyID,
		TokenIssuedAt: id.TokenIssuedAt, TokenExpiresAt: id.TokenExpiresAt,
	}, lastSeq, maxMessages)
	if err != nil {
		return socketio.ResumePage{}, err
	}
	// The byte budget is defined over the ENCODED wire envelope, so it is
	// applied here at the encoding boundary (presenter.RenderResumePage),
	// verbatim from the original message-worker algorithm.
	envelope, err := presenter.RenderResumePage(facts.Projections, facts.CurrentSeq, facts.HasMore, byteBudget)
	if err != nil {
		return socketio.ResumePage{}, err
	}
	page := socketio.ResumePage{
		CurrentSeq: envelope.CurrentSeq,
		HasMore:    envelope.HasMore,
	}
	if envelope.Messages != nil {
		page.Messages = make([]json.RawMessage, 0, len(envelope.Messages))
		page.Seqs = make([]int64, 0, len(envelope.Messages))
		for _, dto := range envelope.Messages {
			raw, err := json.Marshal(dto)
			if err != nil {
				return socketio.ResumePage{}, fmt.Errorf("bridge resume encode: %w", err)
			}
			page.Messages = append(page.Messages, raw)
			page.Seqs = append(page.Seqs, dto.Seq)
		}
	}
	return page, nil
}

// Heartbeat supplies each workspace's committed message high-water — a
// gap-detection hint, never an ack or delivery cursor.
type Heartbeat struct{ cfg Config }

func (h *Heartbeat) WorkspaceSeq(ctx context.Context, workspaceID string) (int64, error) {
	return h.cfg.Facts.WorkspaceSeq(ctx, workspaceID)
}

// Adapters is the full gateway adapter set built from one configuration.
type Adapters struct {
	HandshakeAuth socketio.HandshakeAuth
	Fence         core.AuthorizationFence
	Guard         socketio.AdmissionGuard
	ChannelRooms  socketio.InitialRoomsResolver
	Join          socketio.RoomAccess
	Resume        socketio.ResumeProvider
	Heartbeat     socketio.HeartbeatSource
}

// NewAdapters builds every bridge adapter over the shared configuration.
func NewAdapters(cfg Config) *Adapters {
	return &Adapters{
		HandshakeAuth: &HandshakeAuth{cfg: cfg},
		Fence:         &Fence{cfg: cfg},
		Guard:         &Guard{cfg: cfg},
		ChannelRooms:  &ChannelRooms{cfg: cfg},
		Join:          &Join{cfg: cfg},
		Resume:        &Resume{cfg: cfg},
		Heartbeat:     &Heartbeat{cfg: cfg},
	}
}
