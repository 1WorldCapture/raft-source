package app

// M4 realtime composition: buildM4Realtime assembles the Socket.IO transport
// (internal/transport/socketio + its zishang wire binding) with the verified
// access-token handshake, the per-database authority fence/admission guard,
// the channel/message/readstate adapters, the authority-eviction wake and the
// transactional-outbox publisher. This file owns only the wiring: every rule
// lives in the module that owns the facts.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/message"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/transport/socketio"
	"raft.local/server-go/internal/transport/socketio/core"
	"raft.local/server-go/internal/transport/socketio/zishang"
)

// authorityWakeBuffer bounds the eviction wake queue. The listener callback
// must never block; an overflow drops the wake (counted) because the fence
// generation check remains the final authorization guard.
const authorityWakeBuffer = 256

// m4RealtimeConfig carries assembly inputs beyond the locked constructor
// signature. Zero values select the documented defaults.
type m4RealtimeConfig struct {
	Logger            *slog.Logger
	Origins           []string
	HeartbeatInterval time.Duration // 0 -> original 15s cadence
	RoomSetupTimeout  time.Duration // 0 -> gateway default
}

// m4Realtime is the composed realtime surface: the Socket.IO gateway, its
// wire binding (http.Handler), the outbox publisher and the authority
// eviction wake. Lifecycle: the parent mounts Handler() under
// /socket.io/ and MUST call Close before closing the database.
type m4Realtime struct {
	gateway *socketio.Gateway
	handler http.Handler
	pub     *m4Publisher
	stopPub func()

	db            *sql.DB
	wakeCh        chan []db.AuthorityChange // never closed: async callbacks may send after unsubscribe
	wakeDone      chan struct{}             // closed by Close: stops listener sends and the worker
	workerDone    chan struct{}             // closed by the wake worker on exit (join point)
	stopListening func()
	wakesDropped  atomic.Uint64
	logger        *slog.Logger
	closeOnce     sync.Once
	closeErr      error
}

// buildM4Realtime is the locked constructor the parent calls after buildM4.
// It wires the verified-JWT handshake, the authority fence/guard adapters,
// current-fact room/join/resume/heartbeat sources, the eviction wake, the
// outbox publisher and the heartbeat loop, and binds the zishang Engine.IO
// websocket-only protocol handler.
func buildM4Realtime(m *m4Runtime, signer *auth.TokenSigner, logger *slog.Logger, origins []string) (*m4Realtime, error) {
	return assembleM4Realtime(m, signer, m4RealtimeConfig{Logger: logger, Origins: origins}, nil)
}

// assembleM4Realtime is the shared assembly path. transport is nil for
// production (the zishang Engine binds itself); the in-process protocol
// harness passes a fake Transport so the gateway contract can be driven
// without TCP (the child sandbox denies local port binds; the parent runs
// the real socket.io-client spike against the zishang binding).
func assembleM4Realtime(m *m4Runtime, signer *auth.TokenSigner, cfg m4RealtimeConfig, transport socketio.Transport) (*m4Realtime, error) {
	if m == nil || m.db == nil {
		return nil, errors.New("m4realtime: m4 runtime is required")
	}
	if signer == nil {
		return nil, errors.New("m4realtime: token signer is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	gateway, err := socketio.New(socketio.Options{
		Logger:            logger,
		Auth:              &rtHandshakeAuth{db: m.db, signer: signer},
		Fence:             &rtFence{db: m.db},
		Guard:             &rtGuard{db: m.db},
		ChannelRooms:      &rtChannelRooms{channels: m.channels},
		Join:              &rtJoin{channels: m.channels},
		Resume:            &rtResume{messages: m.messages},
		Heartbeat:         &rtHeartbeat{db: m.db},
		Origins:           cfg.Origins,
		HeartbeatInterval: cfg.HeartbeatInterval,
		RoomSetupTimeout:  cfg.RoomSetupTimeout,
	})
	if err != nil {
		return nil, err
	}

	r := &m4Realtime{
		gateway:    gateway,
		pub:        newM4Publisher(m.db, gateway, m.messages, m.channels, logger),
		db:         m.db,
		wakeCh:     make(chan []db.AuthorityChange, authorityWakeBuffer),
		wakeDone:   make(chan struct{}),
		workerDone: make(chan struct{}),
		logger:     logger,
	}

	if transport != nil {
		if err := gateway.UseTransport(transport); err != nil {
			return nil, err
		}
		r.handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			// Test assembly with an injected transport has no wire binding.
			http.Error(w, "socket.io wire binding not assembled", http.StatusServiceUnavailable)
		})
	} else {
		engine, err := zishang.New(gateway, zishang.Options{Logger: logger})
		if err != nil {
			return nil, err
		}
		r.handler = engine
	}

	// Authority eviction wake: the listener (fired AFTER commit, cache
	// update and fence release) only offers the change batch to a bounded
	// queue; the single wake worker resolves the blast radius and asks the
	// gateway to raw-close affected transports. No network or database work
	// runs in the callback itself.
	//
	// wakeCh is NEVER closed: a commit may have copied the callback before
	// Close unsubscribes it, and a send into a closed channel would panic.
	// Termination is signalled by wakeDone; the queue stays open (bounded)
	// and is garbage-collected with the runtime.
	r.stopListening = db.RegisterAuthorityListener(m.db, func(changes []db.AuthorityChange) {
		if len(changes) == 0 {
			return
		}
		select {
		case r.wakeCh <- changes:
		case <-r.wakeDone:
		default:
			n := r.wakesDropped.Add(1)
			if n == 1 || n%1000 == 0 {
				logger.Warn("m4realtime: authority wake queue full; eviction wake dropped (fence remains authoritative)",
					"dropped_total", n)
			}
		}
	})
	go r.wakeWorker()

	// Transactional outbox publisher: one bounded worker over durable
	// publication rows; the commit-listener wake inside Store.Start reacts
	// to every committed intent.
	r.stopPub = m.publications.Start(context.Background(), r.pub.publish, logger)

	if !gateway.StartHeartbeat() {
		// Closed concurrently during assembly; unwind everything.
		_ = r.Close()
		return nil, errors.New("m4realtime: gateway closed before heartbeat start")
	}
	return r, nil
}

// Handler is the /socket.io/ endpoint: websocket-only Engine.IO v4 with the
// origin allowlist and honest polling refusal enforced before the library.
func (r *m4Realtime) Handler() http.Handler { return r.handler }

// wakeWorker translates committed authority changes into gateway evictions.
// The fence already closed these connections' publish eligibility when the
// cache updated (before fence release); Revoke makes the transport close
// prompt instead of waiting for the next publish or heartbeat sweep.
func (r *m4Realtime) wakeWorker() {
	defer close(r.workerDone)
	for {
		select {
		case <-r.wakeDone:
			return
		case changes := <-r.wakeCh:
			for _, change := range changes {
				r.applyAuthorityChange(change)
			}
		}
	}
}

// applyAuthorityChange turns one committed authority change into a gateway
// eviction of OLD generations only. Delivery of this wake can lag admission:
// equal/newer identities have already reauthenticated after the commit, so an
// unconditional scope eviction would incorrectly close their fresh transport
// (including pending handshakes). Duplicate/out-of-order wakes are harmless.
func (r *m4Realtime) applyAuthorityChange(change db.AuthorityChange) {
	if change.Generation == 0 {
		// Persisted authority changes always have positive generations; do
		// not reinterpret a malformed wake as an unconditional revocation.
		r.logger.Warn("m4realtime: zero-generation authority wake ignored")
		return
	}
	switch change.Scope.Kind {
	case "user":
		r.gateway.Revoke(&core.Revocation{UserID: change.Scope.ID, BeforeGeneration: change.Generation})
	case "workspace":
		// Workspace epochs conservatively invalidate every OLD socket in
		// the workspace, not sockets admitted against the updated policy.
		r.gateway.Revoke(&core.Revocation{WorkspaceID: change.Scope.ID, BeforeGeneration: change.Generation})
	case "family":
		// A family tombstone is sufficient: hard deletion need not bump the
		// user epoch, and its owner row may no longer exist. Match the
		// immutable family ID directly, with no DB lookup during shutdown.
		r.gateway.Revoke(&core.Revocation{SessionFamilyID: change.Scope.ID, BeforeGeneration: change.Generation})
	default:
		r.logger.Warn("m4realtime: unknown authority scope kind ignored", "kind", change.Scope.Kind)
	}
}

// realtimeStats is the observability snapshot for tests and the report.
type realtimeStats struct {
	Gateway      socketio.Stats
	Publisher    publisherStats
	WakesDropped uint64
}

func (r *m4Realtime) Stats() realtimeStats {
	return realtimeStats{Gateway: r.gateway.Snapshot(), Publisher: r.pub.stats(), WakesDropped: r.wakesDropped.Load()}
}

// Close tears the realtime surface down in dependency order: the publisher
// first (no new frames), then the eviction wake (no new closes), then the
// gateway — which raw-closes every hijacked socket net/http Shutdown cannot
// reach and joins the drainer, barrier and heartbeat goroutines. The parent
// MUST call this before closing the database handle.
func (r *m4Realtime) Close() error {
	r.closeOnce.Do(func() {
		var errs []error
		if r.stopPub != nil {
			r.stopPub()
		}
		if r.stopListening != nil {
			r.stopListening()
		}
		// Signal termination (wakeCh stays open forever: an unsubscribed-yet-
		// in-flight commit callback may still offer into it) and join the
		// worker so no eviction races the gateway teardown.
		close(r.wakeDone)
		<-r.workerDone
		errs = append(errs, r.gateway.Close())
		r.closeErr = errors.Join(errs...)
	})
	return r.closeErr
}

// ---- handshake auth ------------------------------------------------------

// rtHandshakeAuth implements socketio.HandshakeAuth over the verified access
// token and the live database: Identify decodes the JWT signature/type only
// (no database), Authenticate runs auth.ValidateHumanTx plus the workspace
// membership/role on one pinned read snapshot.
type rtHandshakeAuth struct {
	db     *sql.DB
	signer *auth.TokenSigner
}

// Identify is the synchronous decode: the returned proof is THIS verified
// token's own IssuedAt/ExpiresAt — never a lookup of the newest token for
// the user. ErrTokenWrongType keeps the client's refresh trigger.
func (a *rtHandshakeAuth) Identify(_ context.Context, token string) (string, string, socketio.TokenProof, error) {
	claims, err := a.signer.VerifyAccessToken(token)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrTokenWrongType):
			return "", "", socketio.TokenProof{}, socketio.ErrInvalidTokenType
		default:
			return "", "", socketio.TokenProof{}, socketio.ErrInvalidOrExpiredToken
		}
	}
	return claims.Subject, claims.FamilyID,
		socketio.TokenProof{IssuedAt: claims.IssuedAt, ExpiresAt: claims.ExpiresAt}, nil
}

// Authenticate performs the database-backed validation on one pinned read
// snapshot: the exact token (re-verified by its own string, so the proof
// checked at admission is the proof admitted) still belongs to a live,
// owned, non-revoked session family of a real verified user; a client-bound
// serverId must map to a current membership, whose role is frozen into the
// connection identity.
func (a *rtHandshakeAuth) Authenticate(ctx context.Context, req socketio.HandshakeRequest) (*socketio.Admission, error) {
	claims, err := a.signer.VerifyAccessToken(req.Auth.Token)
	if err != nil {
		return nil, socketio.ErrInvalidOrExpiredToken
	}
	role := ""
	err = db.WithReadSnapshot(ctx, a.db, func(ex db.Executor) error {
		if err := auth.ValidateHumanTx(ctx, ex, *claims, time.Now()); err != nil {
			return err
		}
		if req.Auth.ServerID == nil {
			return nil
		}
		return ex.QueryRowContext(ctx, `SELECT m.role
			FROM workspace_memberships m
			JOIN workspaces w ON w.id = m.workspace_id
			WHERE m.workspace_id = ? AND m.user_id = ?
			  AND w.deleted_at IS NULL AND w.kind <> 'joint_storage'`,
			*req.Auth.ServerID, claims.Subject).Scan(&role)
	})
	if err != nil {
		switch {
		case errors.Is(err, sql.ErrNoRows):
			return nil, socketio.ErrNotAMember
		case errors.Is(err, auth.ErrTokenInvalid):
			return nil, socketio.ErrInvalidOrExpiredToken
		default:
			// Infrastructure failures fail closed (the gateway classifies
			// unknown as invalid/expired); the real cause is logged here so
			// operators can distinguish DB trouble from credential trouble.
			return nil, fmt.Errorf("m4realtime handshake validation: %w", err)
		}
	}
	return &socketio.Admission{ServerRole: role}, nil
}

// ---- fence / guard adapters ----------------------------------------------

// rtFence maps the gateway's fence scopes onto the parent's per-database
// authority generations. Memory-only, non-blocking, no network — it runs on
// every publish to every connection.
type rtFence struct {
	db *sql.DB
}

func (f *rtFence) Generation(scope core.FenceScope) uint64 {
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
	return db.AuthorityGeneration(f.db, kind, scope.ID)
}

// rtGuard serializes eligibility checks with bounded queue admission against
// authority-changing commits. The wrapped function only reads fence
// generations and offers frames to bounded queues — never a network write,
// never a wait on a consumer, never a nested transaction.
type rtGuard struct {
	db *sql.DB
}

func (g *rtGuard) Guard(ctx context.Context, fn func() error) error {
	return db.WithAuthorityReadContext(ctx, g.db, fn)
}

// ---- rooms / join / resume / heartbeat adapters --------------------------

// rtChannelRooms resolves a freshly opened connection's authorized
// subscription set from CURRENT channel facts (the sync visibility rule:
// public server-wide, private/DM by roster, threads by active follow).
type rtChannelRooms struct {
	channels *channel.Store
}

func (r *rtChannelRooms) ChannelRooms(ctx context.Context, id core.Identity) ([]string, error) {
	if id.AccountLevel() {
		return []string{}, nil
	}
	var ids []string
	err := db.WithReadSnapshot(ctx, r.channels.DB(), func(ex db.Executor) error {
		var err error
		ids, err = r.channels.ListSubscriptionsTx(ctx, ex, id.WorkspaceID, id.UserID)
		return err
	})
	if err != nil {
		return nil, err
	}
	rooms := make([]string, 0, len(ids))
	for _, ch := range ids {
		rooms = append(rooms, core.ChannelRoom(ch))
	}
	return rooms, nil
}

// rtJoin authorizes join:channel by base content authorization (a readable
// conversation may be subscribed for live updates; explicit join never
// writes a follow row). Fail-closed on every denial and error, silently to
// the client like the original.
type rtJoin struct {
	channels *channel.Store
}

func (r *rtJoin) CanJoin(ctx context.Context, id core.Identity, channelID string) (bool, error) {
	if id.AccountLevel() {
		return false, nil
	}
	allowed := false
	err := db.WithReadSnapshot(ctx, r.channels.DB(), func(ex db.Executor) error {
		conv, err := r.channels.AuthorizeConversationTx(ctx, ex, id.WorkspaceID, channelID, id.UserID, false)
		if err != nil {
			if channel.AsDomainError(err) != nil {
				return nil // authorization denial, not an infrastructure error
			}
			return err
		}
		allowed = conv != nil && conv.Channel != nil
		return nil
	})
	if err != nil {
		return false, err
	}
	return allowed, nil
}

// rtResume serves sync:resume pages from the message worker's persistent
// read model with the EXACT claims frozen at admission (rebuilt from the
// verified token identity — a resume request body can never select another
// principal), the original 500-message page cap and the byte budget the
// connection's bounded queue still accepts.
type rtResume struct {
	messages *message.Store
}

func (r *rtResume) SyncVisible(ctx context.Context, id core.Identity, lastSeq int64, maxMessages int, byteBudget int64) (socketio.ResumePage, error) {
	claims := message.NewClaims(auth.AccessTokenClaims{
		Subject:   id.UserID,
		Type:      "access",
		FamilyID:  id.SessionFamilyID,
		IssuedAt:  id.TokenIssuedAt,
		ExpiresAt: id.TokenExpiresAt,
	})
	envelope, err := r.messages.ResumePage(ctx, claims, id.WorkspaceID, lastSeq, message.ResumeOptions{
		MaxMessages:     maxMessages,
		MaxEncodedBytes: byteBudget,
	})
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
				return socketio.ResumePage{}, fmt.Errorf("m4realtime resume encode: %w", err)
			}
			page.Messages = append(page.Messages, raw)
			page.Seqs = append(page.Seqs, dto.Seq)
		}
	}
	return page, nil
}

// rtHeartbeat supplies each workspace's committed message high-water — a
// gap-detection hint, never an ack or delivery cursor.
type rtHeartbeat struct {
	db *sql.DB
}

func (h *rtHeartbeat) WorkspaceSeq(ctx context.Context, workspaceID string) (int64, error) {
	var seq int64
	err := h.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(seq),0) FROM messages WHERE workspace_id = ?`, workspaceID).Scan(&seq)
	return seq, err
}
