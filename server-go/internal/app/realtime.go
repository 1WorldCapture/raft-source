package app

// Realtime composition: this file assembles the Socket.IO transport
// (internal/transport/socketio + its zishang wire binding) with the bridge
// adapters (handshake/fence/guard/rooms/join/resume/heartbeat and the
// notification sink), the application realtime dispatcher (durable
// publication projection and audience policy) and the authority-eviction
// wake. This file owns only wiring and lifecycle: every rule lives in the
// module that owns the facts.

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	apprealtime "raft.local/server-go/internal/application/realtime"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/transport/socketio"
	"raft.local/server-go/internal/transport/socketio/bridge"
	"raft.local/server-go/internal/transport/socketio/core"
	"raft.local/server-go/internal/transport/socketio/zishang"
)

// authorityWakeBuffer bounds the eviction wake queue. The listener callback
// must never block; an overflow drops the wake (counted) because the fence
// generation check remains the final authorization guard.
const authorityWakeBuffer = 256

// realtimeConfig carries assembly inputs beyond the locked constructor
// signature. Zero values select the documented defaults.
type realtimeConfig struct {
	Logger            *slog.Logger
	Origins           []string
	HeartbeatInterval time.Duration // 0 -> original 15s cadence
	RoomSetupTimeout  time.Duration // 0 -> gateway default
}

// realtimeRuntime is the composed realtime surface: the Socket.IO gateway,
// its wire binding (http.Handler), the publication dispatcher and the
// authority eviction wake. Lifecycle: the parent mounts Handler() under
// /socket.io/ and MUST call Close before closing the database.
type realtimeRuntime struct {
	gateway *socketio.Gateway
	handler http.Handler
	pub     *apprealtime.Dispatcher
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

// buildRealtime is the locked constructor the parent calls after buildChat.
func buildRealtime(chat *chatServices, signer *auth.TokenSigner, logger *slog.Logger, origins []string) (*realtimeRuntime, error) {
	return assembleRealtime(chat, signer, realtimeConfig{Logger: logger, Origins: origins}, nil)
}

// assembleRealtime is the shared assembly path. transport is nil for
// production (the zishang Engine binds itself); the in-process protocol
// harness passes a fake Transport so the gateway contract can be driven
// without TCP.
func assembleRealtime(chat *chatServices, signer *auth.TokenSigner, cfg realtimeConfig, transport socketio.Transport) (*realtimeRuntime, error) {
	if chat == nil || chat.db == nil {
		return nil, errors.New("realtime: chat services are required")
	}
	if signer == nil {
		return nil, errors.New("realtime: token signer is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	facts, err := apprealtime.NewSocketFacts(chat.db, signer, chat.channels, chat.messages)
	if err != nil {
		return nil, err
	}
	serial := func() uint64 { return db.AuthoritySerial(chat.db) }
	bridgeCfg := bridge.Config{
		Facts:  facts,
		Serial: serial,
		AuthorityGeneration: func(kind, id string) uint64 {
			return db.AuthorityGeneration(chat.db, kind, id)
		},
		AuthorityGuard: func(ctx context.Context, fn func() error) error {
			return db.WithAuthorityReadContext(ctx, chat.db, fn)
		},
	}
	adapters := bridge.NewAdapters(bridgeCfg)
	gateway, err := socketio.New(socketio.Options{
		Logger:            logger,
		Auth:              adapters.HandshakeAuth,
		Fence:             adapters.Fence,
		Guard:             adapters.Guard,
		ChannelRooms:      adapters.ChannelRooms,
		Join:              adapters.Join,
		Resume:            adapters.Resume,
		Heartbeat:         adapters.Heartbeat,
		Origins:           cfg.Origins,
		HeartbeatInterval: cfg.HeartbeatInterval,
		RoomSetupTimeout:  cfg.RoomSetupTimeout,
	})
	if err != nil {
		return nil, err
	}

	sink := bridge.NewSink(gateway, serial)
	dispatcher, err := apprealtime.NewDispatcher(chat.db, sink, chat.messages, chat.channels, logger)
	if err != nil {
		return nil, err
	}
	r := &realtimeRuntime{
		gateway:    gateway,
		pub:        dispatcher,
		db:         chat.db,
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
	r.stopListening = db.RegisterAuthorityListener(chat.db, func(changes []db.AuthorityChange) {
		if len(changes) == 0 {
			return
		}
		select {
		case r.wakeCh <- changes:
		case <-r.wakeDone:
		default:
			n := r.wakesDropped.Add(1)
			if n == 1 || n%1000 == 0 {
				logger.Warn("realtime: authority wake queue full; eviction wake dropped (fence remains authoritative)",
					"dropped_total", n)
			}
		}
	})
	go r.wakeWorker()

	// Transactional outbox publisher: one bounded worker over durable
	// publication rows; the commit-listener wake inside Store.Start reacts
	// to every committed intent.
	r.stopPub = chat.publications.Start(context.Background(), r.pub.Publish, logger)

	if !gateway.StartHeartbeat() {
		// Closed concurrently during assembly; unwind everything.
		_ = r.Close()
		return nil, errors.New("realtime: gateway closed before heartbeat start")
	}
	return r, nil
}

// Handler is the /socket.io/ endpoint: websocket-only Engine.IO v4 with the
// origin allowlist and honest polling refusal enforced before the library.
func (r *realtimeRuntime) Handler() http.Handler { return r.handler }

// wakeWorker translates committed authority changes into gateway evictions.
// The fence already closed these connections' publish eligibility when the
// cache updated (before fence release); Revoke makes the transport close
// prompt instead of waiting for the next publish or heartbeat sweep.
func (r *realtimeRuntime) wakeWorker() {
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
func (r *realtimeRuntime) applyAuthorityChange(change db.AuthorityChange) {
	if change.Generation == 0 {
		// Persisted authority changes always have positive generations; do
		// not reinterpret a malformed wake as an unconditional revocation.
		r.logger.Warn("realtime: zero-generation authority wake ignored")
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
		r.logger.Warn("realtime: unknown authority scope kind ignored", "kind", change.Scope.Kind)
	}
}

// realtimeStats is the observability snapshot for tests and the report.
type realtimeStats struct {
	Gateway      socketio.Stats
	Publisher    apprealtime.Stats
	WakesDropped uint64
}

func (r *realtimeRuntime) Stats() realtimeStats {
	return realtimeStats{Gateway: r.gateway.Snapshot(), Publisher: r.pub.Stats(), WakesDropped: r.wakesDropped.Load()}
}

// Close tears the realtime surface down in dependency order: the publisher
// first (no new frames), then the eviction wake (no new closes), then the
// gateway — which raw-closes every hijacked socket net/http Shutdown cannot
// reach and joins the drainer, barrier and heartbeat goroutines. The parent
// MUST call this before closing the database handle.
func (r *realtimeRuntime) Close() error {
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
