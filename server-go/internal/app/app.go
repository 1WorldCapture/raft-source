// Package app is the composition root: it opens the database, derives keys,
// builds the domain services and application use cases, assembles the HTTP
// surface and owns the process lifecycle. No business rules live here.
package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/config"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/platform/keys"
	"raft.local/server-go/internal/platform/mail"
	"raft.local/server-go/internal/transport/httpapi/authn"
	"raft.local/server-go/internal/transport/httpapi/humanapi"
	"raft.local/server-go/internal/workspace"
)

// App is the assembled server.
type App struct {
	Config  *config.Config
	DB      *sql.DB
	Handler http.Handler

	gate        *authn.AuthGate
	users       authn.UserLookup
	authService *auth.Service
	sessions    *auth.SessionService
	signer      *auth.TokenSigner
	mailer      mail.Mailer
	maintenance *auth.MaintenanceService

	workspaceStore  *workspace.Store
	serversHandlers *humanapi.ServersHandlers
	inviteHandlers  *humanapi.InviteHandlers

	control  *controlPlane
	chat     *chatServices
	realtime *realtimeRuntime

	closeOnce sync.Once
	closeErr  error
}

// Options are the assembly inputs.
type Options struct {
	Config *config.Config
	Logger *slog.Logger
}

// Build opens storage, wires dependencies and returns the ready app.
func Build(opts Options) (*App, error) {
	cfg := opts.Config
	if cfg == nil {
		return nil, errors.New("app configuration is required")
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	handle, err := db.Open(filepath.Join(cfg.DataDir, "raft.db"))
	if err != nil {
		return nil, err
	}
	// db.Open registered the global authority fence entry for this handle, so
	// every failure from here on unwinds through ONE reverse-order cleanup:
	// the realtime runtime and the control plane own callbacks and workers
	// that touch the database and must join BEFORE the handle closes, and the
	// fence entry is released LAST. A fully assembled app hands ownership to
	// App.Close, which runs this same order; the defer then becomes a no-op.
	assembled := false
	var realtime *realtimeRuntime
	var control *controlPlane
	defer func() {
		if assembled {
			return
		}
		if realtime != nil {
			_ = realtime.Close()
		}
		if control != nil {
			_ = control.Close()
		}
		_ = handle.Close()
		db.ReleaseAuthorityFence(handle)
	}()

	root := keys.NewRoot(cfg.JWTSecret)
	receiptKey, err := root.RefreshReceiptKey()
	if err != nil {
		return nil, err
	}

	var mailer mail.Mailer
	if cfg.MailMode == config.MailModeSMTP {
		mailer = mail.NewSMTPMailer(cfg.SMTP.Host, cfg.SMTP.Port, cfg.SMTP.Username, cfg.SMTP.Password)
	} else {
		outbox, err := mail.NewOutboxMailer(cfg.OutboxDir)
		if err != nil {
			return nil, err
		}
		mailer = outbox
	}

	authStore := auth.NewStore(handle)
	signer := auth.NewTokenSigner(cfg.JWTSecret, cfg.AccessTokenTTL)
	sessions := auth.NewSessionService(handle, authStore, signer, receiptKey, cfg.RefreshTokenTTL, cfg.RefreshReplayGrace, cfg.DurableReplayTTL)
	hasher := auth.NewPasswordHasher(cfg.Argon2.MemoryKiB, cfg.Argon2.Iterations, cfg.Argon2.Parallelism, cfg.Argon2.MaxConcurrency)
	authService := auth.NewService(authStore, sessions, hasher, mailAdapter{mailer: mailer, from: cfg.FromAddress}, logger, cfg.WebOrigin, cfg.FromAddress, cfg.EmailVerifyTokenTTL, cfg.PasswordResetTTL)

	users := authn.UserLookup(authStore.UserByID)
	gate := &authn.AuthGate{Signer: signer, Sessions: sessions, Users: users}

	control, err = buildControl(handle, cfg, sessions, signer, logger)
	if err != nil {
		return nil, err
	}

	// The workspace domain runs on one injected clock and the frozen local
	// policy vector (C0: unconfigured flags read as disabled).
	wsClock := clock.Real{}
	workspaceStore := workspace.NewStoreWithOptions(handle, workspace.Options{
		Clock:              wsClock,
		MachineStatusProbe: control.probe,
		MachineMetadata:    control.metadata,
		OnComputerRevoked:  control.machines.Disconnect,
		Policy: workspace.Policy{
			OnboardingOpenerV2:      cfg.WorkspacePolicy.OnboardingOpenerV2,
			OnboardingOwnerWizardV0: cfg.WorkspacePolicy.OnboardingOwnerWizardV0,
			FeedbackEnabled:         cfg.WorkspacePolicy.FeedbackEnabled,
		},
	})

	diagnosticCtx, cancelDiagnostics := context.WithTimeout(context.Background(), 30*time.Second)
	diagnostics, err := workspaceStore.Diagnose(diagnosticCtx)
	cancelDiagnostics()
	if err != nil {
		return nil, err
	}
	for _, issue := range diagnostics {
		logger.Warn("workspace data requires explicit operator review", "code", issue.Code, "workspace_id", issue.WorkspaceID)
	}

	chat, err := buildChat(handle, control.channels, root)
	if err != nil {
		return nil, err
	}

	app := &App{
		Config: cfg, DB: handle,
		gate: gate, users: users, authService: authService, sessions: sessions, signer: signer,
		mailer: mailer, maintenance: auth.NewMaintenanceService(sessions, authStore),
		workspaceStore: workspaceStore,
		control:        control, chat: chat,
	}
	app.serversHandlers = &humanapi.ServersHandlers{
		Store: workspaceStore, Now: wsClock.Now,
		AvatarDir:      filepath.Join(cfg.DataDir, "avatars"),
		MaxAvatarBytes: cfg.MaxAvatarBytes, MaxAvatarSide: cfg.MaxAvatarSidePixels,
	}
	app.inviteHandlers = &humanapi.InviteHandlers{
		Store: workspaceStore, Now: wsClock.Now, Logger: logger,
		SendInviteMail: inviteMailSender(mailer, cfg),
	}

	var webOrigins []string
	if cfg.WebOrigin != nil {
		webOrigins = []string{cfg.WebOrigin.String()}
	}
	realtime, err = buildRealtime(chat, signer, logger, webOrigins)
	if err != nil {
		return nil, err
	}
	app.realtime = realtime

	app.Handler = app.buildHTTP(realtime.Handler(), logger)

	assembled = true
	return app, nil
}

// inviteMailSender builds the one-time invitation delivery used by the
// invite handlers: TS-parity HTML, the accept link pinned to the configured
// Web origin (never the request Host), and the machine-readable kind/token
// pair the private outbox exposes to tests.
func inviteMailSender(mailer mail.Mailer, cfg *config.Config) func(ctx context.Context, to, inviterName, serverName, token string) error {
	return func(ctx context.Context, to, inviterName, serverName, token string) error {
		origin := "http://127.0.0.1:4301"
		if cfg.WebOrigin != nil {
			origin = cfg.WebOrigin.String()
		}
		link := origin + "?invite=" + token
		return mailer.Send(ctx, mail.Message{
			From:    cfg.FromAddress,
			To:      to,
			Subject: workspace.InviteEmailSubject(inviterName, serverName),
			HTML:    workspace.RenderInviteEmailHTML(inviterName, serverName, link),
			Kind:    "invite",
			Token:   token,
		})
	}
}

// mailAdapter bridges the platform mailer to the auth MailSender.
type mailAdapter struct {
	mailer mail.Mailer
	from   string
}

func (m mailAdapter) Send(ctx context.Context, msg auth.MailMessage) error {
	return m.mailer.Send(ctx, mail.Message{
		From: m.from, To: msg.To, Subject: msg.Subject, HTML: msg.HTML,
		Kind: msg.Kind, Token: msg.Token,
	})
}

func (m mailAdapter) Name() string { return m.mailer.Name() }

// Ready probes the migrated database. It does not contact SMTP or promise
// mail delivery; transport failures are surfaced by sends and operator logs.
func (a *App) Ready(ctx context.Context) error {
	if err := db.Ready(ctx, a.DB); err != nil {
		return err
	}
	if a.chat != nil {
		return a.chat.publications.Ready(ctx)
	}
	return nil
}
