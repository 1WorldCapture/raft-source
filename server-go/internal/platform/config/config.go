// Package config loads and validates the Go server's environment-driven
// configuration. Every knob uses the RAFT_GO_ prefix so the new server can be
// configured inside the same shell as the legacy TS server without collisions.
package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultListenAddr   = "127.0.0.1:4301"
	DefaultDataDir      = "var"
	envPrefix           = "RAFT_GO_"
	defaultSMTPPort     = 587
	maxAvatarSidePixels = 8000
)

// Config is the fully validated process configuration.
type Config struct {
	// ListenAddr is the loopback (default) TCP address to bind.
	ListenAddr string
	// AllowNonLoopback explicitly opts out of the loopback bind guard.
	AllowNonLoopback bool
	// DataDir holds the SQLite database, generated keys, avatars and outbox.
	DataDir string
	// WebOrigin is the explicit public origin of the web client. Email links
	// are built from it; it is never derived from request Host headers.
	WebOrigin *url.URL
	// JWTSecret signs access tokens. Either from env or persisted under DataDir.
	JWTSecret []byte
	// MailMode selects "outbox" (default, dev) or "smtp" (production).
	MailMode MailMode
	// SMTP settings; required when MailMode == MailModeSMTP.
	SMTP SMTPSettings
	// OutboxDir receives .json dev messages when MailMode is MailModeOutbox.
	OutboxDir string
	// FromAddress is the sender for outgoing mail.
	FromAddress string

	AccessTokenTTL      time.Duration
	RefreshTokenTTL     time.Duration
	RefreshReplayGrace  time.Duration
	DurableReplayTTL    time.Duration
	EmailVerifyTokenTTL time.Duration
	PasswordResetTTL    time.Duration

	Argon2 Argon2Settings

	// WorkspacePolicy is the frozen local workspace feature-flag vector
	// (design §1.3, C0). Flags default to false — a missing flag is disabled.
	WorkspacePolicy WorkspacePolicySettings

	// Computer controls device-user login and the separate Agent bootstrap grant.
	Computer ComputerSettings

	// MaxAvatarBytes caps uploaded avatar decoding (matches legacy 5MB).
	MaxAvatarBytes int64
	// MaxAvatarSidePixels caps decoded image dimensions (decompression guard).
	MaxAvatarSidePixels int

	// AuthRatePerMinute is the per-IP general /api/auth budget (legacy: 200/min).
	AuthRatePerMinute int
	// LoginAccountRatePerMinute throttles login attempts per account.
	LoginAccountRatePerMinute int
	// RegisterRatePerHour throttles registrations per IP.
	RegisterRatePerHour int
	// ForgotPasswordRatePerHour matches the legacy 5/hour/IP limiter.
	ForgotPasswordRatePerHour int
}

// WorkspacePolicySettings is the local policy provider for the M2 workspace
// flags. It is deliberately scope-limited: no push/platform flags, no
// per-request evaluation, no client-visible Go-specific switches. FeedbackEnabled
// truthfully reports whether a feedback system is configured (C0: false).
type WorkspacePolicySettings struct {
	OnboardingOpenerV2      bool
	OnboardingOwnerWizardV0 bool
	FeedbackEnabled         bool
}

// MailMode selects the outgoing mail transport.
type MailMode string

const (
	MailModeOutbox MailMode = "outbox"
	MailModeSMTP   MailMode = "smtp"
)

// SMTPSettings describes a production SMTP submission endpoint.
type SMTPSettings struct {
	Host     string
	Port     int
	Username string
	Password string
}

// Argon2Settings carries Argon2id cost parameters (OWASP-bounded) plus the
// process-wide hashing concurrency bound.
type Argon2Settings struct {
	MemoryKiB      uint32
	Iterations     uint32
	Parallelism    uint8
	MaxConcurrency int
}

// Load reads the environment, applies defaults and validates the result.
// When jwtSecretFile is non-empty and RAFT_GO_JWT_SECRET is unset, a fresh
// random secret is generated and persisted there so session keys survive
// restarts (keys are never printed or logged).
func Load(env LookupFunc, dataDirDefault string, jwtSecretFile string) (*Config, error) {
	get := func(key string) string {
		v, _ := env(envPrefix + key)
		return strings.TrimSpace(v)
	}
	getRaw := func(key string) string {
		v, _ := env(envPrefix + key)
		return v
	}

	cfg := &Config{
		AllowNonLoopback:    get("ALLOW_NON_LOOPBACK") == "1",
		DataDir:             get("DATA_DIR"),
		WebOrigin:           nil,
		MailMode:            MailModeOutbox,
		Computer:            readComputerSettings(get),
		AccessTokenTTL:      15 * time.Minute,
		RefreshTokenTTL:     30 * 24 * time.Hour,
		RefreshReplayGrace:  10 * time.Second,
		DurableReplayTTL:    15 * time.Minute,
		EmailVerifyTokenTTL: 24 * time.Hour,
		PasswordResetTTL:    time.Hour,
		Argon2: Argon2Settings{
			// OWASP Password Storage Cheat Sheet floor (19MiB/t=2) exceeded
			// deliberately; concurrency keeps peak memory bounded.
			MemoryKiB:      64 * 1024,
			Iterations:     3,
			Parallelism:    1,
			MaxConcurrency: 4,
		},
		MaxAvatarBytes:            5 * 1024 * 1024,
		MaxAvatarSidePixels:       maxAvatarSidePixels,
		AuthRatePerMinute:         200,
		LoginAccountRatePerMinute: 10,
		RegisterRatePerHour:       20,
		ForgotPasswordRatePerHour: 5,
	}
	if cfg.DataDir == "" {
		cfg.DataDir = dataDirDefault
	}
	if !filepath.IsAbs(cfg.DataDir) {
		abs, err := filepath.Abs(cfg.DataDir)
		if err != nil {
			return nil, fmt.Errorf("resolve data dir: %w", err)
		}
		cfg.DataDir = abs
	}

	// Freeze the M2 policy vector; invalid or unsupported enablement is an
	// explicit startup error, not a successfully ignored configuration.
	workspacePolicy, err := loadWorkspacePolicy(get)
	if err != nil {
		return nil, err
	}
	cfg.WorkspacePolicy = workspacePolicy

	listen := get("LISTEN")
	if listen == "" {
		listen = DefaultListenAddr
	}
	if err := validateListen(listen, cfg.AllowNonLoopback); err != nil {
		return nil, err
	}
	cfg.ListenAddr = listen

	if raw := get("WEB_ORIGIN"); raw != "" {
		origin, err := parseHTTPOrigin(raw)
		if err != nil {
			return nil, fmt.Errorf("RAFT_GO_WEB_ORIGIN: %w", err)
		}
		cfg.WebOrigin = origin
	}

	mode := MailMode(get("MAIL_MODE"))
	switch mode {
	case "":
		mode = MailModeOutbox
	case MailModeOutbox, MailModeSMTP:
	default:
		return nil, fmt.Errorf("RAFT_GO_MAIL_MODE must be outbox or smtp")
	}
	// Explicit SMTP host implies SMTP mode only when no mode was selected.
	if get("SMTP_HOST") != "" && get("MAIL_MODE") == "" {
		mode = MailModeSMTP
	}
	cfg.MailMode = mode
	if mode == MailModeSMTP {
		host := get("SMTP_HOST")
		if host == "" {
			return nil, fmt.Errorf("RAFT_GO_SMTP_HOST is required when mail mode is smtp")
		}
		port := defaultSMTPPort
		if raw := get("SMTP_PORT"); raw != "" {
			p, err := strconv.Atoi(raw)
			if err != nil || p < 1 || p > 65535 {
				return nil, fmt.Errorf("RAFT_GO_SMTP_PORT must be a port between 1 and 65535")
			}
			port = p
		}
		cfg.SMTP = SMTPSettings{Host: host, Port: port, Username: get("SMTP_USERNAME"), Password: getRaw("SMTP_PASSWORD")}
	}
	cfg.OutboxDir = get("OUTBOX_DIR")
	if cfg.OutboxDir == "" {
		cfg.OutboxDir = filepath.Join(cfg.DataDir, "outbox")
	}

	if from := get("FROM_EMAIL"); from != "" {
		cfg.FromAddress = from
	} else {
		cfg.FromAddress = "Raft <noreply@raft.build>"
	}

	if err := loadDuration(get("ACCESS_TOKEN_TTL"), &cfg.AccessTokenTTL); err != nil {
		return nil, fmt.Errorf("RAFT_GO_ACCESS_TOKEN_TTL: %w", err)
	}
	if err := loadDuration(get("REFRESH_TTL"), &cfg.RefreshTokenTTL); err != nil {
		return nil, fmt.Errorf("RAFT_GO_REFRESH_TTL: %w", err)
	}
	if err := loadDuration(get("REFRESH_REPLAY_GRACE"), &cfg.RefreshReplayGrace); err != nil {
		return nil, fmt.Errorf("RAFT_GO_REFRESH_REPLAY_GRACE: %w", err)
	}
	if cfg.AccessTokenTTL <= 0 || cfg.RefreshTokenTTL <= 0 || cfg.RefreshReplayGrace < 0 {
		return nil, fmt.Errorf("token TTLs must be positive and replay grace non-negative")
	}

	if raw := get("ARGON2_MEMORY_KIB"); raw != "" {
		v, err := strconv.ParseUint(raw, 10, 32)
		if err != nil || v < 19*1024 || v > 256*1024 {
			return nil, fmt.Errorf("RAFT_GO_ARGON2_MEMORY_KIB must be between 19456 and 262144")
		}
		cfg.Argon2.MemoryKiB = uint32(v)
	}
	if raw := get("ARGON2_ITERATIONS"); raw != "" {
		v, err := strconv.ParseUint(raw, 10, 32)
		if err != nil || v < 2 || v > 10 {
			return nil, fmt.Errorf("RAFT_GO_ARGON2_ITERATIONS must be between 2 and 10")
		}
		cfg.Argon2.Iterations = uint32(v)
	}
	if raw := get("ARGON2_PARALLELISM"); raw != "" {
		v, err := strconv.ParseUint(raw, 10, 8)
		if err != nil || v < 1 || v > 8 {
			return nil, fmt.Errorf("RAFT_GO_ARGON2_PARALLELISM must be between 1 and 8")
		}
		cfg.Argon2.Parallelism = uint8(v)
	}
	if raw := get("ARGON2_MAX_CONCURRENCY"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 {
			return nil, fmt.Errorf("RAFT_GO_ARGON2_MAX_CONCURRENCY must be >= 1")
		}
		cfg.Argon2.MaxConcurrency = v
	}
	if cfg.Argon2.MaxConcurrency > 16 {
		cfg.Argon2.MaxConcurrency = 16
	}
	// Validate all configuration before creating persistent credentials.
	secret, err := loadOrCreateSecret(getRaw("JWT_SECRET"), jwtSecretFile)
	if err != nil {
		return nil, err
	}
	cfg.JWTSecret = secret
	return cfg, nil
}

// LookupFunc mirrors os.LookupEnv so tests can inject a fake environment.
type LookupFunc func(string) (string, bool)

// OSLookup is the production environment lookup.
func OSLookup(key string) (string, bool) { return os.LookupEnv(key) }

func validateListen(addr string, allowNonLoopback bool) error {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("RAFT_GO_LISTEN must be host:port, got %q", addr)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("RAFT_GO_LISTEN port must be between 1 and 65535")
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("RAFT_GO_LISTEN host must be an IP literal, got %q", host)
	}
	if !ip.IsLoopback() && !allowNonLoopback {
		return fmt.Errorf("refusing to bind non-loopback %s; set RAFT_GO_ALLOW_NON_LOOPBACK=1 to override", host)
	}
	return nil
}

func parseHTTPOrigin(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil {
		return nil, fmt.Errorf("must be a valid URL, got %q", raw)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("scheme must be http or https, got %q", u.Scheme)
	}
	if u.Hostname() == "" {
		return nil, fmt.Errorf("must include a host")
	}
	if u.User != nil || u.Opaque != "" || u.ForceQuery || u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("must be a bare origin without credentials, path, query or fragment")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, fmt.Errorf("port must be between 1 and 65535")
		}
	} else if strings.HasSuffix(u.Host, ":") {
		return nil, fmt.Errorf("port must not be empty")
	}
	return u, nil
}

func loadDuration(raw string, target *time.Duration) error {
	if raw == "" {
		return nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return err
	}
	*target = d
	return nil
}
