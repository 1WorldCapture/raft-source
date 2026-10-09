package humanapi

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

// messageLimiter is the per-user write bucket shared by v1/v2 message sends
// and reaction mutations, mirroring the legacy express-rate-limit config:
// 60 events / 60s per user, keyGenerator = authenticated user (never a
// spoofable header or IP), GETs exempt, standard headers, and the exact 429
// body. A randomId replay consumes the bucket exactly like the original
// (the limiter wraps the route, not the commit).
//
// The fixed window admits a clock function for tests; production must keep a
// real clock and the 60/min default — the test hook may NOT be used to
// disable limiting in product configuration.
type messageLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	buckets map[string]*messageBucket
	now     func() time.Time
}

type messageBucket struct {
	start time.Time
	count int
}

func newMessageLimiter() *messageLimiter {
	return &messageLimiter{limit: 60, window: time.Minute, buckets: map[string]*messageBucket{}, now: time.Now}
}

// allow consumes one event for user. key must be the authenticated user id.
func (l *messageLimiter) allow(key string) (ok bool, resetEpochSeconds int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b, hit := l.buckets[key]
	if !hit || now.Sub(b.start) >= l.window {
		if len(l.buckets) > 100_000 {
			for k, b := range l.buckets {
				if now.Sub(b.start) >= l.window {
					delete(l.buckets, k)
				}
			}
		}
		l.buckets[key] = &messageBucket{start: now, count: 1}
		return true, now.Add(l.window).Unix()
	}
	if b.count >= l.limit {
		return false, b.start.Add(l.window).Unix()
	}
	b.count++
	return true, b.start.Add(l.window).Unix()
}

// wrap applies the bucket to a write handler for the given user key.
func (l *messageLimiter) wrap(userID string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ok, reset := l.allow(userID)
		w.Header().Set("RateLimit-Limit", strconv.Itoa(l.limit))
		if !ok {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("RateLimit-Remaining", "0")
			w.Header().Set("RateLimit-Reset", strconv.FormatInt(reset, 10))
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":"Too many messages, please slow down"}` + "\n"))
			return
		}
		remaining := l.limit
		l.mu.Lock()
		if b, hit := l.buckets[userID]; hit {
			remaining = l.limit - b.count
		}
		l.mu.Unlock()
		if remaining < 0 {
			remaining = 0
		}
		w.Header().Set("RateLimit-Remaining", strconv.Itoa(remaining))
		w.Header().Set("RateLimit-Reset", strconv.FormatInt(reset, 10))
		next(w, r)
	}
}
