// raft-server: the independent Go server entrypoint. Also hosts the dev
// mailbox subcommand for reading the local outbox without any HTTP surface.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"raft.local/server-go/internal/app"
	"raft.local/server-go/internal/platform/config"
	"raft.local/server-go/internal/platform/mail"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if len(os.Args) > 1 && os.Args[1] == "mailbox" {
		if err := runMailbox(os.Args[2:], os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, "mailbox:", err)
			os.Exit(1)
		}
		return
	}
	if err := run(logger); err != nil {
		logger.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	// Resolve the data dir up front so the generated JWT secret has a
	// deterministic, persistent home under it from the very first boot.
	dataDir := strings.TrimSpace(os.Getenv("RAFT_GO_DATA_DIR"))
	if dataDir == "" {
		dataDir = config.DefaultDataDir
	}
	if !filepath.IsAbs(dataDir) {
		if abs, err := filepath.Abs(dataDir); err == nil {
			dataDir = abs
		}
	}
	keyFile := filepath.Join(dataDir, "keys", "jwt-secret")
	cfg, err := config.Load(config.OSLookup, dataDir, keyFile)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	built, err := app.Build(app.Options{Config: cfg, Logger: logger})
	if err != nil {
		return fmt.Errorf("build app: %w", err)
	}
	defer built.Close()

	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", cfg.ListenAddr, err)
	}
	defer listener.Close()

	root := http.NewServeMux()
	root.HandleFunc("GET /healthz", built.LivenessHandler())
	root.HandleFunc("GET /readyz", built.ReadinessHandler())
	root.Handle("/", built.Handler)

	server := &http.Server{
		Handler:           root,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	stopJanitor := built.StartJanitor(ctx, logger)
	defer stopJanitor()

	serveResult := make(chan error, 1)
	go func() { serveResult <- server.Serve(listener) }()
	logger.Info("raft go server listening",
		"address", cfg.ListenAddr,
		"data_dir", cfg.DataDir,
		"mail_mode", cfg.MailMode,
		"web_origin", webOriginString(cfg),
	)

	select {
	case err := <-serveResult:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
			return fmt.Errorf("shutdown: %w", err)
		}
		err := <-serveResult
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func webOriginString(cfg *config.Config) string {
	if cfg.WebOrigin != nil {
		return cfg.WebOrigin.String()
	}
	return "(unset; email links fall back to the API origin)"
}

// ── mailbox subcommand ──

func runMailbox(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("mailbox", flag.ContinueOnError)
	limit := fs.Int("limit", 10, "how many messages to list")
	jsonOut := fs.Bool("json", false, "emit machine-readable JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rest := fs.Args()

	outboxDir, err := mailboxOutboxDir()
	if err != nil {
		return err
	}
	entries, err := mail.ReadOutbox(outboxDir, *limit)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		fmt.Fprintln(out, "outbox is empty:", outboxDir)
		return nil
	}

	switch {
	case len(rest) == 0 || rest[0] == "list":
		for _, e := range entries {
			if *jsonOut {
				fmt.Fprintf(out, "{\"file\":%q,\"to\":%q,\"subject\":%q}\n", e.File, e.To, e.Subject)
				continue
			}
			fmt.Fprintf(out, "%s  %s  %s\n", e.File, e.To, e.Subject)
		}
	case rest[0] == "latest":
		e := entries[0]
		links := e.Links()
		if *jsonOut {
			fmt.Fprintf(out, "{\"file\":%q,\"to\":%q,\"subject\":%q,\"kind\":%q,\"token\":%q,\"links\":[", e.File, e.To, e.Subject, e.Kind, e.Token)
			for i, l := range links {
				if i > 0 {
					fmt.Fprint(out, ",")
				}
				fmt.Fprintf(out, "%q", l)
			}
			fmt.Fprintln(out, "]}")
			return nil
		}
		fmt.Fprintf(out, "To:      %s\nSubject: %s\nKind:    %s\nFile:    %s\n", e.To, e.Subject, e.Kind, e.File)
		if e.Token != "" {
			fmt.Fprintf(out, "Token:   %s\n", e.Token)
		}
		for i, l := range links {
			fmt.Fprintf(out, "Link[%d]: %s\n", i, l)
		}
	case rest[0] == "show" && len(rest) > 1:
		for _, e := range entries {
			if e.File == rest[1] || strings.TrimSuffix(e.File, ".json") == rest[1] {
				fmt.Fprintln(out, e.HTML)
				return nil
			}
		}
		return fmt.Errorf("message %q not found", rest[1])
	default:
		return fmt.Errorf("usage: mailbox [-limit n] [-json] [list|latest|show <file>]")
	}
	return nil
}

// mailboxOutboxDir resolves the outbox location without a full config load so
// the read-only mailbox command never creates data files.
func mailboxOutboxDir() (string, error) {
	lookup := func(key string) string {
		v, _ := config.OSLookup(key)
		return strings.TrimSpace(v)
	}
	if dir := lookup("RAFT_GO_OUTBOX_DIR"); dir != "" {
		return dir, nil
	}
	dataDir := lookup("RAFT_GO_DATA_DIR")
	if dataDir == "" {
		dataDir = config.DefaultDataDir
	}
	if !filepath.IsAbs(dataDir) {
		abs, err := filepath.Abs(dataDir)
		if err != nil {
			return "", err
		}
		dataDir = abs
	}
	return filepath.Join(dataDir, "outbox"), nil
}
