// Access-token signing and verification. Tokens stay JWTs (the web client
// parses sub/type claims itself) with sub/type/exp/familyId plus iss/aud that
// are unique to this independent server.
package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	accessTokenIssuer   = "raft-go"
	accessTokenAudience = "raft-web"
	// AccessTokenTTLDefault mirrors the legacy 15m.
	AccessTokenTTLDefault = 15 * time.Minute
)

// AccessTokenClaims is the payload accepted from (and written by) this server.
type AccessTokenClaims struct {
	Subject   string
	Type      string
	FamilyID  string
	IssuedAt  time.Time
	ExpiresAt time.Time
}

// TokenSigner signs and verifies access tokens. Safe for concurrent use.
type TokenSigner struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
}

// NewTokenSigner builds the signer. ttl <= 0 falls back to 15m.
func NewTokenSigner(secret []byte, ttl time.Duration) *TokenSigner {
	if ttl <= 0 {
		ttl = AccessTokenTTLDefault
	}
	return &TokenSigner{secret: append([]byte(nil), secret...), ttl: ttl, now: time.Now}
}

// SetClock overrides the clock (tests).
func (t *TokenSigner) SetClock(now func() time.Time) { t.now = now }

// TTL returns the configured access-token lifetime.
func (t *TokenSigner) TTL() time.Duration { return t.ttl }

// SignAccessToken issues an HS256 access token for the user/session family.
func (t *TokenSigner) SignAccessToken(userID, familyID string) (string, error) {
	now := t.now()
	claims := jwt.MapClaims{
		"sub":  userID,
		"type": "access",
		"iss":  accessTokenIssuer,
		"aud":  accessTokenAudience,
		"iat":  now.Unix(),
		"exp":  now.Add(t.ttl).Unix(),
	}
	if familyID != "" {
		claims["familyId"] = familyID
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(t.secret)
	if err != nil {
		return "", fmt.Errorf("sign access token: %w", err)
	}
	return signed, nil
}

// ErrTokenInvalid marks any token that must be treated as unauthenticated.
var ErrTokenInvalid = errors.New("invalid access token")

// VerifyAccessToken parses and validates a token, returning its claims.
func (t *TokenSigner) VerifyAccessToken(token string) (*AccessTokenClaims, error) {
	parsed, err := jwt.Parse(token, func(tk *jwt.Token) (any, error) {
		if _, ok := tk.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", tk.Header["alg"])
		}
		return t.secret, nil
	},
		jwt.WithValidMethods([]string{"HS256"}),
		jwt.WithIssuer(accessTokenIssuer),
		jwt.WithAudience(accessTokenAudience),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithTimeFunc(t.now),
	)
	if err != nil || !parsed.Valid {
		return nil, ErrTokenInvalid
	}
	mapClaims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return nil, ErrTokenInvalid
	}
	subject, err := mapClaims.GetSubject()
	if err != nil || subject == "" {
		return nil, ErrTokenInvalid
	}
	rawType, ok := mapClaims["type"].(string)
	if !ok || rawType != "access" {
		return nil, ErrTokenInvalid
	}
	issuedAt, err := mapClaims.GetIssuedAt()
	if err != nil || issuedAt == nil {
		return nil, ErrTokenInvalid
	}
	expiresAt, err := mapClaims.GetExpirationTime()
	if err != nil || expiresAt == nil {
		return nil, ErrTokenInvalid
	}
	familyID, _ := mapClaims["familyId"].(string)
	return &AccessTokenClaims{
		Subject:   subject,
		Type:      rawType,
		FamilyID:  familyID,
		IssuedAt:  issuedAt.Time,
		ExpiresAt: expiresAt.Time,
	}, nil
}

// HashToken is the persisted representation for every opaque secret (refresh
// tokens, verification/reset tokens): SHA-256 hex of the raw value.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
