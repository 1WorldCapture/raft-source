package agentapi_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// A HEAD probe has no response body, so it cannot safely use either of the
// state-changing GET inbox operations. Authentication still precedes 405.
func TestEventsHeadNeverDrainsOrClaims(t *testing.T) {
	env := newM5Env(t)
	for _, path := range []string{"/internal/agent-api/events", "/internal/agent-api/events/claim"} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodHead, path, nil)
			req.Header.Set("Authorization", "Bearer "+env.apiKey)
			rec := httptest.NewRecorder()
			env.mux.ServeHTTP(rec, req)
			if rec.Code != http.StatusMethodNotAllowed || rec.Header().Get("Allow") != http.MethodGet {
				t.Fatalf("HEAD must be rejected without inbox effects: %d %s", rec.Code, rec.Body.String())
			}
			status, _, body := env.do(http.MethodHead, path, "", "", nil)
			if status != http.StatusUnauthorized {
				t.Fatalf("unauthenticated HEAD must still be 401: %d %s", status, body)
			}
			status, _, body = env.do(http.MethodHead, path, "", env.apiKey, map[string]string{
				"X-Slock-Agent-Active-Capabilities": "send",
			})
			if status != http.StatusNotImplemented {
				t.Fatalf("capability check must precede 405: %d %s", status, body)
			}
		})
	}
	if env.events.drainCalls != 0 || env.events.claimCalls != 0 || env.events.ackCalls != 0 {
		t.Fatalf("HEAD mutated inbox: drain=%d claim=%d ack=%d", env.events.drainCalls, env.events.claimCalls, env.events.ackCalls)
	}
	status, _, body := env.do(http.MethodGet, "/internal/agent-api/events", "", env.apiKey, nil)
	if status != http.StatusOK || env.events.drainCalls != 1 {
		t.Fatalf("ordinary original-CLI GET drain must remain available: %d %s", status, body)
	}
}

func TestInboxQueryLimitsClampBeforeIntegerConversion(t *testing.T) {
	env := newM5Env(t)
	for _, tc := range []struct {
		raw                     string
		eventsWant, historyWant int
	}{
		{"1e100", 200, 100},
		{"1e400", 200, 100},
		{"Infinity", 200, 100},
		{"-Infinity", 1, 1},
		{"-1e100", 1, 1},
		{"0.5", 1, 1},
		{"7.9", 7, 7},
		{"NaN", 50, 50},
		{"0", 50, 50},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			status, _, body := env.do(http.MethodGet, "/internal/agent-api/events/claim?limit="+url.QueryEscape(tc.raw), "", env.apiKey, nil)
			if status != http.StatusOK || env.events.lastLimit != tc.eventsWant {
				t.Fatalf("events limit=%q: status=%d limit=%d want=%d body=%s", tc.raw, status, env.events.lastLimit, tc.eventsWant, body)
			}
			status, _, body = env.do(http.MethodGet, "/internal/agent-api/history?channel=channelId:chan-1&limit="+url.QueryEscape(tc.raw), "", env.apiKey, nil)
			if status != http.StatusOK || env.history.lastQuery.Limit != int64(tc.historyWant) {
				t.Fatalf("history limit=%q: status=%d limit=%d want=%d body=%s", tc.raw, status, env.history.lastQuery.Limit, tc.historyWant, body)
			}
		})
	}
}

func TestEventsSinceCannotOverflowToNegativeCursor(t *testing.T) {
	env := newM5Env(t)
	for _, raw := range []string{"9223372036854775808", "9223372036854775807", "1e100", "Infinity", "-Infinity", "NaN"} {
		status, parsed, body := env.do(http.MethodGet, "/internal/agent-api/events/claim?since="+url.QueryEscape(raw), "", env.apiKey, nil)
		if status != http.StatusBadRequest || parsed["code"] != "since_invalid" {
			t.Fatalf("unrepresentable since=%q must not reach the store: %d %s", raw, status, body)
		}
	}
	if env.events.claimCalls != 0 {
		t.Fatal("invalid cursor reached the claim port")
	}
}
