package core

import (
	"sync"
	"testing"
	"time"
)

func TestMemFenceScopeIsolation(t *testing.T) {
	f := NewMemFence()
	u := UserFenceScope("u1")
	fam := FamilyFenceScope("f1")
	w := WorkspaceFenceScope("ws1")
	if f.Generation(u) != 0 || f.Generation(w) != 0 || f.Generation(fam) != 0 {
		t.Fatal("initial generations not zero")
	}
	f.Bump(u)
	if f.Generation(u) != 1 || f.Generation(w) != 0 || f.Generation(fam) != 0 {
		t.Fatal("scope leak")
	}
	f.Bump(fam)
	if f.Generation(fam) != 1 || f.Generation(u) != 1 {
		t.Fatal("family bump leaked or lost user generation")
	}
	f.Bump(w)
	if f.Generation(w) != 1 {
		t.Fatal("workspace bump lost")
	}
}

func TestFenceViewEligibility(t *testing.T) {
	f := NewMemFence()
	id := Identity{
		UserID: "u1", SessionFamilyID: "fam1", WorkspaceID: "ws1",
		UserGeneration:      f.Generation(UserFenceScope("u1")),
		FamilyGeneration:    f.Generation(FamilyFenceScope("fam1")),
		WorkspaceGeneration: f.Generation(WorkspaceFenceScope("ws1")),
	}
	v := NewFenceView(f, id)
	if !v.Eligible(id) {
		t.Fatal("fresh identity must be eligible")
	}
	f.Bump(UserFenceScope("u1"))
	if v.Eligible(id) {
		t.Fatal("user bump must revoke eligibility")
	}
	id2 := Identity{
		UserID: "u1", SessionFamilyID: "fam1", WorkspaceID: "ws1",
		UserGeneration:      1,
		FamilyGeneration:    f.Generation(FamilyFenceScope("fam1")),
		WorkspaceGeneration: f.Generation(WorkspaceFenceScope("ws1")),
	}
	if !v.Eligible(id2) {
		t.Fatal("refreshed identity must be eligible")
	}
	// A logout bumps ONLY the family scope: the older snapshot dies with it.
	f.Bump(FamilyFenceScope("fam1"))
	if v.Eligible(id2) {
		t.Fatal("family bump must revoke eligibility")
	}
	// Another family's logout must not affect this connection.
	id3 := id2
	id3.FamilyGeneration++
	v3 := NewFenceView(f, id3)
	f.Bump(FamilyFenceScope("fam-other"))
	if !v3.Eligible(id3) {
		t.Fatal("unrelated family bump revoked eligibility")
	}
	f.Bump(WorkspaceFenceScope("ws1"))
	if v3.Eligible(id3) {
		t.Fatal("workspace bump must revoke eligibility")
	}
}

func TestIdentityTokenExpiry(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	id := Identity{TokenExpiresAt: now.Add(time.Minute)}
	if id.Expired(now) {
		t.Fatal("unexpired token reported expired")
	}
	// EXACTLY at the expiry instant the token is expired (RFC 7519: valid
	// only while now < exp) — no off-by-one second.
	if !id.Expired(now.Add(time.Minute)) {
		t.Fatal("expiry at the exact exp instant not enforced")
	}
	if !id.Expired(now.Add(61 * time.Second)) {
		t.Fatal("expiry after exp not enforced")
	}
	// Zero ExpiresAt: admission-time validation only, never report expired.
	if (&Identity{}).Expired(now.Add(time.Hour)) {
		t.Fatal("zero expiry must not expire")
	}
}

func TestMemFenceConcurrentBumps(t *testing.T) {
	f := NewMemFence()
	var wg sync.WaitGroup
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				f.Bump(UserFenceScope("shared"))
			}
		}()
	}
	wg.Wait()
	if f.Generation(UserFenceScope("shared")) != 800 {
		t.Fatalf("lost updates: %d", f.Generation(UserFenceScope("shared")))
	}
}

func TestAccountLevelFenceIgnoresWorkspace(t *testing.T) {
	f := NewMemFence()
	id := Identity{UserID: "u1"} // account-level
	v := NewFenceView(f, id)
	f.Bump(WorkspaceFenceScope("wsX"))
	if !v.Eligible(id) {
		t.Fatal("unrelated workspace bump must not affect account-level connection")
	}
}
