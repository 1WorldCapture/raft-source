// Device-code grant lifecycle tests over real SQLite: authorize/approve/
// consume transitions, CAS races, expiry, denial and enumeration folding.
package computer

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestDeviceGrantFullFlow(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seedUser(t, "approver")

	grant, err := f.store.CreateDeviceAuthorization(ctx, "raft-computer", 0)
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if grant.DeviceCode == "" || len(grant.UserCode) != 9 || grant.UserCode[4] != '-' {
		t.Fatalf("grant shape: %+v", grant)
	}
	if grant.ExpiresInSeconds != int((10*time.Minute).Seconds()) || grant.PollIntervalSeconds != 5 {
		t.Fatalf("grant defaults: %+v", grant)
	}

	// Poll before approval -> pending.
	if r, _ := f.store.ConsumeDeviceAuthorization(ctx, grant.DeviceCode, TokenUseObservation{}); r.OK || r.Err != AuthorizationPending {
		t.Fatalf("pre-approve poll = %+v", r)
	}

	// Approve with sloppy casing/whitespace resolves the same grant.
	if r, err := f.store.ApproveDeviceAuthorization(ctx, "  "+lower(grant.UserCode)+" ", "approver", true); err != nil || !r.OK {
		t.Fatalf("approve: %+v %v", r, err)
	}
	// Second resolve loses the CAS.
	if r, _ := f.store.ApproveDeviceAuthorization(ctx, grant.UserCode, "approver", true); r.OK || r.Err != AlreadyResolved {
		t.Fatalf("re-approve = %+v", r)
	}

	// Consume once; the second poll reads consumed.
	first, err := f.store.ConsumeDeviceAuthorization(ctx, grant.DeviceCode, TokenUseObservation{IP: "10.0.0.9", UserAgent: "raft-computer/1"})
	if err != nil || !first.OK || first.ApprovedByUserID != "approver" {
		t.Fatalf("consume: %+v %v", first, err)
	}
	second, _ := f.store.ConsumeDeviceAuthorization(ctx, grant.DeviceCode, TokenUseObservation{})
	if second.OK || second.Err != DeviceCodeConsumed {
		t.Fatalf("re-consume = %+v", second)
	}

	// Audit columns survived the consume (row is never deleted).
	var status string
	var ip string
	if err := f.db.QueryRow(`SELECT status, consumed_ip FROM device_authorizations WHERE user_code = ?`,
		grant.UserCode).Scan(&status, &ip); err != nil {
		t.Fatal(err)
	}
	if status != "consumed" || ip != "10.0.0.9" {
		t.Fatalf("audit row = %s %s", status, ip)
	}
}

func TestDeviceGrantDenialAndExpiry(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seedUser(t, "u1")

	denied, _ := f.store.CreateDeviceAuthorization(ctx, "", 0)
	if _, err := f.store.ApproveDeviceAuthorization(ctx, denied.UserCode, "u1", false); err != nil {
		t.Fatal(err)
	}
	if r, _ := f.store.ConsumeDeviceAuthorization(ctx, denied.DeviceCode, TokenUseObservation{}); r.OK || r.Err != AccessDenied {
		t.Fatalf("denied consume = %+v", r)
	}

	expired, _ := f.store.CreateDeviceAuthorization(ctx, "", 0)
	f.fixed.Advance(11 * time.Minute)
	if r, _ := f.store.ApproveDeviceAuthorization(ctx, expired.UserCode, "u1", true); r.OK || r.Err != Expired {
		t.Fatalf("expired approve = %+v", r)
	}
	if r, _ := f.store.ConsumeDeviceAuthorization(ctx, expired.DeviceCode, TokenUseObservation{}); r.OK || r.Err != ExpiredToken {
		t.Fatalf("expired consume = %+v", r)
	}

	// Unknown codes fold uniformly (zero enumeration).
	if r, _ := f.store.ApproveDeviceAuthorization(ctx, "ZZZZ-ZZZZ", "u1", true); r.OK || r.Err != UserCodeInvalid {
		t.Fatalf("unknown user code = %+v", r)
	}
	if r, _ := f.store.ConsumeDeviceAuthorization(ctx, "dvc_nope", TokenUseObservation{}); r.OK || r.Err != DeviceCodeInvalid {
		t.Fatalf("unknown device code = %+v", r)
	}
	// A device code that HMAC-locates a row but is not the secret verifier
	// still folds into device_code_invalid.
	other, _ := f.store.CreateDeviceAuthorization(ctx, "", 0)
	if r, _ := f.store.ConsumeDeviceAuthorization(ctx, other.DeviceCode+"x", TokenUseObservation{}); r.OK || r.Err != DeviceCodeInvalid {
		t.Fatalf("forged device code = %+v", r)
	}
}

// Two concurrent consumers race the CAS: exactly one wins.
func TestDeviceGrantSingleConsumeRace(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	f.seedUser(t, "u1")
	grant, _ := f.store.CreateDeviceAuthorization(ctx, "", 0)
	if r, _ := f.store.ApproveDeviceAuthorization(ctx, grant.UserCode, "u1", true); !r.OK {
		t.Fatal("approve failed")
	}

	var wg sync.WaitGroup
	wins := make(chan bool, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := f.store.ConsumeDeviceAuthorization(ctx, grant.DeviceCode, TokenUseObservation{})
			if err != nil {
				t.Errorf("consume: %v", err)
			}
			wins <- r.OK
		}()
	}
	wg.Wait()
	close(wins)
	n := 0
	for w := range wins {
		if w {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("concurrent consumes: %d winners, want exactly 1", n)
	}
}

func TestDeviceGrantClientNameValidation(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	long := make([]byte, 201)
	for i := range long {
		long[i] = 'a'
	}
	if _, err := f.store.CreateDeviceAuthorization(ctx, string(long), 0); err == nil {
		t.Fatal("oversized clientName must be rejected")
	}
	if _, err := f.store.CreateDeviceAuthorization(ctx, "slock-cli", time.Minute); err != nil {
		t.Fatalf("valid clientName: %v", err)
	}
}

func lower(s string) string {
	out := []byte(s)
	for i := range out {
		if out[i] >= 'A' && out[i] <= 'Z' {
			out[i] += 'a' - 'A'
		}
	}
	return string(out)
}
