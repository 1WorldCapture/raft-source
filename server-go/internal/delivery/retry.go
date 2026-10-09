package delivery

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math"
	"time"
)

// Retry policy mirrors the original agentDeliveryRetryPolicy.ts: exponential
// backoff from 5s doubling to a 5-minute cap, with a PERSISTENT budget of 24
// dispatch preparations. The budget lives on agent_deliveries.retry_count and
// survives restarts, reconnects and scans; only an explicit RequeueBlocked
// resets it.
const (
	RetryBaseBackoff      = 5 * time.Second
	RetryBackoffCap       = 5 * time.Minute
	RetryBudget           = 24
	DefaultClaimLeaseTTL  = 10 * time.Minute
	WaitingRecheckBackoff = 5 * time.Second
	// claimBatchLimit/claimBatchMax bound one claim batch (the original
	// contract caps the ack arrays at 500).
	claimBatchLimit = 50
	claimBatchMax   = 500
	// scanDefaults bound one managed dispatch scan round.
	scanDefaultPerAgent = 1
	scanDefaultTotal    = 64
	scanMaxTotal        = 512
)

// BackoffFor returns the wait before the next dispatch preparation.
// attempts is the number of dispatch preparations already made: 5s, 10s,
// 20s, ... doubling, capped at 5 minutes.
func BackoffFor(attempts int64) time.Duration {
	completed := attempts
	if completed < 0 {
		completed = 0
	}
	if completed == 0 {
		return RetryBaseBackoff
	}
	shift := completed - 1
	if shift > 30 {
		shift = 30
	}
	doubled := float64(RetryBaseBackoff) * math.Pow(2, float64(shift))
	if doubled > float64(RetryBackoffCap) || math.IsInf(doubled, 0) {
		return RetryBackoffCap
	}
	return time.Duration(doubled)
}

// LeaseTTLFor is the managed ACK wait window: the daemon gets one backoff
// period to answer before the lease expires and the scheduler re-prepares.
func LeaseTTLFor(attempts int64) time.Duration { return BackoffFor(attempts) }

// BudgetExhausted reports whether the persistent dispatch budget is spent.
func BudgetExhausted(retryCount int64) bool { return retryCount >= RetryBudget }

// jitteredBackoff adds a deterministic 0-25% jitter to BackoffFor so a batch
// of simultaneously-due deliveries does not thunder as one herd. The jitter
// is a hash of (deliveryID, attempts): restart-stable and testable.
func jitteredBackoff(deliveryID string, attempts int64) time.Duration {
	base := BackoffFor(attempts)
	if base <= 0 {
		return base
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d", deliveryID, attempts)))
	spread := uint32(base / 4) // 0..25% of the base window
	if spread == 0 {
		return base
	}
	return base + time.Duration(binary.BigEndian.Uint32(sum[:4])%spread)
}
