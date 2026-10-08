// Random identifiers. IDs keep the legacy UUIDv4 string shape so client-side
// regex assumptions (retirement flow etc.) keep holding.
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
)

// NewUUID returns a random RFC 4122 version-4 UUID string.
func NewUUID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand failure is process-fatal in practice; a panic here is
		// safer than minting predictable session identifiers.
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}

// NewOpaqueToken returns a 64-hex-character (32-byte) secret, matching the
// legacy refresh/verification token shape.
func NewOpaqueToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(buf)
}

// NewPendingHandle returns the pending_<20hex> reservation for a deferred
// profile, matching the legacy placeholder shape.
func NewPendingHandle() string {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return ProfileSetupPlaceholderPrefix + hex.EncodeToString(buf)
}

// readRandom fills buf with crypto-random bytes (helper shared by store).
func readRandom(buf []byte) (int, error) { return rand.Read(buf) }
