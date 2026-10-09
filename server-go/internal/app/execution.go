package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/url"
	"sync"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/application/machinecontrol"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/config"
	"raft.local/server-go/internal/runtimecatalog"
	"raft.local/server-go/internal/transport/machinews"
	"raft.local/server-go/internal/workspace"
)

// controlPlane is one local execution control plane. Identity, credential,
// channel and live connection services share the application's SQLite DB;
// no TS service, Redis, background LLM or second machine catalog is involved.
type controlPlane struct {
	machines  *machinews.Hub
	computers *computer.Store
	agents    *agent.Store
	service   *agent.Service
	channels  *channel.Store
	runners   *agent.RunnerAccess
	catalog   *runtimecatalog.Store
	broker    *runtimecatalog.Broker

	cfg      *config.Config
	sessions *auth.SessionService
	signer   *auth.TokenSigner
	close    sync.Once
	closeErr error
}

func buildControl(db *sql.DB, cfg *config.Config, sessions *auth.SessionService, signer *auth.TokenSigner, logger *slog.Logger) (*controlPlane, error) {
	clk := clock.Real{}
	computers, err := computer.NewStore(db, computer.Options{
		Clock: clk, DeviceCodePepper: cfg.JWTSecret,
	})
	if err != nil {
		return nil, err
	}
	credentialHasher, err := agent.NewCredentialHasher(cfg.JWTSecret)
	if err != nil {
		return nil, err
	}
	store := agent.NewStore(db, agent.StoreOptions{
		Clock: clk, Hasher: credentialHasher,
		OnboardingOpenerV2:      cfg.WorkspacePolicy.OnboardingOpenerV2,
		SelfHostedRunnerEnabled: cfg.Computer.AgentBootstrapEnabled,
	})
	runners, err := agent.NewRunnerAccess(db, agent.RunnerAccessOptions{Clock: clk, Hasher: credentialHasher})
	if err != nil {
		return nil, err
	}
	m := &controlPlane{
		computers: computers, agents: store, runners: runners,
		channels: channel.NewStoreWithOptions(db, channel.Options{Clock: clk}),
		catalog:  runtimecatalog.NewStore(db), cfg: cfg, sessions: sessions, signer: signer,
	}
	// Hub -> coordinator -> service/broker -> Hub is an assembly cycle, not
	// permission to mutate a live service. Bind the callback-local reference
	// exactly once below, after its required dependencies exist and before
	// exposing any listener. No reference to this slot leaves the callbacks.
	var coordinator *machinecontrol.Coordinator
	presence, err := computer.NewPresenceStore(db, computer.PresenceOptions{})
	if err != nil {
		return nil, err
	}
	hub, err := machinews.NewHub(machinews.Config{
		Facts: presence,
		Clock: clk, Logger: logger, Authenticator: computers,
		ValidatePrincipal: computers.ValidatePrincipal,
		ReadLimit:         4 << 20, SendQueueDepth: 128,
		OnReady: func(ctx context.Context, p computer.Principal, raw json.RawMessage) error {
			return coordinator.OnReady(ctx, p, raw)
		},
		OnMessage: func(ctx context.Context, p computer.Principal, raw json.RawMessage) error {
			return coordinator.OnMessage(ctx, p, raw)
		},
		OnDisconnect: func(ctx context.Context, p computer.Principal) error {
			return coordinator.OnDisconnect(ctx, p)
		},
	})
	if err != nil {
		return nil, err
	}
	m.machines = hub
	m.broker = runtimecatalog.NewBroker(runtimecatalog.BrokerConfig{
		Gateway: hub,
		Generation: func(id string) (uint64, bool) {
			current := hub.Snapshot(id)
			if current == nil {
				return 0, false
			}
			return current.Generation, true
		},
	})
	m.service = agent.NewService(store, agent.ServiceOptions{
		Gateway: hub, ServerURL: configuredControlPlaneURL(cfg).String(),
		DeviceAuthEnabled: cfg.Computer.DeviceLoginEnabled, Logger: logger,
	})
	coordinator, err = machinecontrol.NewCoordinator(m.service, m.broker, computers.ValidatePrincipal)
	if err != nil {
		return nil, errors.Join(err, m.Close())
	}
	return m, nil
}

func (m *controlPlane) probe(ctx context.Context, id string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return m.machines.IsOnline(id), nil
}

func (m *controlPlane) metadata(ctx context.Context, id string) (*workspace.LiveMachineMetadata, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	live := m.machines.Snapshot(id)
	if live == nil {
		return nil, nil
	}
	return &workspace.LiveMachineMetadata{
		WorkspaceID: live.ServerID, DaemonVersion: live.DaemonVersion,
		ComputerVersion: live.ComputerVersion, HostKind: live.HostKind,
		RuntimeVersions: live.RuntimeVersions,
	}, nil
}

func (m *controlPlane) Close() error {
	m.close.Do(func() {
		// Hijacked WebSockets are not closed by net/http.Server.Shutdown.
		// Join machine handlers/callbacks before App releases the database.
		m.closeErr = m.machines.Close()
		if closer, ok := any(m.broker).(interface{ Close() error }); ok {
			m.closeErr = errors.Join(m.closeErr, closer.Close())
		}
	})
	return m.closeErr
}

// The original Computer client may use the Web origin when its configured
// reverse proxy forwards HTTP and /daemon WebSockets. Never derive a
// credential-bearing verification link or daemon launch URL from Host.
func configuredControlPlaneURL(cfg *config.Config) *url.URL {
	if cfg.WebOrigin != nil {
		copied := *cfg.WebOrigin
		return &copied
	}
	host, port, err := net.SplitHostPort(cfg.ListenAddr)
	if err != nil || port == "" {
		return &url.URL{Scheme: "http", Host: "127.0.0.1:4301"}
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return &url.URL{Scheme: "http", Host: net.JoinHostPort(host, port)}
}
