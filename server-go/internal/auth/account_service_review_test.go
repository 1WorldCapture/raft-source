package auth

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"raft.local/server-go/internal/platform/clock"
)

type accountTestMailer struct {
	mu       sync.Mutex
	messages []MailMessage
}

func (m *accountTestMailer) Name() string { return "test-memory" }
func (m *accountTestMailer) Send(_ context.Context, message MailMessage) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.messages = append(m.messages, message)
	return nil
}
func (m *accountTestMailer) snapshot() []MailMessage {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]MailMessage(nil), m.messages...)
}

func accountServiceFixture(t *testing.T) (*Service, *Store, *clock.Fixed, *accountTestMailer) {
	t.Helper()
	sessions, store, clock := newSessionsFixture(t)
	mailer := &accountTestMailer{}
	service := NewService(store, sessions, testHasher(), mailer,
		slog.New(slog.NewTextHandler(io.Discard, nil)), nil, "", 24*time.Hour, time.Hour)
	service.SetClock(clock.Now)
	return service, store, clock, mailer
}

func TestVerificationHourlyQuotaSurvivesTokenReplacement(t *testing.T) {
	service, store, clock, mailer := accountServiceFixture(t)
	user := newTestUser(t, store, "quota@example.test")
	for i := range 6 {
		err := service.ResendVerification(context.Background(), user.ID)
		if i < 5 && err != nil {
			t.Fatalf("allowed send %d: %v", i, err)
		}
		if i == 5 && (AsError(err) == nil || AsError(err).Code != ErrCodeResendRateLimited) {
			t.Fatalf("sixth send must hit persisted hourly quota: %v", err)
		}
		clock.Advance(61 * time.Second)
	}
	if len(mailer.snapshot()) != 5 {
		t.Fatal("replacing verification tokens must not reset send quota")
	}
}

func TestConcurrentVerificationRequestsHaveOneWinner(t *testing.T) {
	service, store, _, mailer := accountServiceFixture(t)
	user := newTestUser(t, store, "verification-burst@example.test")
	var wg sync.WaitGroup
	start := make(chan struct{})
	errors := make([]error, 16)
	for i := range errors {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			errors[i] = service.ResendVerification(context.Background(), user.ID)
		}()
	}
	close(start)
	wg.Wait()
	winners := 0
	for _, err := range errors {
		if err == nil {
			winners++
		} else if AsError(err) == nil || AsError(err).Code != ErrCodeResendCooldown {
			t.Errorf("unexpected loser outcome: %v", err)
		}
	}
	if winners != 1 || len(mailer.snapshot()) != 1 {
		t.Fatalf("concurrent resend bypassed cooldown: successes=%d messages=%d", winners, len(mailer.snapshot()))
	}
}

func TestConcurrentPasswordResetRequestsRespectHourlyQuota(t *testing.T) {
	service, store, _, mailer := accountServiceFixture(t)
	user := newTestUser(t, store, "reset-burst@example.test")
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := service.RequestPasswordReset(context.Background(), user.Email); err != nil {
				t.Errorf("reset request: %v", err)
			}
		}()
	}
	wg.Wait()
	if n := len(mailer.snapshot()); n != 5 {
		t.Fatalf("reset quota bypassed: sent=%d, want 5", n)
	}
}

func TestVerificationTokenExpiresAtExactDeadline(t *testing.T) {
	service, store, clock, mailer := accountServiceFixture(t)
	user := newTestUser(t, store, "expiry-boundary@example.test")
	if err := service.ResendVerification(context.Background(), user.ID); err != nil {
		t.Fatal(err)
	}
	clock.Advance(24 * time.Hour)
	if err := service.VerifyEmail(context.Background(), mailer.snapshot()[0].Token); AsError(err) == nil || AsError(err).Code != ErrCodeInvalidVerifyToken {
		t.Fatalf("token must expire at, not after, its deadline: %v", err)
	}
	current, err := store.UserByID(context.Background(), user.ID)
	if err != nil || current.EmailVerified {
		t.Fatalf("expired verification changed account state: %v", err)
	}
}

func TestAllPasswordMutationUseCasesEnforceTheSamePolicy(t *testing.T) {
	for _, password := range []string{"short", strings.Repeat("x", MaxPasswordLength+1)} {
		service, store, _, _ := accountServiceFixture(t)
		user := newTestUser(t, store, "password-policy@example.test")
		_, _, registrationErr := service.Register(context.Background(), RegisterInput{Email: "new@example.test", Password: password, Legal: LegalAcceptanceInput{AcceptTerms: true, TermsVersion: TermsVersionCurrent, PrivacyVersion: PrivacyVersionCurrent}})
		for operation, err := range map[string]error{
			"register": registrationErr,
			"reset":    service.ResetPassword(context.Background(), "unused", password),
			"change":   service.ChangePassword(context.Background(), user.ID, "password-123", password),
		} {
			if AsError(err) == nil || AsError(err).Code != "invalid_password" {
				t.Errorf("%s password policy returned wrong result: %v", operation, err)
			}
		}
	}
}

func TestRegistrationRollsBackIfSessionCannotBeCreated(t *testing.T) {
	service, store, _, mailer := accountServiceFixture(t)
	if _, err := store.DB().Exec(`CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected session failure'); END`); err != nil {
		t.Fatal(err)
	}
	_, _, err := service.Register(context.Background(), RegisterInput{Email: "atomic-register@example.test", Password: "password-123", Legal: LegalAcceptanceInput{AcceptTerms: true, TermsVersion: TermsVersionCurrent, PrivacyVersion: PrivacyVersionCurrent}})
	if err == nil {
		t.Fatal("injected session failure was ignored")
	}
	for _, table := range []string{"users", "legal_acceptances", "account_tokens", "session_families"} {
		var count int
		if err := store.DB().QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Errorf("registration left partial %s state: count=%d err=%v", table, count, err)
		}
	}
	if len(mailer.snapshot()) != 0 {
		t.Fatal("uncommitted registration must not send verification mail")
	}
}
