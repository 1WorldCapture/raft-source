package machinews

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/clock"
)

// ConnectPath is the exact legacy endpoint this hub serves. The parent wires
// mux.Handle(ConnectPath, hub); any other path reaching the hub 404s.
const ConnectPath = "/daemon/connect"

// Hub is the /daemon/connect machine connection transport. It owns
// handshake authentication (via the COMPUTER authenticator), per-machine
// generation fencing, heartbeats, replacement, revocation and the delayed
// offline projection, delegating message semantics to the injected callbacks.
type Hub struct {
	cfg               Config
	facts             *machineFacts
	logger            *slog.Logger
	clock             clock.Clock
	scheduler         Scheduler
	baseCtx           context.Context
	cancelBase        context.CancelFunc
	validatePrincipal func(context.Context, computer.Principal) error

	mu    sync.Mutex
	slots map[string]*machineSlot
	life  lifetime

	closeMu  sync.Mutex
	closeCh  chan struct{}
	closeErr error
	closing  atomic.Bool

	// Test barriers. Production leaves them nil. testDropFence runs with the
	// per-machine lock released after admission and before the commit, so a
	// replacement can win and the commit must then refuse. testHoldFence runs
	// while the lock is held.
	testDropFence     func(op, machineID string, generation uint64)
	testHoldFence     func(op, machineID string, generation uint64)
	testBeforePublish func(machineID string)
	testBeforeWait    func()
	testCloseWaiter   func()
}

// pendingOffline is one scheduled delayed disconnect projection.
// ctx is generation-scoped and parented on the hub, not on the socket: the
// socket context is already canceled by the time the grace timer fires.
// Supersede and hub shutdown cancel ctx so a late callback cannot target
// the replacement connection.
type pendingOffline struct {
	slot           *machineSlot
	machineID      string
	generation     uint64
	serverID       string
	disconnectedAt time.Time
	cause          string
	principal      computer.Principal
	ctx            context.Context
	cancel         context.CancelFunc
	stop           func()
	haltOnce       sync.Once
}

// NewHub validates the configuration and returns a ready hub. It performs no
// I/O. See docs/m3-machinews-contract.md for the stable constructor.
func NewHub(cfg Config) (*Hub, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	check, err := resolvePrincipalCheck(cfg)
	if err != nil {
		return nil, err
	}
	cfg = cfg.WithDefaults()
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	sched := cfg.Scheduler
	if sched == nil {
		sched = RealScheduler{}
	}
	baseCtx, cancel := context.WithCancel(context.Background())
	return &Hub{
		cfg:               cfg,
		facts:             &machineFacts{db: cfg.DB},
		logger:            logger,
		clock:             cfg.Clock,
		scheduler:         sched,
		baseCtx:           baseCtx,
		cancelBase:        cancel,
		validatePrincipal: check,
		slots:             map[string]*machineSlot{},
	}, nil
}

func resolvePrincipalCheck(cfg Config) (func(context.Context, computer.Principal) error, error) {
	if cfg.ValidatePrincipal != nil {
		return cfg.ValidatePrincipal, nil
	}
	type checker interface {
		ValidatePrincipal(context.Context, computer.Principal) error
	}
	if v, ok := cfg.Authenticator.(checker); ok {
		return v.ValidatePrincipal, nil
	}
	return nil, errors.New("machinews: Config.ValidatePrincipal is required")
}

// ServeHTTP implements the /daemon/connect handshake. Authentication runs
// BEFORE the WebSocket upgrade so a deny is a plain HTTP 401 carrying the
// closed-set Slock-Reason header (never a close frame, never a key echo).
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != ConnectPath {
		http.NotFound(w, r)
		return
	}
	if !h.life.enter() {
		http.Error(w, "machine transport shutting down", http.StatusServiceUnavailable)
		return
	}
	defer h.life.leave()
	if h.closing.Load() {
		http.Error(w, "machine transport shutting down", http.StatusServiceUnavailable)
		return
	}

	authCtx, authCancel := context.WithCancel(r.Context())
	defer authCancel()
	stopAuth := context.AfterFunc(h.baseCtx, authCancel)
	defer stopAuth()

	apiKey := extractAPIKey(r)
	principal, err := h.cfg.Authenticator.Authenticate(authCtx, apiKey)
	if err != nil {
		if h.closing.Load() || authCtx.Err() != nil {
			http.Error(w, "machine transport shutting down", http.StatusServiceUnavailable)
			return
		}
		reason, known := denyReasonFrom(err)
		if !known {
			h.logger.Error("machine handshake authentication failed",
				"error", err.Error(), "reason", ReasonException)
			h.rejectHandshake(w, http.StatusInternalServerError, "")
			return
		}
		h.logger.Info("machine handshake denied", "reason", reason)
		h.rejectHandshake(w, http.StatusUnauthorized, reason)
		return
	}
	if principal.MachineID == "" || principal.WorkspaceID == "" {
		h.logger.Error("authenticator returned an incomplete principal for an accepted key",
			"reason", ReasonException)
		h.rejectHandshake(w, http.StatusInternalServerError, "")
		return
	}
	if h.closing.Load() {
		http.Error(w, "machine transport shutting down", http.StatusServiceUnavailable)
		return
	}

	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		h.logger.Warn("machine websocket upgrade failed", "error", err.Error())
		return
	}
	ws.SetReadLimit(h.cfg.ReadLimit)

	c := &machineConn{
		hub:       h,
		ws:        ws,
		machineID: principal.MachineID,
		serverID:  principal.WorkspaceID,
		principal: principal,
		kind:      principal.Kind,
		sendQueue: make(chan []byte, h.cfg.SendQueueDepth),
		limiter:   newIngressLimiter(),
	}
	c.ctx, c.cancel = context.WithCancel(h.baseCtx)
	now := h.clock.Now()
	c.lastPong = now
	c.lastIngress = now

	if !h.claim(c) {
		_ = ws.CloseNow()
		return
	}
	if err := c.writeContext(); err != nil {
		h.logger.Error("failed to send machine context; closing",
			"machine_id", c.machineID, "error", err.Error())
		h.abandon(c, websocket.StatusInternalError, causeContextSendFailed)
		return
	}
	if h.testBeforePublish != nil {
		h.testBeforePublish(c.machineID)
	}
	if h.closing.Load() {
		h.abandon(c, websocket.StatusGoingAway, "going_away")
		return
	}
	if err := h.publish(c); err != nil {
		h.failPublish(c, err)
		return
	}
	if !h.life.enter() {
		h.abandon(c, websocket.StatusGoingAway, "going_away")
		return
	}
	if !h.life.enter() {
		h.life.leave()
		h.abandon(c, websocket.StatusGoingAway, "going_away")
		return
	}
	go c.serve()
	go c.writeLoop()
	h.logger.Info("machine connected",
		"machine_id", c.machineID, "server_id", c.serverID, "principal_kind", principal.Kind)
}

func (h *Hub) rejectHandshake(w http.ResponseWriter, code int, reason string) {
	if reason != "" {
		w.Header().Set("Slock-Reason", reason)
	}
	w.WriteHeader(code)
}

func (h *Hub) machineSlot(machineID string) *machineSlot {
	h.mu.Lock()
	defer h.mu.Unlock()
	s := h.slots[machineID]
	if s == nil {
		s = &machineSlot{}
		h.slots[machineID] = s
	}
	return s
}

func (h *Hub) slotExisting(machineID string) *machineSlot {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.slots[machineID]
}

// claim fences any published connection for this machine and reserves the
// handshake. The caller is not online until publish, which runs only after
// the context frame is written.
func (h *Hub) claim(c *machineConn) bool {
	s := h.machineSlot(c.machineID)
	c.slot = s
	s.Lock()
	if h.closing.Load() {
		s.Unlock()
		return false
	}
	var closing []*machineConn
	var halted []*pendingOffline
	if old := s.conn; old != nil {
		old.markRetired()
		old.setLocalCause(causeReplaced)
		if s.displaced != nil {
			halted = append(halted, s.displaced)
		}
		s.displaced = h.newOffline(s, old, causeReplaced, h.clock.Now())
		s.conn = nil
		closing = append(closing, old)
	}
	if s.pending != nil && s.pending != c {
		s.pending.markRetired()
		s.pending.setLocalCause(causeReplaced)
		closing = append(closing, s.pending)
	}
	if s.offline != nil {
		// Suspend the previous disconnect projection while this handshake
		// is pending. Do not cancel its context yet: if the context frame
		// or publish fails, abandon must restore the offline transition.
		// Successful publish retires the saved projection permanently.
		if s.displaced == nil {
			if s.offline.stop != nil {
				s.offline.stop()
				s.offline.stop = nil
			}
			s.displaced = s.offline
		} else {
			halted = append(halted, s.offline)
		}
		s.offline = nil
	}
	s.connGeneration++
	c.generation = s.connGeneration
	s.pending = c
	s.Unlock()
	for _, prev := range halted {
		prev.halt()
	}
	for _, old := range closing {
		h.spawnClose(old, websocket.StatusNormalClosure, "")
	}
	return true
}

func (h *Hub) newOffline(s *machineSlot, c *machineConn, cause string, at time.Time) *pendingOffline {
	// Parent on the hub context. The socket context is canceled when the
	// connection is retired, which is before this projection is allowed to
	// write. The frame scope still names THIS connection, so OnDisconnect
	// cannot Send to a later generation.
	ctx, cancel := context.WithCancel(withFrameScope(h.baseCtx, c))
	return &pendingOffline{
		slot:           s,
		machineID:      c.machineID,
		generation:     c.generation,
		serverID:       c.serverID,
		disconnectedAt: at,
		cause:          cause,
		principal:      c.principal,
		ctx:            ctx,
		cancel:         cancel,
	}
}

func (p *pendingOffline) halt() {
	if p == nil {
		return
	}
	p.haltOnce.Do(func() {
		if p.stop != nil {
			p.stop()
		}
		if p.cancel != nil {
			p.cancel()
		}
	})
}

// publish makes c the current connection after the context frame succeeded.
func (h *Hub) publish(c *machineConn) error {
	s := c.slot
	s.Lock()
	defer s.Unlock()
	if h.closing.Load() || s.pending != c || c.isRetired() {
		return errStale
	}
	if err := h.revalidate(c.callbackContext(), c.principal); err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(c.ctx, factsWriteTimeout)
	defer cancel()
	_, found, err := h.facts.recordStatusTransition(writeCtx, c.machineID, "online", h.clock.Now(), c.principal)
	if err != nil {
		return err
	}
	if !found {
		return errNoMachineRow
	}
	var drop *pendingOffline
	if s.displaced != nil {
		drop = s.displaced
		s.displaced = nil
	}
	s.conn = c
	s.pending = nil
	s.statusVersion++
	c.armHeartbeat()
	if drop != nil {
		drop.halt()
	}
	return nil
}

func (h *Hub) failPublish(c *machineConn, err error) {
	code := websocket.StatusInternalError
	reason := "registration_failed"
	if errors.Is(err, errNoMachineRow) {
		reason = "machine_row_missing"
	}
	if errors.Is(err, errStale) || h.closing.Load() {
		code = websocket.StatusGoingAway
		reason = causeHubClosing
	}
	if ae := computer.AsAuthError(err); ae != nil {
		reason = ae.Reason
		code = websocket.StatusPolicyViolation
		if c.kind == computer.KindLegacyMachine && ae.Reason == computer.ReasonLegacyKeyMigrated {
			code = websocket.StatusCode(4002)
		}
	}
	h.logger.Warn("machine registration did not publish",
		"machine_id", c.machineID, "reason", reason, "error", err.Error())
	h.abandon(c, code, reason)
}

// abandon drops a handshake that never became the published connection.
func (h *Hub) abandon(c *machineConn, code websocket.StatusCode, reason string) {
	c.setLocalCause(reason)
	var fire *pendingOffline
	if s := c.slot; s != nil {
		s.Lock()
		if s.pending == c {
			s.pending = nil
		}
		if s.conn == c {
			s.conn = nil
		}
		if s.conn == nil && s.pending == nil && s.displaced != nil {
			fire = s.displaced
			s.displaced = nil
		}
		s.Unlock()
	}
	c.markRetired()
	c.retire()
	h.spawnClose(c, code, reason)
	if fire != nil {
		h.armOffline(fire)
	}
}

func (h *Hub) spawnClose(c *machineConn, code websocket.StatusCode, reason string) {
	if c == nil || c.ws == nil {
		return
	}
	c.setLocalCause(reason)
	body := func() {
		_ = c.ws.Close(code, reason)
		_ = c.ws.CloseNow()
		h.endConnection(c, c.localCauseOr(causeSocketError))
	}
	if !h.life.Go(body) {
		_ = c.ws.CloseNow()
		h.endConnection(c, c.localCauseOr(causeSocketError))
	}
}

// endConnection runs the disconnect pipeline exactly once.
func (h *Hub) endConnection(c *machineConn, cause string) {
	if c == nil || !c.ended.CompareAndSwap(false, true) {
		if c != nil {
			c.retire()
		}
		return
	}
	s := c.slot
	if s == nil {
		c.markRetired()
		c.retire()
		_ = c.ws.CloseNow()
		return
	}
	s.Lock()
	if h.closing.Load() || s.conn != c {
		if s.conn == c {
			s.conn = nil
		}
		if s.pending == c {
			s.pending = nil
		}
		s.Unlock()
		c.markRetired()
		c.retire()
		_ = c.ws.CloseNow()
		return
	}
	s.conn = nil
	c.markRetired()
	var prev *pendingOffline
	if s.offline != nil {
		prev = s.offline
		s.offline = nil
	}
	p := h.newOffline(s, c, cause, h.clock.Now())
	s.Unlock()
	if prev != nil {
		prev.halt()
	}
	c.retire()
	_ = c.ws.CloseNow()
	h.armOffline(p)
	if intent := c.ShutdownIntent(); intent != nil {
		h.logger.Info("machine disconnected with shutdown intent",
			"machine_id", c.machineID, "cause", cause, "shutdown_reason", intent.Reason)
		return
	}
	h.logger.Info("machine disconnected", "machine_id", c.machineID, "cause", cause)
}

func (h *Hub) armOffline(p *pendingOffline) {
	if p == nil {
		return
	}
	s := p.slot
	s.Lock()
	defer s.Unlock()
	if h.closing.Load() || p.ctx.Err() != nil || s.conn != nil || s.pending != nil {
		if s.offline == p {
			s.offline = nil
		}
		p.halt()
		return
	}
	if s.offline != nil && s.offline != p {
		s.offline.halt()
	}
	if p.stop != nil {
		p.stop()
	}
	p.stop = h.bindAfter(h.cfg.DisconnectGrace, func() { h.applyOffline(p) })
	s.offline = p
}

func (h *Hub) applyOffline(p *pendingOffline) {
	s := p.slot
	s.Lock()
	held := true
	defer func() {
		if held {
			s.Unlock()
		}
	}()
	if !h.offlineCurrent(s, p) || p.ctx.Err() != nil {
		return
	}
	if h.testDropFence != nil {
		hook := h.testDropFence
		s.Unlock()
		held = false
		hook("offline", p.machineID, p.generation)
		s.Lock()
		held = true
		if !h.offlineCurrent(s, p) || p.ctx.Err() != nil {
			return
		}
	}
	if err := h.revalidate(p.ctx, p.principal); err != nil {
		h.finishOfflineAttempt(s, p, err)
		return
	}
	if h.testHoldFence != nil {
		h.testHoldFence("offline", p.machineID, p.generation)
		if !h.offlineCurrent(s, p) || p.ctx.Err() != nil {
			return
		}
	}
	writeCtx, cancel := context.WithTimeout(p.ctx, factsWriteTimeout)
	_, found, err := h.facts.recordStatusTransition(writeCtx, p.machineID, "offline", p.disconnectedAt, p.principal)
	cancel()
	if err != nil || !found {
		if err == nil {
			err = errNoMachineRow
		}
		h.finishOfflineAttempt(s, p, err)
		return
	}
	s.offline = nil
	s.statusVersion++
	if h.cfg.OnDisconnect != nil {
		if cbErr := h.cfg.OnDisconnect(p.ctx, p.principal); cbErr != nil {
			h.logger.Warn("OnDisconnect callback failed",
				"machine_id", p.machineID, "error", cbErr.Error())
		}
	}
	p.halt()
	h.logger.Info("machine projected offline", "machine_id", p.machineID, "cause", p.cause)
}

// finishOfflineAttempt drops the projection on auth failure, cancellation and
// a missing row. Infrastructure errors keep the same generation context and
// try again later; they never call OnDisconnect.
func (h *Hub) finishOfflineAttempt(s *machineSlot, p *pendingOffline, err error) {
	if !h.offlineCurrent(s, p) {
		return
	}
	auth := computer.AsAuthError(err) != nil
	canceled := errors.Is(err, context.Canceled) || p.ctx.Err() != nil || h.closing.Load()
	missing := errors.Is(err, errNoMachineRow)
	if auth || canceled || missing {
		s.offline = nil
		p.halt()
		if auth && !canceled {
			h.logger.Info("offline projection dropped after principal denial",
				"machine_id", p.machineID, "error", err.Error())
		}
		return
	}
	h.logger.Warn("offline projection failed; will retry",
		"machine_id", p.machineID, "error", err.Error())
	if p.stop != nil {
		p.stop()
	}
	p.stop = h.bindAfter(h.cfg.DisconnectGrace, func() { h.applyOffline(p) })
}

func (h *Hub) offlineCurrent(s *machineSlot, p *pendingOffline) bool {
	return !h.closing.Load() && s.conn == nil && s.pending == nil && s.offline == p
}

// withCurrent runs fn only while c is the published connection and its
// principal still validates. The per-machine lock covers that check and fn,
// so a replacement cannot commit over this generation. testDropFence opens
// one deliberate gap and the admission is repeated before any write.
func (h *Hub) withCurrent(c *machineConn, op string, fn func(context.Context) error) error {
	return h.admitCurrent(c, op, func(ctx context.Context) error {
		if err := h.revalidate(ctx, c.principal); err != nil {
			return err
		}
		if !h.owns(c.slot, c) {
			return errStale
		}
		if fn == nil {
			return nil
		}
		return fn(ctx)
	})
}

// admitCurrent is withCurrent without the principal check. Ready uses it so
// a failed validation still keeps the newest payload for a later retry.
func (h *Hub) admitCurrent(c *machineConn, op string, fn func(context.Context) error) error {
	s := c.slot
	if s == nil {
		return errStale
	}
	s.Lock()
	held := true
	defer func() {
		if held {
			s.Unlock()
		}
	}()
	if !h.owns(s, c) {
		return errStale
	}
	if h.testDropFence != nil {
		id, gen := c.machineID, c.generation
		hook := h.testDropFence
		s.Unlock()
		held = false
		hook(op, id, gen)
		if c.ctx.Err() != nil || h.closing.Load() {
			return errStale
		}
		s.Lock()
		held = true
		if !h.owns(s, c) {
			return errStale
		}
	}
	if h.testHoldFence != nil {
		h.testHoldFence(op, c.machineID, c.generation)
		if !h.owns(s, c) {
			return errStale
		}
	}
	cbCtx := c.callbackContext()
	if err := cbCtx.Err(); err != nil {
		return err
	}
	if fn == nil {
		return nil
	}
	return fn(cbCtx)
}

func (h *Hub) revalidate(ctx context.Context, principal computer.Principal) error {
	vctx, cancel := context.WithTimeout(ctx, factsWriteTimeout)
	defer cancel()
	if err := vctx.Err(); err != nil {
		return err
	}
	return h.validatePrincipal(vctx, principal)
}

func (h *Hub) owns(s *machineSlot, c *machineConn) bool {
	return !h.closing.Load() && s.conn == c && !c.isRetired()
}

func (h *Hub) revoke(c *machineConn, err error) {
	reason, known := denyReasonFrom(err)
	if !known {
		reason = ReasonException
	}
	c.setLocalCause(causePrincipalRevoked + ":" + reason)
	c.markRetired()
	c.stopFactsRetry()
	code := websocket.StatusPolicyViolation
	if c.kind == computer.KindLegacyMachine && reason == computer.ReasonLegacyKeyMigrated {
		code = websocket.StatusCode(4002)
	}
	h.spawnClose(c, code, reason)
}

// IsOnline reports whether the machine currently holds a published connection.
// A handshake that has not finished its context frame is offline.
func (h *Hub) IsOnline(machineID string) bool {
	s := h.slotExisting(machineID)
	if s == nil {
		return false
	}
	s.Lock()
	defer s.Unlock()
	return s.conn != nil && !h.closing.Load()
}

// Status reports "online" (live published connection), "offline" (no
// connection, the machines row exists) or "unknown" (no machines row).
func (h *Hub) Status(machineID string) string {
	if h.IsOnline(machineID) {
		return "online"
	}
	ctx, cancel := context.WithTimeout(h.baseCtx, factsWriteTimeout)
	defer cancel()
	exists, err := h.facts.machineExists(ctx, machineID)
	if err != nil || !exists {
		return "unknown"
	}
	return "offline"
}

// StatusVersion is the per-machine online/offline transition counter. It is
// 0 until this process publishes the machine, and it is not a global
// connection-generation counter. CurrentSnapshot.Generation is the live
// connection generation; this value also advances when the offline projection
// commits.
func (h *Hub) StatusVersion(machineID string) uint64 {
	s := h.slotExisting(machineID)
	if s == nil {
		return 0
	}
	s.Lock()
	defer s.Unlock()
	return s.statusVersion
}

// Send serializes payload as one text frame onto one connection.
// A context stamped with a connection generation (every ready, message and
// disconnect callback) can deliver only to that generation. Callers that
// pass a plain request context reach the machine's current connection.
// The per-machine lock covers revalidation and the enqueue. The socket
// write happens later, on the connection writer, without this lock.
func (h *Hub) Send(ctx context.Context, machineID string, payload any) error {
	if payload == nil {
		return errors.New("machinews: nil payload")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if h.closing.Load() {
		return ErrHubClosed
	}
	scope, scoped := frameScopeFrom(ctx)
	if scoped && scope.machineID != machineID {
		return ErrMachineOffline
	}
	s := h.slotExisting(machineID)
	if s == nil {
		if scoped {
			return ErrMachineOffline
		}
		return h.offlineOrUnknown(ctx, machineID)
	}
	s.Lock()
	held := true
	defer func() {
		if held {
			s.Unlock()
		}
	}()
	release := func() {
		if held {
			s.Unlock()
			held = false
		}
	}
	c := s.conn
	if h.closing.Load() {
		return ErrHubClosed
	}
	if scoped && (c == nil || c != scope.conn || c.generation != scope.generation || c.isRetired()) {
		return ErrMachineOffline
	}
	if c == nil || c.isRetired() {
		release()
		return h.offlineOrUnknown(ctx, machineID)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := h.revalidate(ctx, c.principal); err != nil {
		release()
		if computer.AsAuthError(err) != nil {
			h.revoke(c, err)
		}
		return err
	}
	if h.closing.Load() {
		return ErrHubClosed
	}
	if s.conn != c || c.isRetired() || (scoped && c.generation != scope.generation) {
		return ErrMachineOffline
	}
	return c.enqueue(data)
}

func (h *Hub) offlineOrUnknown(ctx context.Context, machineID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	exists, err := h.facts.machineExists(ctx, machineID)
	if err != nil {
		return err
	}
	if !exists {
		return ErrMachineUnknown
	}
	return ErrMachineOffline
}

// Disconnect invalidates the machine's active connection safely.
func (h *Hub) Disconnect(machineID string) {
	if h.closing.Load() {
		return
	}
	s := h.slotExisting(machineID)
	if s == nil {
		return
	}
	s.Lock()
	c := s.conn
	s.Unlock()
	if c == nil {
		return
	}
	c.setLocalCause(causeServerDisconnect)
	h.spawnClose(c, websocket.StatusNormalClosure, "")
	h.logger.Info("machine disconnected by server", "machine_id", machineID)
}

// Close shuts the hub down. Concurrent callers wait for the same completion
// and observe the same result. Close cancels in-flight handshakes, database
// work and callbacks, then waits until those goroutines leave.
func (h *Hub) Close() error {
	h.closeMu.Lock()
	if h.closeCh != nil {
		ch := h.closeCh
		h.closeMu.Unlock()
		if h.testCloseWaiter != nil {
			h.testCloseWaiter()
		}
		<-ch
		h.closeMu.Lock()
		err := h.closeErr
		h.closeMu.Unlock()
		return err
	}
	ch := make(chan struct{})
	h.closeCh = ch
	h.closeMu.Unlock()

	err := h.shutdown()

	h.closeMu.Lock()
	h.closeErr = err
	h.closeMu.Unlock()
	close(ch)
	return err
}

func (h *Hub) shutdown() error {
	h.closing.Store(true)
	h.life.markClosed()
	h.cancelBase()
	h.disconnectAll()
	if h.testBeforeWait != nil {
		h.testBeforeWait()
	}
	h.life.wait()
	return nil
}

func (h *Hub) disconnectAll() {
	h.mu.Lock()
	slots := make([]*machineSlot, 0, len(h.slots))
	for _, s := range h.slots {
		slots = append(slots, s)
	}
	h.mu.Unlock()
	var conns []*machineConn
	var halted []*pendingOffline
	for _, s := range slots {
		s.Lock()
		if s.conn != nil {
			conns = append(conns, s.conn)
			s.conn = nil
		}
		if s.pending != nil {
			conns = append(conns, s.pending)
			s.pending = nil
		}
		if s.offline != nil {
			halted = append(halted, s.offline)
		}
		if s.displaced != nil {
			halted = append(halted, s.displaced)
		}
		s.offline = nil
		s.displaced = nil
		s.Unlock()
	}
	for _, prev := range halted {
		prev.halt()
	}
	for _, c := range conns {
		c.markRetired()
		c.retire()
		// The hub context and all callbacks are already canceled. Waiting
		// for the peer's graceful close handshake here can consume a full
		// network timeout per unresponsive machine and block joined shutdown.
		// Force the transport closed; ordinary replacement/revocation still
		// uses its protocol-specific close frame outside global shutdown.
		_ = c.ws.CloseNow()
	}
}

// LiveConnection is an immutable copy of one published connection.
type LiveConnection struct {
	MachineID       string
	ServerID        string
	Generation      uint64
	DaemonVersion   string
	ComputerVersion string
	Capabilities    []string
	Runtimes        []string
	RuntimeVersions map[string]string
	HostKind        string
	ShutdownIntent  *shutdownIntent
}

// Snapshot returns the published connection, or nil when the machine is not
// currently online. The result shares no mutable state with the hub.
func (h *Hub) Snapshot(machineID string) *LiveConnection {
	return h.CurrentSnapshot(machineID)
}

// CurrentSnapshot returns an immutable copy of the current published
// connection only. Replaced handshakes and context frames that have not
// succeeded are omitted. Runtime catalog generation and the workspace
// directory must use this view.
func (h *Hub) CurrentSnapshot(machineID string) *LiveConnection {
	s := h.slotExisting(machineID)
	if s == nil {
		return nil
	}
	s.Lock()
	defer s.Unlock()
	c := s.conn
	if c == nil || h.closing.Load() {
		return nil
	}
	return c.cloneLive()
}

func (h *Hub) bindTick(d time.Duration, fn func()) func() {
	wrapped := func() {
		if !h.life.enter() {
			return
		}
		defer h.life.leave()
		fn()
	}
	if _, ok := h.scheduler.(RealScheduler); ok {
		return h.trackedTick(d, wrapped)
	}
	return h.scheduler.Tick(d, wrapped)
}

func (h *Hub) trackedTick(d time.Duration, fn func()) func() {
	if !h.life.enter() {
		return func() {}
	}
	done := make(chan struct{})
	var once sync.Once
	go func() {
		defer h.life.leave()
		ticker := time.NewTicker(d)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				fn()
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}

func (h *Hub) bindAfter(d time.Duration, fn func()) func() {
	return h.scheduler.After(d, func() {
		if !h.life.enter() {
			return
		}
		defer h.life.leave()
		fn()
	})
}
