// Package app is the composition root: it opens the database, derives keys,
// builds services and assembles the HTTP surface. No business rules live here.
package app

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"time"

	"raft.local/server-go/internal/auth"
	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/platform/config"
	"raft.local/server-go/internal/platform/db"
	"raft.local/server-go/internal/platform/keys"
	"raft.local/server-go/internal/platform/mail"
	"raft.local/server-go/internal/transport/legacyweb"
	"raft.local/server-go/internal/workspace"
)

// App is the assembled server.
type App struct {
	Config   *config.Config
	DB       *sql.DB
	Handler  http.Handler
	sessions *auth.SessionService
	mailer   mail.Mailer
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

	root := keys.NewRoot(cfg.JWTSecret)
	receiptKey, err := root.RefreshReceiptKey()
	if err != nil {
		handle.Close()
		return nil, err
	}

	var mailer mail.Mailer
	if cfg.MailMode == config.MailModeSMTP {
		mailer = mail.NewSMTPMailer(cfg.SMTP.Host, cfg.SMTP.Port, cfg.SMTP.Username, cfg.SMTP.Password)
	} else {
		outbox, err := mail.NewOutboxMailer(cfg.OutboxDir)
		if err != nil {
			handle.Close()
			return nil, err
		}
		mailer = outbox
	}

	store := auth.NewStore(handle)
	signer := auth.NewTokenSigner(cfg.JWTSecret, cfg.AccessTokenTTL)
	sessions := auth.NewSessionService(handle, store, signer, receiptKey, cfg.RefreshTokenTTL, cfg.RefreshReplayGrace, cfg.DurableReplayTTL)
	hasher := auth.NewPasswordHasher(cfg.Argon2.MemoryKiB, cfg.Argon2.Iterations, cfg.Argon2.Parallelism, cfg.Argon2.MaxConcurrency)
	service := auth.NewService(store, sessions, hasher, mailAdapter{mailer: mailer, from: cfg.FromAddress}, logger, cfg.WebOrigin, cfg.FromAddress, cfg.EmailVerifyTokenTTL, cfg.PasswordResetTTL)

	users := legacyweb.UserLookup(store.UserByID)
	gate := &legacyweb.AuthGate{Signer: signer, Sessions: sessions, Users: users}

	// The workspace domain runs on one injected clock and the frozen local
	// policy vector (C0: unconfigured flags read as disabled).
	wsClock := clock.Real{}
	workspaceStore := workspace.NewStoreWithOptions(handle, workspace.Options{
		Clock: wsClock,
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
		handle.Close()
		return nil, err
	}
	for _, issue := range diagnostics {
		logger.Warn("workspace data requires explicit operator review", "code", issue.Code, "workspace_id", issue.WorkspaceID)
	}

	handler := legacyweb.New(legacyweb.Deps{
		Handlers: &legacyweb.Handlers{
			Auth:     service,
			Sessions: sessions,
			Signer:   signer,
			Users:    users,
			Gate:     gate,
		},
		Servers: &legacyweb.ServersHandlers{
			Store:          workspaceStore,
			Now:            wsClock.Now,
			AvatarDir:      filepath.Join(cfg.DataDir, "avatars"),
			MaxAvatarBytes: cfg.MaxAvatarBytes,
			MaxAvatarSide:  cfg.MaxAvatarSidePixels,
		},
		Avatars: &legacyweb.AvatarHandlers{
			Dir:      filepath.Join(cfg.DataDir, "avatars"),
			MaxBytes: cfg.MaxAvatarBytes,
			MaxSide:  cfg.MaxAvatarSidePixels,
			Auth:     service,
			Users:    users,
		},
		AuthRatePerMinute:         cfg.AuthRatePerMinute,
		LoginAccountRatePerMinute: cfg.LoginAccountRatePerMinute,
		RegisterRatePerHour:       cfg.RegisterRatePerHour,
		ForgotPasswordRatePerHour: cfg.ForgotPasswordRatePerHour,
	})

	wrapped := legacyweb.RequestID(logger)(legacyweb.SecurityHeaders(handler))

	return &App{Config: cfg, DB: handle, Handler: wrapped, sessions: sessions, mailer: mailer}, nil
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
	if err := a.DB.PingContext(ctx); err != nil {
		return err
	}
	var migrated int
	if err := a.DB.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM schema_migrations`).Scan(&migrated); err != nil {
		return err
	}
	if migrated == 0 {
		return errNotMigrated
	}
	return nil
}

var errNotMigrated = &readyError{reason: "database_not_migrated"}

type readyError struct{ reason string }

func (e *readyError) Error() string { return e.reason }

// StartJanitor periodically removes expired session rows and receipts.
func (a *App) StartJanitor(ctx context.Context, logger *slog.Logger) func() {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	if logger == nil {
		logger = slog.Default()
	}
	go func() {
		defer close(done)
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := a.sessions.CleanupExpired(ctx); err != nil {
					logger.Warn("session cleanup failed", "error", err.Error())
				}
				if _, err := a.DB.ExecContext(ctx, `DELETE FROM account_tokens WHERE expires_at <= ?`, time.Now().UnixMilli()); err != nil {
					logger.Warn("account token cleanup failed", "error", err.Error())
				}
				if _, err := a.DB.ExecContext(ctx, `DELETE FROM account_email_requests WHERE created_at <= ?`, time.Now().Add(-time.Hour).UnixMilli()); err != nil {
					logger.Warn("email quota cleanup failed", "error", err.Error())
				}
			}
		}
	}()
	// Cancel is idempotent; joining prevents cleanup from racing DB.Close.
	return func() { cancel(); <-done }
}

// Close releases resources.
func (a *App) Close() error { return a.DB.Close() }
