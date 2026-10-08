// Package ratelimit provides fixed-window counters keyed by arbitrary strings
// (IP, account). Single-instance in-memory implementation; the multi-instance
// replacement is a later deployment concern, matching the phase-1 design.
package ratelimit

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Limiter admits at most limit events per window per key.
type Limiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	buckets map[string]*bucket
	// now is swappable for tests.
	now func() time.Time
}

type bucket struct {
	start time.Time
	count int
}

// New builds a limiter. limit must be >= 1.
func New(limit int, window time.Duration) *Limiter {
	return &Limiter{limit: limit, window: window, buckets: make(map[string]*bucket), now: time.Now}
}

// Allow consumes one event for key, reporting whether it was admitted.
func (l *Limiter) Allow(key string) bool {
	return l.allowAt(key, l.now())
}

func (l *Limiter) allowAt(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok || now.Sub(b.start) >= l.window {
		// Lazy reset doubles as garbage collection for stale buckets.
		if len(l.buckets) > 100_000 {
			l.sweepLocked(now)
		}
		l.buckets[key] = &bucket{start: now, count: 1}
		return true
	}
	if b.count >= l.limit {
		return false
	}
	b.count++
	return true
}

func (l *Limiter) sweepLocked(now time.Time) {
	for k, b := range l.buckets {
		if now.Sub(b.start) >= l.window {
			delete(l.buckets, k)
		}
	}
}

// Remaining reports the budget left for key in its current window (>= 0).
func (l *Limiter) Remaining(key string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok || l.now().Sub(b.start) >= l.window {
		return l.limit
	}
	return l.limit - b.count
}

// Middleware wraps next with a per-key budget. keyFn extracts the bucket key;
// onLimit runs when the budget is exhausted (default: JSON 429 writer).
type Middleware struct {
	Limiter *Limiter
	KeyFn   func(r *http.Request) string
	OnLimit func(w http.ResponseWriter, r *http.Request)
}

// Wrap returns the guarded handler.
func (m Middleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := m.KeyFn(r)
		if key != "" && !m.Limiter.Allow(key) {
			w.Header().Set("RateLimit-Limit", strconv.Itoa(m.Limiter.limit))
			w.Header().Set("RateLimit-Remaining", "0")
			if m.OnLimit != nil {
				m.OnLimit(w, r)
				return
			}
			writeDefaultLimited(w)
			return
		}
		w.Header().Set("RateLimit-Limit", strconv.Itoa(m.Limiter.limit))
		w.Header().Set("RateLimit-Remaining", strconv.Itoa(max(0, m.Limiter.Remaining(key))))
		next.ServeHTTP(w, r)
	})
}

func writeDefaultLimited(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusTooManyRequests)
	_, _ = w.Write([]byte(`{"error":"Too many requests, please try again later"}` + "\n"))
}

// ClientIP extracts the IP from RemoteAddr. Proxy headers are deliberately
// ignored: this server is not deployed behind a trusted proxy in phase 1, and
// honoring spoofable X-Forwarded-For would defeat the limiter.
func ClientIP(r *http.Request) string {
	host := r.RemoteAddr
	for i := len(host) - 1; i >= 0; i-- {
		if host[i] == ':' {
			return host[:i]
		}
	}
	return host
}

var _ = time.Now // keep time import when only used in tests of this package
