package auth

import (
	"strings"
	"sync"
	"testing"
)

func testHasher() *PasswordHasher {
	// OWASP-floor parameters keep the test fast; production defaults live in config.
	return NewPasswordHasher(19*1024, 1, 1, 2)
}

func TestPasswordHashRoundTrip(t *testing.T) {
	h := testHasher()
	encoded, err := h.Hash("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(encoded, "$argon2id$v=19$") {
		t.Fatalf("unexpected PHC prefix: %q", encoded)
	}
	if !h.Verify("correct horse battery staple", encoded) {
		t.Error("correct password rejected")
	}
	if h.Verify("wrong password", encoded) {
		t.Error("wrong password accepted")
	}
}

func TestPasswordVerifyRejectsMalformedHashes(t *testing.T) {
	h := testHasher()
	for _, bad := range []string{
		"", "plaintext", "$argon2i$v=19$m=19456,t=1,p=1$AAAA$BBBB",
		"$argon2id$v=99$m=19456,t=1,p=1$AAAA$BBBB",
		"$argon2id$v=19$m=19456$t=1$AAAA$BBBB",
	} {
		if h.Verify("x", bad) {
			t.Errorf("malformed hash accepted: %q", bad)
		}
	}
}

func TestPasswordHashConcurrencyBound(t *testing.T) {
	h := NewPasswordHasher(19*1024, 1, 1, 3)
	var wg sync.WaitGroup
	for i := 0; i < 30; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			encoded, err := h.Hash("parallel password")
			if err != nil {
				t.Error(err)
				return
			}
			if !h.Verify("parallel password", encoded) {
				t.Error("round trip failed under concurrency")
			}
		}()
	}
	wg.Wait()
}
