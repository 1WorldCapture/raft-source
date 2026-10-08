// Argon2id password hashing with a process-wide concurrency bound so a burst
// of logins cannot exhaust memory: each hash costs MemoryKiB regardless of
// Parallelism, so MaxConcurrency x MemoryKiB is the peak budget.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// PasswordHasher hashes and verifies passwords with configured Argon2id
// parameters. Safe for concurrent use.
type PasswordHasher struct {
	memoryKiB   uint32
	iterations  uint32
	parallelism uint8
	saltLength  int
	hashLength  int
	semaphore   chan struct{}
}

// NewPasswordHasher builds a hasher. maxConcurrency must be >= 1.
func NewPasswordHasher(memoryKiB, iterations uint32, parallelism uint8, maxConcurrency int) *PasswordHasher {
	if maxConcurrency < 1 {
		maxConcurrency = 1
	}
	return &PasswordHasher{
		memoryKiB:   memoryKiB,
		iterations:  iterations,
		parallelism: parallelism,
		saltLength:  16,
		hashLength:  32,
		semaphore:   make(chan struct{}, maxConcurrency),
	}
}

// Hash derives a PHC-formatted Argon2id string for password.
func (h *PasswordHasher) Hash(password string) (string, error) {
	salt := make([]byte, h.saltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate salt: %w", err)
	}
	hash := h.derive(password, salt)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, h.memoryKiB, h.iterations, h.parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash),
	), nil
}

func (h *PasswordHasher) derive(password string, salt []byte) []byte {
	h.semaphore <- struct{}{}
	defer func() { <-h.semaphore }()
	return argon2.IDKey([]byte(password), salt, h.iterations, h.memoryKiB, h.parallelism, uint32(h.hashLength))
}

// Verify checks password against a PHC-formatted Argon2id hash. Only Argon2id
// is accepted; malformed hashes simply fail.
func (h *PasswordHasher) Verify(password, encoded string) bool {
	if len(encoded) > 512 {
		return false
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	params := strings.Split(parts[3], ",")
	if len(params) != 3 {
		return false
	}
	var memory, iterations uint32
	var parallelism uint8
	if _, err := fmt.Sscanf(params[0], "m=%d", &memory); err != nil {
		return false
	}
	if _, err := fmt.Sscanf(params[1], "t=%d", &iterations); err != nil {
		return false
	}
	if _, err := fmt.Sscanf(params[2], "p=%d", &parallelism); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	// Reject malformed or unreasonable persisted costs BEFORE Argon2 allocates.
	// The semaphore bounds concurrency, not the size of an individual hash.
	// Empty hashes must never compare equal, and t=0/p=0 would panic.
	if memory < 8 || memory > 256*1024 || iterations < 1 || iterations > 10 || parallelism < 1 || parallelism > 8 || len(salt) < 8 || len(salt) > 64 || len(want) < 16 || len(want) > 64 {
		return false
	}
	if parts[2] != fmt.Sprintf("v=%d", version) || parts[3] != fmt.Sprintf("m=%d,t=%d,p=%d", memory, iterations, parallelism) {
		return false
	}
	derived := h.deriveParams(password, salt, memory, iterations, parallelism, uint32(len(want)))
	return subtle.ConstantTimeCompare(derived, want) == 1
}

func (h *PasswordHasher) deriveParams(password string, salt []byte, memory, iterations uint32, parallelism uint8, length uint32) []byte {
	h.semaphore <- struct{}{}
	defer func() { <-h.semaphore }()
	return argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, length)
}

// Burn performs a dummy derivation at the configured cost so a login attempt
// against a missing account costs the same as a failed password check
// (timing-based account enumeration guard).
func (h *PasswordHasher) Burn() {
	salt := make([]byte, h.saltLength)
	if _, err := rand.Read(salt); err != nil {
		return
	}
	h.derive("dummy-password-value", salt)
}
