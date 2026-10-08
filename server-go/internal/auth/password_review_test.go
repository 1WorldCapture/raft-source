package auth_test

import (
	auth "raft.local/server-go/internal/auth"
	"testing"
)

func TestReviewMalformedPasswordHashesFailWithoutPanicOrAllocation(t *testing.T) {
	h := auth.NewPasswordHasher(32, 1, 1, 1) // deliberately cheap test-only setting
	for _, hash := range []string{
		"", "$argon2id$v=19$m=32,t=0,p=1$MTIzNDU2Nzg$MTIzNDU2Nzg5MDEyMzQ1Ng",
		"$argon2id$v=19$m=32,t=1,p=0$MTIzNDU2Nzg$MTIzNDU2Nzg5MDEyMzQ1Ng",
		"$argon2id$v=19$m=4294967295,t=1,p=1$MTIzNDU2Nzg$MTIzNDU2Nzg5MDEyMzQ1Ng",
		"$argon2id$v=19$m=32,t=1,p=1$MTIzNDU2Nzg$",
		"$argon2id$v=19junk$m=32,t=1,p=1$MTIzNDU2Nzg$MTIzNDU2Nzg5MDEyMzQ1Ng",
	} {
		if h.Verify("test-only", hash) {
			t.Fatal("malformed PHC must fail")
		}
	}
	encoded, err := h.Hash("test-only")
	if err != nil {
		t.Fatal(err)
	}
	if !h.Verify("test-only", encoded) || h.Verify("wrong", encoded) {
		t.Fatal("valid password round-trip failed")
	}
}
