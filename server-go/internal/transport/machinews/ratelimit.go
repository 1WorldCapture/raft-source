package machinews

import "time"

// Ingress rate limiting, ported from planDaemonIngressRateLimit: the legacy
// lifecycle frame types are limited per machine+type and per machine total;
// every other frame type is unlimited. Defaults reproduce the TS values
// (window 10s, 2000 per machine+type, 3000 per machine total).
const (
	rateLimitWindow             = 10 * time.Second
	rateLimitMaxPerType         = 2000
	rateLimitMaxPerMachine      = 3000
	invalidReasonLogSuppression = 1000
)

// rateLimitedFrameTypes mirrors DAEMON_INGRESS_RATE_LIMITED_MESSAGE_TYPES.
var rateLimitedFrameTypes = map[string]bool{
	"agent:status":                                    true,
	"agent:activity":                                  true,
	"agent:session":                                   true,
	"agent:session:invalidate":                        true,
	"agent:runtime_profile":                           true,
	"agent:runtime_profile:migration:ack":             true,
	"agent:runtime_profile:migration_done":            true,
	"agent:runtime_profile:daemon_release_notice:ack": true,
}

// ingressLimiter is the per-connection bucket set. TS keys windows by
// machineId on the process-global orchestrator; a machine has at most one
// live connection per hub, so per-connection state is equivalent except
// across a replacement (window resets), which is noted in the contract doc.
type ingressLimiter struct {
	buckets map[string]*rateWindow
}

type rateWindow struct {
	startedAt time.Time
	count     int
	dropped   int
}

func newIngressLimiter() *ingressLimiter {
	return &ingressLimiter{buckets: map[string]*rateWindow{}}
}

// allow reports whether one frame of the given type may be processed.
// droppedTotal is the running drop count for the losing bucket (0 when
// allowed), used for the throttled log.
func (l *ingressLimiter) allow(now time.Time, frameType string) (ok bool, droppedTotal int) {
	if !rateLimitedFrameTypes[frameType] {
		return true, 0
	}
	if !l.bucketPasses(now, frameType, rateLimitMaxPerType) {
		return false, l.buckets[frameType].dropped
	}
	totalKey := "\x00total"
	if !l.bucketPasses(now, totalKey, rateLimitMaxPerMachine) {
		return false, l.buckets[totalKey].dropped
	}
	return true, 0
}

func (l *ingressLimiter) bucketPasses(now time.Time, key string, limit int) bool {
	w := l.buckets[key]
	if w == nil || now.Sub(w.startedAt) >= rateLimitWindow {
		l.buckets[key] = &rateWindow{startedAt: now, count: 1, dropped: 0}
		return true
	}
	w.count++
	if w.count <= limit {
		return true
	}
	w.dropped++
	return false
}
