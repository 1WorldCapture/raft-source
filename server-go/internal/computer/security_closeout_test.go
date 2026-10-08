package computer

import "testing"

// A stored malformed verifier is corrupt data, never an authentication
// authority. This uses a tiny Argon allocation to exercise the empty-digest
// regression safely; upper-bound tests belong after the parser is hardened.
func TestCloseoutEmptyArgonDigestNeverVerifies(t *testing.T) {
	encoded := "$argon2id$v=19$m=16,t=1,p=1$MTIzNDU2Nzg5MDEyMzQ1Ng$"
	if verifySecret(encoded, "any-presented-machine-key") {
		t.Fatal("empty stored digest must not verify any Computer or device credential")
	}
}
