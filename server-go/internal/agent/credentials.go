// `sk_agent_*` credential material and bootstrap-token hashing, ported from
// packages/server/src/services/agentCredentialService.ts. The raw key or raw
// token is returned to the caller exactly once; only the argon2id hash (and
// a non-secret lookup prefix / HMAC lookup hash) is persisted.
package agent

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	"raft.local/server-go/internal/auth"
)

const (
	// apiKeyPrefixLength is the TS API_KEY_PREFIX_LENGTH: the first 16 chars
	// of the raw key ("sk_agent_" + 6 key chars) stored for O(1) lookup.
	apiKeyPrefixLength = 16
	rawKeyBytes        = 32 // sk_agent_ + 64 hex chars
	bootstrapTokenBody = 24 // 24 random bytes -> 32-char base64url body
	bootstrapPrefixLen = 12
	apiKeyInfix        = "sk_agent_"
	bootstrapInfix     = "abtk_"
)

// ErrPepperMissing mirrors the AGENT_BOOTSTRAP_TOKEN_PEPPER error contract:
// the caller maps it to 503 bootstrap_token_pepper_missing.
var ErrPepperMissing = errors.New("AGENT_BOOTSTRAP_TOKEN_PEPPER or JWT_SECRET environment variable is required (>= 32 chars)")

// CredentialHasher mints and verifies raw key material. It wraps the auth
// package's Argon2id hasher (PHC-encoded, concurrency-bounded) so agent
// credentials and account passwords share one vetted implementation.
type CredentialHasher struct {
	hasher *auth.PasswordHasher
	pepper []byte
}

// NewCredentialHasher builds a hasher. pepper must be at least 32 bytes
// (TS getBootstrapTokenPepper: AGENT_BOOTSTRAP_TOKEN_PEPPER or JWT_SECRET);
// shorter values fail construction rather than weakening the lookup HMAC.
func NewCredentialHasher(pepper []byte) (*CredentialHasher, error) {
	if len(pepper) < 32 {
		return nil, ErrPepperMissing
	}
	return &CredentialHasher{
		// Auth-grade default parameters; verified hashes carry their own
		// parameters so verify stays compatible with any cost we wrote.
		hasher: auth.NewPasswordHasher(19456, 1, 1, 4),
		pepper: append([]byte(nil), pepper...),
	}, nil
}

// Hash derives the argon2id PHC string for a raw secret.
func (h *CredentialHasher) Hash(raw string) (string, error) {
	return h.hasher.Hash(raw)
}

// Verify checks a raw secret against a stored PHC hash in constant time.
func (h *CredentialHasher) Verify(raw, encoded string) bool {
	return h.hasher.Verify(raw, encoded)
}

// Burn performs a dummy derivation so unknown-key lookups cost the same as
// failed verifies (enumeration guard).
func (h *CredentialHasher) Burn() { h.hasher.Burn() }

// IsAgentAPIKey mirrors isAgentApiKey.
func IsAgentAPIKey(token string) bool {
	return len(token) > len(apiKeyInfix) && token[:len(apiKeyInfix)] == apiKeyInfix
}

// APIKeyPrefix returns the persisted lookup prefix for a raw key.
func APIKeyPrefix(rawKey string) string {
	if len(rawKey) < apiKeyPrefixLength {
		return rawKey
	}
	return rawKey[:apiKeyPrefixLength]
}

// newAPIKeyMaterial mints a raw `sk_agent_` key (32 random bytes, hex) with
// its argon2id hash and lookup prefix.
func (h *CredentialHasher) newAPIKeyMaterial() (apiKey, apiKeyHash, apiKeyPrefix string, err error) {
	buf := make([]byte, rawKeyBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", "", "", fmt.Errorf("generate agent key: %w", err)
	}
	apiKey = apiKeyInfix + hex.EncodeToString(buf)
	apiKeyHash, err = h.Hash(apiKey)
	if err != nil {
		return "", "", "", err
	}
	return apiKey, apiKeyHash, APIKeyPrefix(apiKey), nil
}

// newBootstrapToken mints a raw `abtk_` token (24 random bytes, base64url)
// with its lookup HMAC, argon2id hash and display prefix.
func (h *CredentialHasher) newBootstrapToken() (raw string, lookupHash []byte, tokenHash, prefix string, err error) {
	buf := make([]byte, bootstrapTokenBody)
	if _, err := rand.Read(buf); err != nil {
		return "", nil, "", "", fmt.Errorf("generate bootstrap token: %w", err)
	}
	raw = bootstrapInfix + base64.RawURLEncoding.EncodeToString(buf)
	lookupHash = h.bootstrapLookupHash(raw)
	tokenHash, err = h.Hash(raw)
	if err != nil {
		return "", nil, "", "", err
	}
	if len(raw) < bootstrapPrefixLen {
		return "", nil, "", "", errors.New("bootstrap token shorter than prefix")
	}
	return raw, lookupHash, tokenHash, raw[:bootstrapPrefixLen], nil
}

// bootstrapLookupHash is HMAC-SHA256(pepper, raw token) — the deterministic
// column that locates a bootstrap row at exchange time.
func (h *CredentialHasher) bootstrapLookupHash(raw string) []byte {
	mac := hmac.New(sha256.New, h.pepper)
	mac.Write([]byte(raw))
	return mac.Sum(nil)
}
