package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestSignVerifyAccessToken(t *testing.T) {
	signer := NewTokenSigner([]byte("0123456789abcdef0123456789abcdef"), time.Minute)
	token, err := signer.SignAccessToken("user-1", "family-1")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(token, ".") != 2 {
		t.Fatalf("expected compact JWS, got %q", token)
	}
	claims, err := signer.VerifyAccessToken(token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Subject != "user-1" || claims.Type != "access" || claims.FamilyID != "family-1" {
		t.Errorf("claims mismatch: %+v", claims)
	}
	if !claims.ExpiresAt.After(claims.IssuedAt) {
		t.Error("expiry must follow iat")
	}
}

func TestVerifyRejectsBadTokens(t *testing.T) {
	signer := NewTokenSigner([]byte("0123456789abcdef0123456789abcdef"), time.Minute)
	token, _ := signer.SignAccessToken("user-1", "family-1")

	other := NewTokenSigner([]byte("fedcba9876543210fedcba9876543210"), time.Minute)
	foreign, _ := other.SignAccessToken("user-1", "family-1")

	// A refresh-type claim token signed by us must not pass access verification.
	refreshStyle, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "user-1", "type": "refresh",
		"iss": "raft-go", "aud": "raft-web",
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Minute).Unix(),
	}).SignedString([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}

	for name, bad := range map[string]string{
		"empty":       "",
		"garbage":     "abc.def.ghi",
		"foreign-key": foreign,
		"tampered":    token + "tampered",
		"wrong-type":  refreshStyle,
	} {
		if _, err := signer.VerifyAccessToken(bad); err == nil {
			t.Errorf("%s: token accepted", name)
		}
	}

	// Expiry is enforced.
	expired := NewTokenSigner([]byte("0123456789abcdef0123456789abcdef"), time.Minute)
	expired.SetClock(func() time.Time { return time.Now().Add(-2 * time.Minute) })
	stale, _ := expired.SignAccessToken("user-1", "family-1")
	if _, err := signer.VerifyAccessToken(stale); err == nil {
		t.Error("expired token accepted")
	}
}

func TestHashTokenStable(t *testing.T) {
	if HashToken("abc") != HashToken("abc") {
		t.Error("hash not deterministic")
	}
	if HashToken("abc") == HashToken("abd") {
		t.Error("hash collision on trivially different inputs")
	}
}
