package machinews

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/clock"
)

// MachineFacts is the required port over the computer-owned persistent
// machine facts (the REAL machines row). The hub calls it synchronously
// inside the current connection's admission guard; inputs are the verified
// Computer principal and a typed observation, never a SQL handle. The
// computer package provides the production implementation
// (*computer.PresenceStore).
type MachineFacts interface {
	// ApplyReady persists one ready observation (runtimes always, optional
	// hostname/os/daemon/computer version) and revalidates the principal
	// inside the same short transaction.
	ApplyReady(ctx context.Context, facts computer.ReadyFacts, principal computer.Principal) error
	// TouchHeartbeat records a pong observation with the principal
	// revalidated inside the write transaction.
	TouchHeartbeat(ctx context.Context, machineID string, at time.Time, principal computer.Principal) error
	// RecordStatusTransition applies the monotonic online/offline rules and
	// reports the stored record and whether the machine row exists.
	RecordStatusTransition(ctx context.Context, machineID, status string, at time.Time, principal computer.Principal) (computer.StatusRecord, bool, error)
	// Exists reports whether the machine row exists.
	Exists(ctx context.Context, machineID string) (bool, error)
}

// Default bounds. Every default reproduces the original TypeScript server's
// value where one exists (see the contract doc for the source of each).
const (
	// DefaultHeartbeatInterval matches the TS server ping cadence
	// (startMachineHeartbeat, 30s).
	DefaultHeartbeatInterval = 30 * time.Second

	// DefaultHeartbeatTimeout matches AgentOrchestrator.MACHINE_HEARTBEAT_TIMEOUT_MS.
	DefaultHeartbeatTimeout = 60 * time.Second

	// DefaultDisconnectGrace matches MACHINE_DISCONNECT_PROJECTION_GRACE_MS.
	DefaultDisconnectGrace = 2 * time.Second

	// DefaultWriteTimeout bounds one outbound frame write (daemon writes in
	// the TS server had no explicit bound; Go needs one so a dead peer
	// cannot pin a writer forever).
	DefaultWriteTimeout = 30 * time.Second

	// DefaultReadLimit matches the ws library default maxPayload (100 MiB)
	// the TypeScript WebSocketServer actually ran with. It is a hard bound;
	// lower it via Config if an operator wants a tighter one.
	DefaultReadLimit = 100 * 1024 * 1024

	// DefaultSendQueueDepth bounds the per-connection outbound backlog.
	DefaultSendQueueDepth = 1024

	// DefaultReadyRetryInterval is the machine-facts persist retry cadence
	// (TS enqueueCapabilitiesPersist converges on a capped backoff; a flat
	// short interval is used here, newest payload wins).
	DefaultReadyRetryInterval = 5 * time.Second

	// DefaultAuthRecheckInterval is retained so existing Config values still
	// resolve. It no longer gates authorization: every mutating frame, pong,
	// ready, callback and Send revalidates the principal cheaply. Argon2
	// runs at handshake Authenticate only.
	DefaultAuthRecheckInterval = 30 * time.Second

	factsWriteTimeout = 5 * time.Second
)

// Config assembles a Hub. Required fields are validated by NewHub; zero
// bounds fall back to the documented defaults. See docs/m3-machinews-contract.md.
type Config struct {
	Authenticator Authenticator
	Facts         MachineFacts
	Clock         clock.Clock
	Logger        *slog.Logger
	Scheduler     Scheduler

	// ValidatePrincipal cheaply rechecks a previously proven principal
	// (credential revision, revocation, workspace and machine binding)
	// before every mutating frame, pong, ready persist, callback and Send.
	// Nil selects Authenticator when that value implements the same method,
	// which *computer.Store does. Argon2 is not used on this path.
	ValidatePrincipal func(ctx context.Context, p computer.Principal) error

	OnReady      OnReadyCallback
	OnMessage    OnMessageCallback
	OnDisconnect OnDisconnectCallback

	HeartbeatInterval   time.Duration
	HeartbeatTimeout    time.Duration
	DisconnectGrace     time.Duration
	WriteTimeout        time.Duration
	ReadLimit           int64
	SendQueueDepth      int
	ReadyRetryInterval  time.Duration
	AuthRecheckInterval time.Duration
}

// WithDefaults returns a copy of cfg with every zero bound replaced by its
// default. It is exported so the parent can log the resolved bounds.
func (cfg Config) WithDefaults() Config {
	out := cfg
	if out.HeartbeatInterval <= 0 {
		out.HeartbeatInterval = DefaultHeartbeatInterval
	}
	if out.HeartbeatTimeout <= 0 {
		out.HeartbeatTimeout = DefaultHeartbeatTimeout
	}
	if out.DisconnectGrace <= 0 {
		out.DisconnectGrace = DefaultDisconnectGrace
	}
	if out.WriteTimeout <= 0 {
		out.WriteTimeout = DefaultWriteTimeout
	}
	if out.ReadLimit <= 0 {
		out.ReadLimit = DefaultReadLimit
	}
	if out.SendQueueDepth <= 0 {
		out.SendQueueDepth = DefaultSendQueueDepth
	}
	if out.ReadyRetryInterval <= 0 {
		out.ReadyRetryInterval = DefaultReadyRetryInterval
	}
	if out.AuthRecheckInterval <= 0 {
		out.AuthRecheckInterval = DefaultAuthRecheckInterval
	}
	return out
}

// validate checks the required dependencies.
func (cfg Config) validate() error {
	if cfg.Authenticator == nil {
		return errors.New("machinews: Config.Authenticator is required")
	}
	if cfg.Facts == nil {
		return errors.New("machinews: Config.Facts is required")
	}
	if cfg.Clock == nil {
		return errors.New("machinews: Config.Clock is required")
	}
	return nil
}
