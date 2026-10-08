// Shared crypto helpers for the auth package.
package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
)

// newGCM builds the AES-256-GCM AEAD used for successor receipts.
func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// randomBytes fills n crypto-random bytes.
func randomBytes(n int) []byte {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err) // unpredictability is a security invariant, not a retry case
	}
	return buf
}
