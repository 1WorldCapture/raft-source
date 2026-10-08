package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"sync"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/channel"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/config"
	"raft.local/server-go/internal/runtimecatalog"
	"raft.local/server-go/internal/transport/legacyweb"
	"raft.local/server-go/internal/transport/machinews"
	"raft.local/server-go/internal/workspace"
)

// m3Runtime is one local execution control plane. Identity, credential,
// channel and live connection services share the application's SQLite DB;
// no TS service, Redis, background LLM or second machine catalog is involved.
type m3Runtime struct {
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

func buildM3(db *sql.DB, cfg *config.Config, sessions *auth.SessionService, signer *auth.TokenSigner, logger *slog.Logger) (*m3Runtime, error) {
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
	m := &m3Runtime{
		computers: computers, agents: store, runners: runners,
		channels: channel.NewStoreWithOptions(db, channel.Options{Clock: clk}),
		catalog:  runtimecatalog.NewStore(db), cfg: cfg, sessions: sessions, signer: signer,
	}
	// Closures are wired before any listener is exposed. The Hub does not
	// receive an inbound frame while m.service/m.broker are being assembled.
	hub, err := machinews.NewHub(machinews.Config{
		DB: db, Clock: clk, Logger: logger, Authenticator: computers,
		ValidatePrincipal: computers.ValidatePrincipal,
		ReadLimit:         4 << 20, SendQueueDepth: 128,
		OnReady: func(ctx context.Context, principal computer.Principal, raw json.RawMessage) error {
			if err := computers.ValidatePrincipal(ctx, principal); err != nil {
				return err
			}
			return m.service.OnReady(ctx, principal, raw)
		},
		OnMessage: func(ctx context.Context, principal computer.Principal, raw json.RawMessage) error {
			if err := computers.ValidatePrincipal(ctx, principal); err != nil {
				return err
			}
			handled, err := m.broker.OnMachineMessage(ctx, principal, raw)
			if handled || err != nil {
				return err
			}
			return m.service.OnMessage(ctx, principal, raw)
		},
		OnDisconnect: func(ctx context.Context, principal computer.Principal) error {
			m.broker.Disconnect(principal.MachineID)
			return m.service.OnDisconnect(ctx, principal)
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
	return m, nil
}

func (m *m3Runtime) register(mux *http.ServeMux, gate *legacyweb.AuthGate, servers *legacyweb.ServersHandlers) {
	internalRoutes := []computer.InternalRouteEntry{
		{Method: http.MethodPost, Path: "/preflight", Principal: "sk_computer"},
	}
	internalRoutes = append(internalRoutes, legacyweb.RunnerRouteManifest()...)
	internalRoutes = append(internalRoutes, agent.IdentityInternalRoutes()...)
	computerHandlers := &legacyweb.ComputerHandlers{
		Store:                 m.computers,
		Sessions:              legacyweb.SessionServices{Sessions: m.sessions, Signer: m.signer},
		VerificationBaseURL:   configuredControlPlaneURL(m.cfg),
		DeviceLoginEnabled:    m.cfg.Computer.DeviceLoginEnabled,
		AgentBootstrapEnabled: m.cfg.Computer.AgentBootstrapEnabled,
		AgentBootstrap:        agent.NewBootstrapExchanger(m.agents),
		Scope:                 servers.RequireServerScope,
		// Credential rotation/deletion commits first, then immediately retires
		// the authenticated connection instead of waiting for its next ping.
		DisconnectMachine: m.machines.Disconnect,
		InternalRoutes:    internalRoutes,
		ClaimedPrefixes:   []string{"/internal/computer/", "/internal/agent-api/"},
	}
	legacyweb.RegisterChannelRoutes(mux, &legacyweb.ChannelHandlers{Store: m.channels}, gate)
	legacyweb.RegisterComputerRoutes(mux, computerHandlers, gate)
	legacyweb.RegisterAgentRoutes(mux, &legacyweb.AgentHandlers{
		Store: m.agents, Service: m.service, Computers: computerHandlers,
		RuntimeCatalog: m.broker,
		AvatarDir:      filepath.Join(m.cfg.DataDir, "avatars"),
	}, gate)
	legacyweb.RegisterRunnerRoutes(mux, &legacyweb.RunnerHandlers{
		Access: m.runners, Computers: computerHandlers, Lifecycle: m.service,
	})
	legacyweb.RegisterRuntimeCatalogRoutes(mux, &legacyweb.RuntimeCatalogHandlers{
		Store: m.catalog, Broker: m.broker,
	}, gate)
	mux.Handle("GET /daemon/connect", m.machines)
}

func (m *m3Runtime) probe(ctx context.Context, id string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	return m.machines.IsOnline(id), nil
}

func (m *m3Runtime) metadata(ctx context.Context, id string) (*workspace.LiveMachineMetadata, error) {
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

func (m *m3Runtime) Close() error {
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
