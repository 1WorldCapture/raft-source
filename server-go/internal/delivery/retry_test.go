package delivery

import (
	"testing"
	"time"
)

// TestBackoffCurve pins the original agentDeliveryRetryPolicy shape: 5s
// base, doubling, 5-minute cap.
func TestBackoffCurve(t *testing.T) {
	cases := []struct {
		attempts int64
		want     time.Duration
	}{
		{0, 5 * time.Second},
		{1, 5 * time.Second},
		{2, 10 * time.Second},
		{3, 20 * time.Second},
		{4, 40 * time.Second},
		{5, 80 * time.Second},
		{6, 160 * time.Second},
		{7, 300 * time.Second}, // 320s would exceed the cap
		{8, 300 * time.Second},
		{100, 300 * time.Second},
		{-5, 5 * time.Second},
	}
	for _, tc := range cases {
		if got := BackoffFor(tc.attempts); got != tc.want {
			t.Errorf("BackoffFor(%d) = %s; want %s", tc.attempts, got, tc.want)
		}
	}
}

// TestJitterBounds: the deterministic jitter stays within [base, 1.25*base)
// and is stable across calls (restart-stable scheduling).
func TestJitterBounds(t *testing.T) {
	for _, attempts := range []int64{1, 2, 5, 10} {
		base := BackoffFor(attempts)
		for i := 0; i < 8; i++ {
			got := jitteredBackoff("delivery-1", attempts)
			if got < base || got >= base+base/4+1 {
				t.Fatalf("jitteredBackoff(delivery-1,%d) = %s outside [%s,%s)", attempts, got, base, base+base/4+1)
			}
			if got != jitteredBackoff("delivery-1", attempts) {
				t.Fatalf("jitter is not deterministic for delivery-1/%d", attempts)
			}
		}
		// Different deliveries spread out (not all identical).
		same := true
		first := jitteredBackoff("delivery-1", attempts)
		for _, id := range []string{"delivery-2", "delivery-3", "delivery-4"} {
			if jitteredBackoff(id, attempts) != first {
				same = false
			}
		}
		if same {
			t.Logf("note: jitter identical across sampled ids at attempts=%d (allowed, distribution is hash-based)", attempts)
		}
	}
}

func TestBudgetExhaustedThreshold(t *testing.T) {
	if BudgetExhausted(23) {
		t.Fatal("budget must hold 24 dispatch preparations")
	}
	if !BudgetExhausted(24) {
		t.Fatal("budget is exhausted at 24")
	}
	if !BudgetExhausted(25) {
		t.Fatal("budget stays exhausted past 24")
	}
}

// TestLeaseTTLMatchesBackoff documents the managed ACK window.
func TestLeaseTTLMatchesBackoff(t *testing.T) {
	if LeaseTTLFor(2) != BackoffFor(2) {
		t.Fatal("managed lease TTL must equal the backoff window")
	}
}
