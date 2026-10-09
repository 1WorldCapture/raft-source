package app

// Lifecycle: the periodic maintenance loop and the ordered shutdown.

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"raft.local/server-go/internal/platform/db"
)

// StartMaintenance periodically removes expired session rows, account tokens
// and email-quota rows through the auth-owned maintenance service.
func (a *App) StartMaintenance(ctx context.Context, logger *slog.Logger) func() {
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
				if err := a.maintenance.Run(ctx); err != nil {
					logger.Warn("account maintenance pass failed", "error", err.Error())
				}
			}
		}
	}()
	// Cancel is idempotent; joining prevents cleanup from racing DB.Close.
	return func() { cancel(); <-done }
}

// Close joins the control plane before releasing its shared SQLite handle.
// Concurrent callers observe the same completed shutdown.
func (a *App) Close() error {
	a.closeOnce.Do(func() {
		if a.dispatcher != nil {
			a.closeErr = a.dispatcher.Close()
		}
		if a.realtime != nil {
			a.closeErr = errors.Join(a.closeErr, a.realtime.Close())
		}
		if a.control != nil {
			a.closeErr = errors.Join(a.closeErr, a.control.Close())
		}
		a.closeErr = errors.Join(a.closeErr, a.DB.Close())
		db.ReleaseAuthorityFence(a.DB)
	})
	return a.closeErr
}
