package app

// HTTP assembly: this file builds the identity-scoped handler sets and the
// single router. It owns construction and wiring only — every rule lives in
// the adapter, application use case or domain that owns the facts.

import (
	"log/slog"
	"net/http"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/transport/httpapi"
	"raft.local/server-go/internal/transport/httpapi/agentapi"
	"raft.local/server-go/internal/transport/httpapi/computerapi"
	"raft.local/server-go/internal/transport/httpapi/httpx"
	"raft.local/server-go/internal/transport/httpapi/humanapi"
)

// buildHTTP assembles the full HTTP surface over the already-constructed
// services. socketIO is the realtime transport's handler (nil keeps the
// honest 501).
func (a *App) buildHTTP(socketIO http.Handler, logger *slog.Logger) http.Handler {
	chat := a.chat
	control := a.control
	avatarDir := a.Config.DataDir + "/avatars"

	// Human chat surfaces over the channel view and messaging use cases.
	channels := &humanapi.ChannelHandlers{
		Store: chat.channels, View: chat.channelView, Workspace: a.workspaceStore,
	}
	messages := humanapi.NewMessageHandlers(chat.messages, a.workspaceStore, chat.messaging)
	conversation := &humanapi.ConversationHandlers{
		Channels: chat.channels, Workspaces: a.workspaceStore, Messaging: chat.messaging,
	}

	// Human machine management on the workspace surface (R12): the same
	// computer domain store, behind the human verified-profile + scope gates.
	machineHandlers := &humanapi.MachineHandlers{
		Store: control.computers,
		Scope: a.serversHandlers.RequireServerScope,
		// Credential rotation/deletion commits first, then immediately retires
		// the authenticated connection instead of waiting for its next ping.
		DisconnectMachine: control.machines.Disconnect,
	}

	// Computer identity surfaces: admission exchange and the internal
	// control plane (machine MANAGEMENT lives in humanapi above).
	computerHandlers := &computerapi.ComputerHandlers{
		Store:                 control.computers,
		Sessions:              computerapi.SessionServices{Sessions: a.sessions, Signer: a.signer},
		VerificationBaseURL:   configuredControlPlaneURL(a.Config),
		DeviceLoginEnabled:    a.Config.Computer.DeviceLoginEnabled,
		AgentBootstrapEnabled: a.Config.Computer.AgentBootstrapEnabled,
		AgentBootstrap:        agent.NewBootstrapExchanger(control.agents),
		InternalRoutes:        a.internalRouteRegistry(),
		ClaimedPrefixes:       []string{"/internal/computer/", "/internal/agent-api/"},
	}

	handler := httpapi.New(httpapi.Config{
		Gate: a.gate,
		Account: &humanapi.Handlers{
			Auth: a.authService, Sessions: a.sessions, Signer: a.signer,
			Users: a.users, Gate: a.gate,
		},
		Servers: a.serversHandlers,
		Invites: a.inviteHandlers,
		Avatars: &humanapi.AvatarHandlers{
			Dir: avatarDir, MaxBytes: a.Config.MaxAvatarBytes, MaxSide: a.Config.MaxAvatarSidePixels,
			Auth: a.authService, Users: a.users,
		},
		RateLimits: humanapi.RateLimits{
			AuthPerMinute:         a.Config.AuthRatePerMinute,
			LoginAccountPerMinute: a.Config.LoginAccountRatePerMinute,
			RegisterPerHour:       a.Config.RegisterRatePerHour,
			ForgotPasswordPerHour: a.Config.ForgotPasswordRatePerHour,
		},
		Channels:     channels,
		Conversation: conversation,
		Messages:     messages,
		Readstate:    &humanapi.ReadstateHandlers{Store: chat.readstate, Workspace: a.workspaceStore},
		Agents: &humanapi.AgentHandlers{
			Store:          control.agents,
			Service:        control.service,
			AvatarDir:      avatarDir,
			RuntimeCatalog: control.broker,
		},
		AgentAPI: &agentapi.Handlers{Store: control.agents},
		Catalog: &humanapi.RuntimeCatalogHandlers{
			Store: control.catalog, Broker: control.broker,
		},
		Machines:  machineHandlers,
		Computers: computerHandlers,
		Runners: &computerapi.RunnerHandlers{
			Access: control.runners, Computers: control.computers, Lifecycle: control.service,
		},
		Daemon:   control.machines,
		SocketIO: socketIO,
	})
	return httpx.RequestID(logger)(httpx.SecurityHeaders(handler))
}

// internalRouteRegistry lists the /internal control-plane routes this
// process mounts (preflight plus the runner and agent identity registries).
func (a *App) internalRouteRegistry() []computer.InternalRouteEntry {
	routes := []computer.InternalRouteEntry{
		{Method: http.MethodPost, Path: "/preflight", Principal: "sk_computer"},
	}
	routes = append(routes, computerapi.RunnerRouteManifest()...)
	routes = append(routes, agent.IdentityInternalRoutes()...)
	return routes
}
