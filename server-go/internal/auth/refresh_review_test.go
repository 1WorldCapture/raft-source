package auth

import (
	"context"
	"testing"
)

func TestReviewUnboundLostResponseReplaySurvivesServiceRestart(t *testing.T) {
	sessions, store, clock := newSessionsFixture(t)
	user := newTestUser(t, store, "lost-response@example.test")
	initial, err := sessions.CreateSession(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	first, err := sessions.Refresh(context.Background(), initial.RefreshToken, nil)
	if err != nil || first == nil || first.Session == nil {
		t.Fatal("first refresh failed")
	}
	// Simulate losing the response and all process-local maps. Only DB and
	// persisted encryption/signing keys remain; the browser retries its OLD token.
	restarted := NewSessionService(sessions.db, store, sessions.signer, sessions.receiptKey,
		sessions.refreshTTL, sessions.replayGrace, sessions.durableTTL)
	restarted.SetClock(clock.Now)
	replayed, err := restarted.Refresh(context.Background(), initial.RefreshToken, nil)
	if err != nil || replayed == nil || replayed.Session == nil || !replayed.Replayed {
		t.Fatal("in-grace retry after lost response/restart must recover its successor")
	}
	if replayed.Session.RefreshToken != first.Session.RefreshToken {
		t.Fatal("restart created a second successor")
	}
	var ciphertext string
	if err := sessions.db.QueryRow(`SELECT successor_token_ciphertext FROM session_refresh_rotation_receipts WHERE predecessor_token_hash = ?`, HashToken(initial.RefreshToken)).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if ciphertext == first.Session.RefreshToken || ciphertext == "" {
		t.Fatal("successor receipt must be encrypted at rest")
	}
}

func TestReviewRevokedFamilyCannotRotateWithOrWithoutBinding(t *testing.T) {
	for _, bound := range []bool{false, true} {
		t.Run(map[bool]string{false: "unbound", true: "bound"}[bound], func(t *testing.T) {
			sessions, store, clock := newSessionsFixture(t)
			user := newTestUser(t, store, "revoked@example.test")
			issued, err := sessions.CreateSession(context.Background(), user.ID)
			if err != nil {
				t.Fatal(err)
			}
			// Independent admin/revocation writer sets the family flag. A stale
			// session row must not permit minting fresh credentials.
			if _, err := sessions.db.Exec(`UPDATE session_families SET revoked_at = ? WHERE id = ?`, clock.Now().UnixMilli(), issued.FamilyID); err != nil {
				t.Fatal(err)
			}
			var binding *RefreshBinding
			if bound {
				binding = &RefreshBinding{AttemptID: "arf_0123456789abcdef", InstallationID: "ari_0123456789abcdef0123456789abcdef"}
			}
			outcome, err := sessions.Refresh(context.Background(), issued.RefreshToken, binding)
			if err != nil {
				t.Fatal(err)
			}
			if outcome != nil && outcome.Session != nil {
				t.Fatal("revoked family issued a successor")
			}
			if live, err := sessions.ValidateSession(context.Background(), issued.RefreshToken); err != nil || live != nil {
				t.Fatal("revoked session validated")
			}
		})
	}
}
