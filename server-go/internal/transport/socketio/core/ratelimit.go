package core

import (
	"sync"
	"time"
)

// Limiter is a per-connection token bucket bounding INBOUND event
// frequency. It protects the server from a chatty or hostile client; it is
// a different layer from the HTTP messageLimiter (compat contract §2).
type Limiter struct {
	mu     sync.Mutex
	rate   float64 // tokens per second
	burst  float64
	tokens float64
	last   time.Time
	now    func() time.Time
}

// NewLimiter builds a bucket. Non-positive values fall back to defaults.
// now is injectable for tests; nil uses time.Now.
func NewLimiter(rate float64, burst float64, now func() time.Time) *Limiter {
	if rate <= 0 {
		rate = DefaultEventRatePerSecond
	}
	if burst <= 0 {
		burst = DefaultEventBurst
	}
	if now == nil {
		now = time.Now
	}
	return &Limiter{rate: rate, burst: burst, tokens: burst, last: now(), now: now}
}

// Allow consumes one token if available.
func (l *Limiter) Allow() bool {
	return l.AllowN(1)
}

// AllowN consumes n tokens if available.
func (l *Limiter) AllowN(n int64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	if d := t.Sub(l.last); d > 0 {
		l.tokens += d.Seconds() * l.rate
		if l.tokens > l.burst {
			l.tokens = l.burst
		}
		l.last = t
	}
	if l.tokens < float64(n) {
		return false
	}
	l.tokens -= float64(n)
	return true
}
