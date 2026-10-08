// Package keys derives bounded sub-keys from the server's root JWT secret.
// Long-lived credentials (the encrypted refresh successor receipt) are sealed
// with an HKDF-derived AES-256-GCM key that is domain-separated from token
// signing, mirroring the legacy derivation labels so the security contract is
// unchanged.
package keys

import (
	"crypto/sha256"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

const (
	receiptInfo = "slock-session-refresh-rotation-receipt"
	receiptSalt = "v1-aes-256-gcm"
)

// Root wraps the raw secret bytes.
type Root struct{ secret []byte }

// NewRoot builds a key root. The slice is retained, never copied out.
func NewRoot(secret []byte) *Root { return &Root{secret: append([]byte(nil), secret...)} }

// RefreshReceiptKey derives the 32-byte AES-256-GCM key for successor receipts.
func (r *Root) RefreshReceiptKey() ([]byte, error) {
	reader := hkdf.New(sha256.New, r.secret, []byte(receiptSalt), []byte(receiptInfo))
	key := make([]byte, 32)
	if _, err := reader.Read(key); err != nil {
		return nil, fmt.Errorf("derive refresh receipt key: %w", err)
	}
	return key, nil
}

// ReactionCursorKey signs opaque reaction-actors pagination state. It is
// distinct from both JWT signing and refresh-receipt encryption, and remains
// stable across restarts that preserve the deployment root secret.
func (r *Root) ReactionCursorKey() ([]byte, error) {
	reader := hkdf.New(sha256.New, r.secret, []byte("v1-hmac-sha256"), []byte("raft-message-reaction-actors-cursor"))
	key := make([]byte, 32)
	if _, err := io.ReadFull(reader, key); err != nil {
		return nil, fmt.Errorf("derive reaction cursor key: %w", err)
	}
	return key, nil
}
