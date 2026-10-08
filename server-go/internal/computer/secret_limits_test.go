package computer

import (
	"strings"
	"sync"
	"testing"
)

func TestMalformedCredentialVerifiersFailBeforeDerivation(t *testing.T) {
	salt := "MTIzNDU2Nzg5MDEyMzQ1Ng"
	digest := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	cases := []string{
		"$argon2id$v=19$m=4294967312,t=1,p=1$" + salt + "$" + digest,
		"$argon2id$v=19$m=16,t=4294967297,p=1$" + salt + "$" + digest,
		"$argon2id$v=19$m=16,t=1,p=257$" + salt + "$" + digest,
		"$argon2id$v=19$m=16,t=0,p=1$" + salt + "$" + digest,
		"$argon2id$v=19$m=262145,t=1,p=1$" + salt + "$" + digest,
		"$argon2id$v=19$m=16,t=11,p=1$" + salt + "$" + digest,
		"$argon2id$v=19$m=16,t=1,p=9$" + salt + "$" + digest,
		"$argon2id$v=19$m=16,m=16,p=1$" + salt + "$" + digest,
		"$argon2id$v=19$t=1,m=16,p=1$" + salt + "$" + digest,
		"$argon2id$v=19$m=016,t=1,p=1$" + salt + "$" + digest,
		"$argon2id$v=19$m=16,t=1,p=1$$" + digest,
		"$argon2id$v=19$m=16,t=1,p=1$" + salt + "$",
		"$argon2id$v=19$m=16,t=1,p=1$AA$" + digest,
		"$argon2id$v=19$m=16,t=1,p=1$" + salt + "$AA",
		"$argon2id$v=19$m=16,t=1,p=1$" + salt + "$" + strings.Repeat("A", 100),
		strings.Repeat("x", 1025),
	}
	for i, encoded := range cases {
		if verifySecret(encoded, "test-key") {
			t.Errorf("malformed stored verifier %d was accepted", i)
		}
	}
}

func TestCredentialHashConfigurationCannotAllocateUnboundedMemory(t *testing.T) {
	for _, cfg := range []Argon2Config{
		{MemoryKiB: 262145, Iterations: 1, Parallelism: 1},
		{MemoryKiB: 16, Iterations: 11, Parallelism: 1},
		{MemoryKiB: 16, Iterations: 1, Parallelism: 9},
		{MemoryKiB: 1, Iterations: 1, Parallelism: 1},
	} {
		if _, err := hashSecret(cfg, "test-key"); err == nil {
			t.Fatalf("unsafe writer config accepted: %+v", cfg)
		}
	}
}

func TestCredentialDerivationGateIsSharedAndReleased(t *testing.T) {
	// Exercise concurrent mint+verify on cheap injected parameters. The
	// shared gate's capacity, not each call's individual hasher, is the bound.
	if cap(secretDerivations) != 4 {
		t.Fatal("unexpected global derivation concurrency budget")
	}
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			encoded, err := hashSecret(fastArgon(), "test-key")
			if err != nil || !verifySecret(encoded, "test-key") || verifySecret(encoded, "wrong-key") {
				t.Errorf("concurrent credential derivation failed: %v", err)
			}
		}()
	}
	wg.Wait()
	if len(secretDerivations) != 0 {
		t.Fatal("credential gate leaked a permit")
	}
}
