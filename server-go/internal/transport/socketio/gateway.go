// Package socketio is the M4 Socket.IO transport adapter: it owns the
// handshake barrier, per-connection identity, room indexing, bounded
// outbound queues, application heartbeats, sync:resume plumbing and the
// authorization fence — everything except the wire protocol itself, which
// the zishang subpackage binds to github.com/zishang520/socket.io.
//
// The parent (internal/app) wires this package through the callback
// interfaces in options.go; the adapter never imports auth/channel/message
// modules itself.
package socketio

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/transport/socketio/core"
)

// Transport is the wire side a protocol binding (subpackage zishang)
// registers with the gateway. The gateway never touches a protocol library
// directly.
type Transport interface {
	// CanAccept reports whether the transport can immediately take another
	// write batch (upstream write backpressure probe). The drainer pauses
	// emission while false, which is what keeps the upstream library's
	// UNBOUNDED write buffers from growing past this gateway's own bounds.
	CanAccept(connID string) bool
	// Emit delivers one frame to the connection's wire. It must be
	// non-blocking or fail fast: false means the connection is gone and the
	// gateway's drainer stops.
	Emit(connID string, f core.Frame) bool
	// CloseTransport closes the RAW transport of one connection. The
	// original web client treats this as reason "transport close" and
	// auto-reconnects + re-authenticates (a namespace server disconnect
	// would leave it dead — never use that for revocation).
	CloseTransport(connID string)
	// CloseAll closes every live connection; called by Gateway.Close to
	// reap hijacked sockets that net/http Server.Shutdown cannot reach.
	CloseAll()
}

// Gateway coordinates admitted Socket.IO connections: admission, the
// authorized room-setup barrier, inbound events, bounded publish, the
// application heartbeat loop and revocation eviction.
type Gateway struct {
	opts    Options
	log     *slog.Logger
	clk     clock.Clock
	fence   core.AuthorizationFence
	origins *core.OriginAllowlist
	reg     *core.ConnRegistry
	life    *core.Lifetime

	tportMu sync.RWMutex
	tport   Transport

	doneCh   chan struct{}
	doneOnce sync.Once

	metrics metrics

	closeOnce sync.Once
	closeErr  error
}

type metrics struct {
	admitted        atomic.Int64
	rejectedAuth    atomic.Int64
	rejectedOrigin  atomic.Int64
	opened          atomic.Int64
	closed          atomic.Int64
	revokedClosed   atomic.Int64
	queueOverflowed atomic.Int64
	rateLimited     atomic.Int64
	capRejected     atomic.Int64
	framesSent      atomic.Int64
	framesDenied    atomic.Int64
	resumeRequests  atomic.Int64
	resumePages     atomic.Int64
	resumeDenied    atomic.Int64
	unknownEvents   atomic.Int64
	joinAllowed     atomic.Int64
	joinDenied      atomic.Int64
	heartbeats      atomic.Int64
	barrierFailed   atomic.Int64
	stalledClosed   atomic.Int64
	expiredClosed   atomic.Int64
	resumeTrimmed   atomic.Int64
	resumeOversize  atomic.Int64
	guarded         atomic.Int64
	guardAbandoned  atomic.Int64
}

// Stats is a point-in-time counters snapshot for observability and tests.
type Stats struct {
	Admitted        int64
	RejectedAuth    int64
	RejectedOrigin  int64
	Opened          int64
	Closed          int64
	RevokedClosed   int64
	QueueOverflowed int64
	RateLimited     int64
	CapRejected     int64
	FramesSent      int64
	FramesDenied    int64
	ResumeRequests  int64
	ResumePages     int64
	ResumeDenied    int64
	UnknownEvents   int64
	JoinAllowed     int64
	JoinDenied      int64
	Heartbeats      int64
	BarrierFailed   int64
	StalledClosed   int64
	ExpiredClosed   int64
	ResumeTrimmed   int64
	ResumeOversize  int64
	Guarded         int64
	GuardAbandoned  int64
	TrackedConns    int
}

// Snapshot copies the counters and tracked-connection count.
func (g *Gateway) Snapshot() Stats {
	return Stats{
		Admitted: g.metrics.admitted.Load(), RejectedAuth: g.metrics.rejectedAuth.Load(),
		RejectedOrigin: g.metrics.rejectedOrigin.Load(), Opened: g.metrics.opened.Load(),
		Closed: g.metrics.closed.Load(), RevokedClosed: g.metrics.revokedClosed.Load(),
		QueueOverflowed: g.metrics.queueOverflowed.Load(), RateLimited: g.metrics.rateLimited.Load(),
		CapRejected: g.metrics.capRejected.Load(), FramesSent: g.metrics.framesSent.Load(),
		FramesDenied: g.metrics.framesDenied.Load(), ResumeRequests: g.metrics.resumeRequests.Load(),
		ResumePages: g.metrics.resumePages.Load(), ResumeDenied: g.metrics.resumeDenied.Load(),
		UnknownEvents: g.metrics.unknownEvents.Load(), JoinAllowed: g.metrics.joinAllowed.Load(),
		JoinDenied: g.metrics.joinDenied.Load(), Heartbeats: g.metrics.heartbeats.Load(),
		BarrierFailed: g.metrics.barrierFailed.Load(), TrackedConns: g.reg.Len(),
		StalledClosed: g.metrics.stalledClosed.Load(), ExpiredClosed: g.metrics.expiredClosed.Load(),
		ResumeTrimmed: g.metrics.resumeTrimmed.Load(), ResumeOversize: g.metrics.resumeOversize.Load(),
		Guarded: g.metrics.guarded.Load(), GuardAbandoned: g.metrics.guardAbandoned.Load(),
	}
}

// New assembles a Gateway. Bind the protocol transport with UseTransport
// exactly once before serving.
func New(opts Options) (*Gateway, error) {
	if err := opts.validate(); err != nil {
		return nil, err
	}
	o := opts.withDefaults()
	g := &Gateway{
		opts:    o,
		log:     o.Logger,
		clk:     o.Clock,
		fence:   o.Fence,
		origins: core.ParseOriginAllowlist(o.Origins),
		reg:     core.NewConnRegistry(),
		life:    &core.Lifetime{},
		doneCh:  make(chan struct{}),
	}
	if o.Origins == nil || len(o.Origins) == 0 {
		g.log.Warn("socketio: origin allowlist is empty; every Origin-bearing (browser) handshake will be rejected")
	}
	return g, nil
}

// UseTransport binds the protocol transport. Exactly once, before serving.
func (g *Gateway) UseTransport(t Transport) error {
	g.tportMu.Lock()
	defer g.tportMu.Unlock()
	if g.tport != nil {
		return errors.New("socketio: transport already bound")
	}
	g.tport = t
	return nil
}

func (g *Gateway) transport() Transport {
	g.tportMu.RLock()
	defer g.tportMu.RUnlock()
	return g.tport
}

// OriginAllowed answers whether the handshake's HTTP request may proceed.
// The protocol binding must enforce this at the Engine.IO upgrade (HTTP
// 403) — before any Socket.IO handshake work; Admit re-checks as defense
// in depth.
func (g *Gateway) OriginAllowed(r *http.Request) bool { return g.origins.Allows(r) }

// RecordOriginRejected counts an origin rejection performed by the binding
// at the HTTP layer (observability only).
func (g *Gateway) RecordOriginRejected() { g.metrics.rejectedOrigin.Add(1) }

// errShuttingDown rejects handshakes once Close started.
var errShuttingDown = errors.New("socketio: server is shutting down")

// errOriginNotAllowed surfaces when the binding did not reject the origin
// at the HTTP layer; the string is deliberately NOT one of the original
// client's auth-refresh keywords (an origin misconfiguration must not
// trigger token refresh loops).
var errOriginNotAllowed = errors.New("Origin not allowed")

// Admit is the handshake middleware entry: the binding calls it with a
// fresh connection id, the Engine.IO upgrade request and the parsed
// CONNECT auth object. A non-nil error rejects the connection; its message
// is delivered verbatim as the client's connect_error reason.
//
// Ordering (the revocation-race contract, phase-4 design §8.2, mirroring
// socket/index.ts):
//
//  1. Origin allowlist (binding already did; re-checked here).
//  2. Auth shape parse (exact parseSocketHandshakeAuth semantics).
//  3. Identify: synchronous token decode, no database (TS verifyToken).
//  4. Fence snapshot g0 (user scope + workspace scope).
//  5. Injected Authenticate: active session, membership, role (DB).
//  6. Fence re-read g1: g0 != g1 means a revocation committed while the
//     authentication read the database — reject with ReasonAuthChanged.
//  7. Freeze the identity, register as PENDING (findable by Revoke),
//     start the wire drainer.
//
// Between 7 and Opened the connection is pending: Revoke matches it by
// identity and marks it revoked, and Opened then closes the transport
// instead of completing the connect.
func (g *Gateway) Admit(ctx context.Context, connID string, r *http.Request, authObj any) (*core.Identity, error) {
	if !g.life.Enter() {
		return nil, errShuttingDown
	}
	defer g.life.Leave()

	if !g.origins.Allows(r) {
		g.metrics.rejectedOrigin.Add(1)
		return nil, errOriginNotAllowed
	}
	auth, err := core.ParseHandshakeAuth(authObj)
	if err != nil {
		g.metrics.rejectedAuth.Add(1)
		return nil, errors.New(core.ReasonAuthenticationRequired)
	}

	userID, familyID, proof, err := g.opts.Auth.Identify(ctx, auth.Token)
	if err != nil {
		g.metrics.rejectedAuth.Add(1)
		return nil, classifyAuthError(err)
	}
	// Exact expiry of THIS token: a connection may never outlive the very
	// token that admitted it, and a newer token for the same user/family
	// never extends an older socket (m4-authority-contract.md).
	if proof.ExpiresAt.IsZero() {
		g.metrics.rejectedAuth.Add(1)
		return nil, ErrInvalidOrExpiredToken // a proof without expiry is not a proof
	}
	if !proof.ExpiresAt.After(g.clk.Now()) {
		g.metrics.rejectedAuth.Add(1)
		return nil, ErrInvalidOrExpiredToken
	}

	userScope := core.UserFenceScope(userID)
	familyScope := core.FenceScope{}
	g0f := uint64(0)
	if familyID != "" {
		familyScope = core.FamilyFenceScope(familyID)
		g0f = g.fence.Generation(familyScope)
	}
	g0u := g.fence.Generation(userScope)
	var g0w uint64
	hasWS := auth.ServerID != nil
	wsScope := core.FenceScope{}
	if hasWS {
		wsScope = core.WorkspaceFenceScope(*auth.ServerID)
		g0w = g.fence.Generation(wsScope)
	}

	adm, err := g.opts.Auth.Authenticate(ctx, HandshakeRequest{Auth: *auth, HTTP: r})
	if err != nil {
		g.metrics.rejectedAuth.Add(1)
		return nil, classifyAuthError(err)
	}
	if adm == nil {
		g.metrics.rejectedAuth.Add(1)
		return nil, ErrInvalidOrExpiredToken
	}

	// The final admission guard (parent: db.WithAuthorityReadContext): the
	// fence re-read, the generation comparison and the pending registration
	// execute atomically with respect to authority-changing commits, so no
	// revocation can interleave between the eligibility check and the use.
	// Nothing inside blocks on network I/O or waits on a consumer.
	var identity core.Identity
	var admitted *core.ConnState
	guardErr := g.opts.Guard.Guard(ctx, func() error {
		g1u := g.fence.Generation(userScope)
		if g1u != g0u {
			return errAuthChanged
		}
		g1f := g0f
		if familyID != "" {
			g1f = g.fence.Generation(familyScope)
			if g1f != g0f {
				return errAuthChanged
			}
		}
		g1w := uint64(0)
		if hasWS {
			g1w = g.fence.Generation(wsScope)
			if g1w != g0w {
				return errAuthChanged
			}
		}
		wsID, role := "", ""
		if hasWS {
			wsID = *auth.ServerID
			role = adm.ServerRole
			if role == "" {
				role = "member"
			}
		}
		identity = core.Identity{
			UserID:              userID,
			SessionFamilyID:     familyID,
			WorkspaceID:         wsID,
			ClientKind:          auth.ClientKind,
			ServerRole:          role,
			TokenIssuedAt:       proof.IssuedAt,
			TokenExpiresAt:      proof.ExpiresAt,
			UserGeneration:      g1u,
			FamilyGeneration:    g1f,
			WorkspaceGeneration: g1w,
		}
		cs := core.NewConnState(connID, identity,
			core.NewOutboundQueue(g.opts.MaxQueueMessages, g.opts.MaxQueueBytes),
			core.NewLimiter(g.opts.EventRatePerSecond, g.opts.EventBurst, g.clk.Now),
			core.NewFenceView(g.fence, identity), r, g.clk.Now())
		g.reg.AddPending(cs)
		admitted = cs
		return nil
	})
	g.metrics.guarded.Add(1)
	if guardErr != nil {
		if errors.Is(guardErr, errAuthChanged) {
			g.metrics.revokedClosed.Add(1)
			return nil, errors.New(core.ReasonAuthChanged)
		}
		g.metrics.rejectedAuth.Add(1)
		return nil, ErrInvalidOrExpiredToken
	}
	g.metrics.admitted.Add(1)
	g.startDrainer(admitted)
	return &identity, nil
}

// errAuthChanged is the internal sentinel crossing the admission guard.
var errAuthChanged = errors.New("auth changed during admission")

// classifyAuthError maps authenticator errors to the exact client-visible
// strings; unknown errors fail closed as invalid/expired without leaking
// details.
func classifyAuthError(err error) error {
	switch {
	case errors.Is(err, ErrInvalidTokenType):
		return ErrInvalidTokenType
	case errors.Is(err, ErrInvalidOrExpiredToken):
		return ErrInvalidOrExpiredToken
	case errors.Is(err, ErrNotAMember):
		return ErrNotAMember
	default:
		return ErrInvalidOrExpiredToken
	}
}

// Opened completes the handshake: the binding reports the namespace
// connect. A revocation that landed while the connection was pending makes
// this fail and close the transport (fail closed, TS accessRevoked check).
func (g *Gateway) Opened(connID string) {
	cs, ok := g.reg.Get(connID)
	if !ok {
		return
	}
	if !g.life.Enter() {
		g.dropConn(cs, "shutting-down")
		return
	}
	defer g.life.Leave()
	if !cs.MarkOpened() {
		g.metrics.revokedClosed.Add(1)
		g.dropConn(cs, "revoked-while-pending")
		return
	}
	if n := g.reg.CountUserOpened(cs.Identity().UserID); n > g.opts.MaxConnsPerUser {
		g.metrics.capRejected.Add(1)
		g.dropConn(cs, "per-user-cap")
		return
	}
	g.metrics.opened.Add(1)

	// Identity rooms: user, client-kind, workspace intersection set.
	rooms := []string{
		core.UserRoom(cs.Identity().UserID),
		core.UserClientKindRoom(cs.Identity().UserID, cs.Identity().ClientKind),
	}
	if !cs.Identity().AccountLevel() {
		rooms = append(rooms, core.ServerRoom(cs.Identity().WorkspaceID),
			core.UserServerRoom(cs.Identity().UserID, cs.Identity().WorkspaceID))
	}
	if !g.reg.JoinRooms(cs, rooms...) {
		g.dropConn(cs, "revoked")
		return
	}

	if cs.Identity().AccountLevel() {
		// The original server emits rooms:joined only inside its
		// if (serverId) branch: account-level connections get the user
		// rooms and nothing else, and never a resume stream.
		return
	}
	// Authorized room-setup barrier: channel rooms resolve first,
	// rooms:joined is emitted only after. One dedicated goroutine per
	// connection, bounded by RoomSetupTimeout, tracked by the lifetime.
	if !g.life.Go(func() { g.roomBarrier(cs) }) {
		g.dropConn(cs, "shutting-down")
	}
}

// roomBarrier resolves and joins the authorized channel/DM rooms, then
// emits rooms:joined. Any failure fails CLOSED: the connection is closed
// and the client retries against current authorization state — the gateway
// never emits rooms:joined over an unresolved room set. The rooms:joined
// frame itself is admitted under the admission guard like every other
// payload; the ChannelRooms resolution stays OUTSIDE the guard.
func (g *Gateway) roomBarrier(cs *core.ConnState) {
	ctx, cancel := context.WithTimeout(context.Background(), g.opts.RoomSetupTimeout)
	defer cancel()
	id := cs.Identity()
	rooms, err := g.opts.ChannelRooms.ChannelRooms(ctx, id)
	if err != nil {
		g.metrics.barrierFailed.Add(1)
		g.log.Warn("socketio: channel room resolution failed; disconnecting", "component", "socketio", "conn", cs.ID(), "error", err)
		g.dropConn(cs, "room-setup-failed")
		return
	}
	filtered := make([]string, 0, len(rooms))
	for _, room := range rooms {
		if room != "" {
			filtered = append(filtered, room)
		}
	}
	if !g.reg.JoinRooms(cs, filtered...) {
		g.dropConn(cs, "revoked")
		return
	}
	if _, ok := g.reg.Get(cs.ID()); !ok {
		return // closed meanwhile
	}
	cs.MarkRoomsReady()
	// Admission contract: rooms:joined is a payload like any other — the
	// eligibility check and the bounded queue offer run INSIDE the admission
	// guard, atomic with respect to authority-changing commits. The room
	// resolution above already ran OUTSIDE it (no guard is held across the
	// ChannelRooms database read).
	if err := g.guardedEnqueue(ctx, cs, core.Frame{Event: core.EventRoomsJoined}); err != nil {
		if isEnqueueVerdict(err) {
			g.handleEnqueueErr(cs, err)
			return
		}
		// The guard was abandoned (shutdown/cancel/timeout) BEFORE the
		// admission ran: fail closed — rooms:joined is never emitted over an
		// admission this process could not authorize atomically.
		g.metrics.guardAbandoned.Add(1)
		g.dropConn(cs, "rooms-joined-guard-abandoned")
	}
}

// Closed reports the transport gone (any path). Safe to call twice.
func (g *Gateway) Closed(connID string) {
	cs, ok := g.reg.Get(connID)
	if !ok {
		return
	}
	cs.Queue().Close()
	g.reg.RemoveClosed(connID)
	g.metrics.closed.Add(1)
}

// dropConn closes a misbehaving/unauthorized connection's transport and
// forgets it.
func (g *Gateway) dropConn(cs *core.ConnState, reason string) {
	cs.MarkRevoked()
	if t := g.transport(); t != nil {
		t.CloseTransport(cs.ID())
	}
	g.reg.RemoveClosed(cs.ID())
	g.log.Debug("socketio: connection dropped", "component", "socketio", "conn", cs.ID(), "reason", reason)
}

// InboundEvent forwards one client event with its raw JSON args.
func (g *Gateway) InboundEvent(ctx context.Context, connID string, event string, args []json.RawMessage) {
	cs, ok := g.reg.Get(connID)
	if !ok {
		return
	}
	if !g.life.Enter() {
		g.dropConn(cs, "shutting-down")
		return
	}
	defer g.life.Leave()

	// Inbound bounds: count first (args already size-bounded by the
	// binding's max-payload), then rate.
	var total int64
	for _, a := range args {
		total += int64(len(a))
	}
	if total > g.opts.MaxEventBytes {
		g.metrics.rateLimited.Add(1)
		g.dropConn(cs, "event-too-large")
		return
	}
	if !cs.AllowInboundEvent() {
		g.metrics.rateLimited.Add(1)
		g.dropConn(cs, "rate-limited")
		return
	}

	switch event {
	case core.EventJoinChannel:
		g.handleJoin(ctx, cs, args)
	case core.EventLeaveChannel:
		g.handleLeave(cs, args)
	case core.EventSyncResume:
		g.handleResume(ctx, cs, args)
	default:
		// Unknown events are ignored and counted, exactly like a Socket.IO
		// server without a handler for them; privileged server-internal
		// events (access:revoked & co.) are NOT accepted from clients.
		g.metrics.unknownEvents.Add(1)
	}
}

// handleJoin validates join:channel — the original wire carries ONE
// channelId string as the event's single argument.
func (g *Gateway) handleJoin(ctx context.Context, cs *core.ConnState, args []json.RawMessage) {
	channelID, ok := singleStringArg(args)
	if !ok || channelID == "" {
		g.metrics.joinDenied.Add(1)
		return
	}
	id := cs.Identity()
	if id.AccountLevel() {
		g.metrics.joinDenied.Add(1)
		return
	}
	allowed, err := g.opts.Join.CanJoin(ctx, id, channelID)
	if err != nil {
		// Malformed IDs and failed authorization reads fail closed (TS
		// catch {} semantics).
		g.metrics.joinDenied.Add(1)
		return
	}
	if !allowed {
		g.metrics.joinDenied.Add(1)
		return
	}
	if !cs.PublishEligible() {
		g.dropConn(cs, "revoked")
		return
	}
	if !g.reg.JoinRooms(cs, core.ChannelRoom(channelID)) {
		g.dropConn(cs, "revoked")
		return
	}
	g.metrics.joinAllowed.Add(1)
}

// handleLeave validates leave:channel — leaving a subscription is not
// leaving business membership; it needs no authorization.
func (g *Gateway) handleLeave(cs *core.ConnState, args []json.RawMessage) {
	channelID, ok := singleStringArg(args)
	if !ok || channelID == "" {
		return
	}
	g.reg.LeaveRoom(cs, core.ChannelRoom(channelID))
}

// resumeRequest is the sync:resume request shape {lastSeq}. LastSeq is
// decoded as any and then strictly type-checked: the original client always
// sends a JSON number, so string digits, booleans, null, fractions, NaNs,
// negatives and out-of-safe-range values are all ignored (never replayed
// from). float64 represents every integer up to 2^53 exactly.
type resumeRequest struct {
	LastSeq any `json:"lastSeq"`
}

// resumeResponse mirrors the original envelope exactly.
type resumeResponse struct {
	Messages   []json.RawMessage `json:"messages"`
	CurrentSeq int64             `json:"currentSeq"`
	HasMore    bool              `json:"hasMore"`
}

// handleResume serves one sync:resume page. The original server silently
// ignores missing/invalid lastSeq, account-level connections and provider
// failures; the Go gateway keeps that wire behavior while re-checking the
// fence before delivery.
func (g *Gateway) handleResume(ctx context.Context, cs *core.ConnState, args []json.RawMessage) {
	g.metrics.resumeRequests.Add(1)
	id := cs.Identity()
	if id.AccountLevel() || len(args) != 1 {
		g.metrics.resumeDenied.Add(1)
		return
	}
	var req resumeRequest
	if err := json.Unmarshal(args[0], &req); err != nil {
		g.metrics.resumeDenied.Add(1)
		return
	}
	lastSeqF, isNumber := req.LastSeq.(float64)
	if !isNumber || lastSeqF != math.Trunc(lastSeqF) || lastSeqF <= 0 || lastSeqF > float64(core.MaxSafeInteger) {
		// Strings, booleans, null, fractions, negatives, beyond-2^53:
		// ignored, never replayed from.
		g.metrics.resumeDenied.Add(1)
		return
	}
	lastSeq := int64(lastSeqF)
	if !cs.PublishEligible() {
		g.metrics.resumeDenied.Add(1)
		g.dropConn(cs, "revoked")
		return
	}
	// Byte-aware paging: a full 500-message page of 32000-UTF-16-unit CJK
	// bodies is ~3x the 1 MiB queue bound; an oversized single frame would
	// overflow the bounded queue, force a slow-consumer disconnect and
	// re-connect-loop forever. The budget is what this connection's queue
	// can still accept; the provider pages by it and the gateway trims any
	// page that still exceeds it, keeping currentSeq/hasMore truthful for
	// the delivered prefix.
	budget := g.opts.MaxQueueBytes - cs.Queue().Bytes() - g.opts.ResumeFrameOverheadBytes
	if budget < 0 {
		budget = 0
	}
	page, err := g.opts.Resume.SyncVisible(ctx, id, lastSeq, core.ResumePageLimit, budget)
	if err != nil {
		g.metrics.resumeDenied.Add(1)
		g.log.Warn("socketio: resume provider failed", "component", "socketio", "conn", cs.ID(), "error", err)
		return
	}
	page = trimResumePage(page, budget)
	if len(page.Messages) == 0 && page.HasMore && budget < minResumeBudget {
		// Not even one message fits the remaining budget: deliver nothing
		// rather than a hasMore page that cannot advance — disconnect so
		// the client reconnects with a fresh, empty queue (bounded retry,
		// not a loop: every retry gets the full queue budget again).
		g.metrics.resumeOversize.Add(1)
		g.dropConn(cs, "resume-budget-exhausted")
		return
	}
	if page.Messages == nil {
		page.Messages = []json.RawMessage{}
	}
	payload, err := json.Marshal(resumeResponse{
		Messages: page.Messages, CurrentSeq: page.CurrentSeq, HasMore: page.HasMore,
	})
	if err != nil {
		g.metrics.resumeDenied.Add(1)
		return
	}
	// Admission contract: the sync:resume:response frame is admitted INSIDE
	// the guard; the SyncVisible provider read above already ran OUTSIDE it.
	// A revocation committing while the provider paged cannot slip a
	// stale-authorized frame past the fence check.
	if err := g.guardedEnqueue(ctx, cs, core.Frame{Event: core.EventSyncResumeResp, Payload: payload}); err != nil {
		if isEnqueueVerdict(err) {
			g.handleEnqueueErr(cs, err)
			return
		}
		// Guard abandoned before admission: fail closed and disconnect, so
		// the client reconnects and re-syncs against current authorization
		// instead of appearing synchronized without its page.
		g.metrics.guardAbandoned.Add(1)
		g.metrics.resumeDenied.Add(1)
		g.dropConn(cs, "resume-guard-abandoned")
		return
	}
	g.metrics.resumePages.Add(1)
}

// minResumeBudget is the floor at which an empty page is treated as a
// budget problem instead of a truthful "nothing new" answer.
const minResumeBudget = 4096

// trimResumePage cuts a page to the byte budget while keeping the envelope
// truthful: currentSeq becomes the last INCLUDED message's seq (or the
// caller's lastSeq when nothing is included) and hasMore stays/becomes
// true whenever anything was left out. Seqs must align with Messages; a
// provider that omits Seqs is trusted verbatim (no trim without truth).
func trimResumePage(page ResumePage, budget int64) ResumePage {
	if len(page.Seqs) != len(page.Messages) || len(page.Messages) <= 1 {
		return page
	}
	used := int64(0)
	for i, m := range page.Messages {
		cost := int64(len(m)) + 24 // array element accounting overhead
		if used+cost > budget {
			if i == 0 {
				return page // cannot trim to zero here; caller decides
			}
			trimmed := ResumePage{
				Messages:   page.Messages[:i],
				Seqs:       page.Seqs[:i],
				CurrentSeq: page.Seqs[i-1],
				HasMore:    true,
			}
			if page.CurrentSeq > trimmed.CurrentSeq {
				trimmed.HasMore = true
			}
			return trimmed
		}
		used += cost
	}
	return page
}

// singleStringArg decodes the events whose original wire form is exactly
// one string argument (join:channel / leave:channel).
func singleStringArg(args []json.RawMessage) (string, bool) {
	if len(args) != 1 {
		return "", false
	}
	var s string
	if err := json.Unmarshal(args[0], &s); err != nil {
		return "", false
	}
	return s, true
}

// Publish delivers one event to every OPENED connection joined to any of
// rooms. The per-connection eligibility check and the bounded enqueue run
// INSIDE the admission guard, so an authority commit can never interleave
// between the check and the use. Payload must serialize to a single JSON
// value: the original client consumes only the first argument.
//
// Backward-compatible wrapper: it bounds the guard wait to
// guardAcquireTimeout. Prefer PublishContext with a caller-bound context
// (request/shutdown-aware) so a saturated authority fence cancels the wait
// deterministically.
func (g *Gateway) Publish(rooms []string, event string, payload any) {
	g.PublishContext(context.Background(), rooms, event, payload)
}

// PublishContext is Publish with a caller-bound context: ctx bounds how
// long the admission guard may wait on the authority fence. A canceled or
// deadlined context abandons the batch BEFORE any frame is offered (the
// guarded section itself is synchronous and nonblocking, so there is no
// mid-batch cancellation and never a partially offered batch); durability
// and retry remain the caller's surface (the publication outbox when the
// caller runs on it).
func (g *Gateway) PublishContext(ctx context.Context, rooms []string, event string, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		g.log.Error("socketio: publish payload marshal failed", "component", "socketio", "event", event, "error", err)
		return
	}
	frame := core.Frame{Event: event, Payload: data}
	conns := g.reg.RoomMembers(rooms...)
	if err := g.withGuard(ctx, func() error {
		for _, cs := range conns {
			if err := g.enqueue(cs, frame); err != nil {
				g.handleEnqueueErr(cs, err)
			}
		}
		return nil
	}); err != nil {
		g.metrics.guardAbandoned.Add(1)
		g.log.Warn("socketio: publish abandoned waiting for the admission guard", "component", "socketio", "event", event, "error", err)
	}
}

// PublishWhere delivers to every OPENED connection whose frozen identity
// passes include (predicate-based current-audience publication for private
// data: the caller authorizes from CURRENT facts under the guard; rooms
// are a subscription index, never authority). include must be quick and
// must not perform network I/O — it runs inside the admission guard.
//
// Backward-compatible wrapper bounded by guardAcquireTimeout; prefer
// PublishWhereContext with a caller-bound context.
func (g *Gateway) PublishWhere(event string, payload any, include func(core.Identity) bool) {
	g.PublishWhereContext(context.Background(), event, payload, include)
}

// PublishWhereContext is PublishWhere with a caller-bound context bounding
// the admission-guard wait. Cancellation abandons the batch before any
// frame is offered.
func (g *Gateway) PublishWhereContext(ctx context.Context, event string, payload any, include func(core.Identity) bool) {
	if include == nil {
		return
	}
	data, err := json.Marshal(payload)
	if err != nil {
		g.log.Error("socketio: publish payload marshal failed", "component", "socketio", "event", event, "error", err)
		return
	}
	frame := core.Frame{Event: event, Payload: data}
	conns := g.reg.OpenedSnapshot()
	if err := g.withGuard(ctx, func() error {
		for _, cs := range conns {
			if !include(cs.Identity()) {
				continue
			}
			if err := g.enqueue(cs, frame); err != nil {
				g.handleEnqueueErr(cs, err)
			}
		}
		return nil
	}); err != nil {
		g.metrics.guardAbandoned.Add(1)
		g.log.Warn("socketio: publish abandoned waiting for the admission guard", "component", "socketio", "event", event, "error", err)
	}
}

// PublishChannel is the channel-room convenience for the message module.
func (g *Gateway) PublishChannel(channelID, event string, payload any) {
	g.Publish([]string{core.ChannelRoom(channelID)}, event, payload)
}

// PublishChannelContext is PublishChannel with a caller-bound context.
func (g *Gateway) PublishChannelContext(ctx context.Context, channelID, event string, payload any) {
	g.PublishContext(ctx, []string{core.ChannelRoom(channelID)}, event, payload)
}

// PublishWorkspace fans out to every opened connection of a workspace
// (guard-wrapped like Publish).
func (g *Gateway) PublishWorkspace(workspaceID, event string, payload any) {
	g.Publish([]string{core.ServerRoom(workspaceID)}, event, payload)
}

// PublishWorkspaceContext is PublishWorkspace with a caller-bound context.
func (g *Gateway) PublishWorkspaceContext(ctx context.Context, workspaceID, event string, payload any) {
	g.PublishContext(ctx, []string{core.ServerRoom(workspaceID)}, event, payload)
}

// PublishUserServer targets exactly one user's sockets on one workspace:
// the INTERSECTION semantics private events require (read state, prefs,
// reaction viewer) — never user room + server room separately (union leaks).
func (g *Gateway) PublishUserServer(userID, workspaceID, event string, payload any) {
	g.Publish([]string{core.UserServerRoom(userID, workspaceID)}, event, payload)
}

// PublishUserServerContext is PublishUserServer with a caller-bound
// context.
func (g *Gateway) PublishUserServerContext(ctx context.Context, userID, workspaceID, event string, payload any) {
	g.PublishContext(ctx, []string{core.UserServerRoom(userID, workspaceID)}, event, payload)
}

func (g *Gateway) enqueue(cs *core.ConnState, f core.Frame) error {
	// Token expiry is re-checked on every enqueue: a socket never outlives
	// the exact token that admitted it.
	if cs.Identity().Expired(g.clk.Now()) {
		g.metrics.expiredClosed.Add(1)
		return core.ErrConnectionUnauthorized
	}
	if err := cs.Enqueue(f); err != nil {
		return err
	}
	g.metrics.framesSent.Add(1)
	return nil
}

// guardAcquireTimeout bounds admission-guard ACQUISITION when the caller's
// context carries no deadline (the legacy Publish wrappers and inbound
// event paths): a saturated authority fence may delay a fanout, an
// rooms:joined emission or a resume response, but it can never pin a
// publisher, barrier or event handler forever. Inside the guard nothing
// waits — the wrapped section is fence reads plus bounded queue offers.
const guardAcquireTimeout = 5 * time.Second

// withGuard runs fn inside the admission guard with bounded acquisition:
// everything fn does (fence reads, bounded queue offers) is atomic with
// respect to authority-changing commits (m4-authority-contract.md: a
// generation check without the guard is insufficient because a revocation
// can interleave between check and use). A caller ctx without a deadline is
// bounded by guardAcquireTimeout. The returned error is either fn's own or
// a guard-acquisition failure (context.Canceled/DeadlineExceeded); the
// latter means fn NEVER RAN.
func (g *Gateway) withGuard(ctx context.Context, fn func() error) error {
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, guardAcquireTimeout)
		defer cancel()
	}
	err := g.opts.Guard.Guard(ctx, fn)
	g.metrics.guarded.Add(1)
	return err
}

// guardedEnqueue admits ONE frame under the admission guard (rooms:joined,
// sync:resume:response): the fence reads inside cs.Enqueue and the bounded
// queue offer execute atomically with respect to authority-changing
// commits. Callers MUST have already finished every database/network read
// (provider paging, room resolution) BEFORE entering — the guard never
// spans a blocking wait. See withGuard for the acquisition bound.
func (g *Gateway) guardedEnqueue(ctx context.Context, cs *core.ConnState, f core.Frame) error {
	return g.withGuard(ctx, func() error { return g.enqueue(cs, f) })
}

// isEnqueueVerdict reports whether err is an enqueue OUTCOME (queue bound
// breach, lost authorization, closed queue) rather than a guard-acquisition
// failure: verdicts route to handleEnqueueErr; anything else means the
// guarded admission never ran and the caller must fail closed.
func isEnqueueVerdict(err error) bool {
	return errors.Is(err, core.ErrQueueFull) ||
		errors.Is(err, core.ErrConnectionUnauthorized) ||
		errors.Is(err, core.ErrQueueClosed)
}

// handleEnqueueErr converts enqueue failures into explicit disconnects:
// a breached bound or a lost authorization closes the transport so the
// client reconnects and gap-syncs; frames are never silently dropped while
// the connection keeps appearing synchronized.
func (g *Gateway) handleEnqueueErr(cs *core.ConnState, err error) {
	switch {
	case errors.Is(err, core.ErrQueueFull):
		g.metrics.queueOverflowed.Add(1)
		g.log.Info("socketio: outbound bound breached; disconnecting slow consumer", "component", "socketio", "conn", cs.ID())
	case errors.Is(err, core.ErrConnectionUnauthorized):
		g.metrics.framesDenied.Add(1)
	default:
		g.metrics.framesDenied.Add(1)
	}
	if t := g.transport(); t != nil {
		t.CloseTransport(cs.ID())
	}
}

// startDrainer moves queued frames to the wire. One goroutine per
// connection, tracked by the lifetime; it exits when the queue closes and
// drains, the transport reports the connection gone, the connection was
// revoked, or the transport stays unwritable past WriteStallTimeout.
//
// Emission window: the upstream library's engine writeBuffer and websocket
// writeQueue are both UNBOUNDED (verified in the cached v3.0.6 sources:
// sendPacket pushes to an unbounded slice; websocket.Send enqueues into a
// never-blocking queue.Queue). This drainer therefore pauses whenever the
// transport cannot take another write batch (CanAccept == false), which
// caps everything the library can buffer at what this gateway's own
// bounded queue still holds — and a wedged writer (the upstream websocket
// write path has NO write deadline) is closed with discard after
// WriteStallTimeout instead of pinning a goroutine forever.
func (g *Gateway) startDrainer(cs *core.ConnState) {
	if !g.life.Go(func() {
		t := g.transport()
		if t == nil {
			return
		}
		stalledSince := time.Time{}
		for {
			if cs.Revoked() {
				return
			}
			if cs.Queue().Closed() && cs.Queue().Len() == 0 {
				return
			}
			if !t.CanAccept(cs.ID()) {
				now := time.Now()
				if stalledSince.IsZero() {
					stalledSince = now
				} else if now.Sub(stalledSince) > g.opts.WriteStallTimeout {
					g.metrics.stalledClosed.Add(1)
					g.log.Info("socketio: outbound write stalled; closing with discard", "component", "socketio", "conn", cs.ID())
					t.CloseTransport(cs.ID())
					return
				}
				select {
				case <-time.After(2 * time.Millisecond):
				case <-g.doneCh:
					return
				}
				continue
			}
			stalledSince = time.Time{}
			f, err := cs.Queue().Take(nil)
			if err != nil {
				return
			}
			// A frame can wait behind a slow writer while its authorization
			// changes. The asynchronous eviction wake is not the authority:
			// re-read the generation and this exact token before handoff.
			// Never hold the admission guard across a transport operation.
			if cs.Identity().Expired(g.clk.Now()) || !cs.PublishEligible() {
				cs.MarkRevoked()
				g.handleEnqueueErr(cs, core.ErrConnectionUnauthorized)
				return
			}
			if !t.Emit(cs.ID(), f) {
				return
			}
		}
	}) {
		// Shutting down before the drainer could start: nothing was
		// enqueued yet (the handshake had not completed), just forget it.
		g.reg.RemoveClosed(cs.ID())
	}
}

// Revoke applies a committed authorization change: every tracked
// connection (pending handshakes included) inside the blast radius is
// marked revoked and its RAW transport closed, so the original client
// auto-reconnects and re-authenticates against the new state. Bytes
// already handed to the network before this call cannot be recalled; the
// guarantee is that no NEW payload is authorized afterwards.
func (g *Gateway) Revoke(rv *core.Revocation) {
	if err := rv.Validate(); err != nil {
		g.log.Error("socketio: invalid revocation ignored", "component", "socketio", "error", err)
		return
	}
	for _, cs := range g.reg.MatchRevocation(rv) {
		cs.MarkRevoked()
		if t := g.transport(); t != nil {
			t.CloseTransport(cs.ID())
		}
		g.metrics.revokedClosed.Add(1)
	}
}

// StartHeartbeat launches the single hub-level heartbeat loop: every
// HeartbeatInterval it fans out {seq, ts} to every opened
// workspace-bound connection, using each workspace's committed high-water.
// (The original ran one 15s interval per socket; the phase values are
// identical, only the phase alignment differs — the client does not rely
// on per-socket phase.)
func (g *Gateway) StartHeartbeat() bool {
	return g.life.Go(func() {
		ticker := time.NewTicker(g.opts.HeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				g.heartbeatTick()
			case <-g.doneCh:
				return
			}
		}
	})
}

func (g *Gateway) heartbeatTick() {
	// One source read per workspace with opened connections. The
	// WorkspaceSeq database read and the expiry sweep run OUTSIDE the
	// admission guard; only the frame admissions enter it.
	for ws := range g.reg.WorkspaceIDs() {
		conns := g.reg.RoomMembers(core.ServerRoom(ws))
		if len(conns) == 0 {
			continue
		}
		seq, err := g.opts.Heartbeat.WorkspaceSeq(context.Background(), ws)
		if err != nil {
			g.log.Warn("socketio: heartbeat source failed", "component", "socketio", "workspace", ws, "error", err)
			continue
		}
		payload, err := json.Marshal(heartbeatPayload{Seq: seq, TS: g.clk.Now().UnixMilli()})
		if err != nil {
			continue
		}
		live := conns[:0]
		for _, cs := range conns {
			// A socket never outlives its own token: the heartbeat sweep
			// closes connections whose frozen token proof has expired.
			if cs.Identity().Expired(g.clk.Now()) {
				g.metrics.expiredClosed.Add(1)
				g.dropConn(cs, "token-expired")
				continue
			}
			live = append(live, cs)
		}
		frame := core.Frame{Event: core.EventHeartbeat, Payload: payload}
		// Guarded admission for the whole batch: a revocation committing
		// mid-sweep cannot interleave between any connection's eligibility
		// check and its queue offer. An abandoned guard skips this tick's
		// frames — periodic telemetry self-heals on the next tick, and
		// revocation eviction still closes unauthorized connections, so no
		// disconnect storm is triggered while the fence is saturated.
		if err := g.withGuard(context.Background(), func() error {
			for _, cs := range live {
				if err := g.enqueue(cs, frame); err != nil {
					g.handleEnqueueErr(cs, err)
				}
				g.metrics.heartbeats.Add(1)
			}
			return nil
		}); err != nil {
			g.metrics.guardAbandoned.Add(1)
			g.log.Warn("socketio: heartbeat admission abandoned", "component", "socketio", "workspace", ws, "error", err)
		}
	}
}

type heartbeatPayload struct {
	Seq int64 `json:"seq"`
	TS  int64 `json:"ts"`
}

// Close shuts the gateway down: no new handshakes or goroutines, every
// hijacked connection reaped via CloseAll, then wait for drainers,
// barriers and the heartbeat loop to join. Hijacked sockets are NOT closed
// by net/http Server.Shutdown — the app must call this (the machinews hub
// pattern).
func (g *Gateway) Close() error {
	g.closeOnce.Do(func() {
		g.life.MarkClosed()
		g.doneOnce.Do(func() { close(g.doneCh) })
		if t := g.transport(); t != nil {
			t.CloseAll()
		}
		// The binding reports closures asynchronously; do not depend on
		// it: close every tracked queue so drainers exit even if a
		// Closed callback races shutdown, then join everything.
		for _, id := range g.reg.IDs() {
			if cs, ok := g.reg.Get(id); ok {
				cs.Queue().Close()
			}
		}
		g.life.Wait()
		g.closeErr = nil
	})
	return g.closeErr
}
