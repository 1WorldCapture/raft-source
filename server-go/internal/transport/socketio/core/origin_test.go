package core

import (
	"net/http/httptest"
	"testing"
)

func TestOriginAllowlist(t *testing.T) {
	a := ParseOriginAllowlist([]string{"http://localhost:5175", "https://Raft.Example.com"})
	cases := []struct {
		origin string
		want   bool
	}{
		{"http://localhost:5175", true},
		{"https://raft.example.com", true},     // host lowercased
		{"https://RAFT.example.com:443", true}, // default port dropped
		{"http://localhost:5175/", true},       // path ignored via parse
		{"http://evil.example", false},
		{"https://raft.example.com:8443", false},
		{"null", false},
		{"", true}, // no Origin header at all
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", "/socket.io/?EIO=4&transport=websocket", nil)
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		if got := a.Allows(req); got != c.want {
			t.Errorf("origin %q: got %v want %v", c.origin, got, c.want)
		}
	}
}

func TestOriginAllowlistEmptyFailsClosed(t *testing.T) {
	a := ParseOriginAllowlist(nil)
	if !a.Empty() {
		t.Fatal("empty allowlist not empty")
	}
	req := httptest.NewRequest("GET", "/socket.io/", nil)
	req.Header.Set("Origin", "http://localhost:5175")
	if a.Allows(req) {
		t.Fatal("browser origin allowed with empty allowlist")
	}
	if !a.Allows(httptest.NewRequest("GET", "/socket.io/", nil)) {
		t.Fatal("origin-less request must pass (non-browser client)")
	}
}

func TestOriginAllowlistWildcard(t *testing.T) {
	a := ParseOriginAllowlist([]string{"*"})
	req := httptest.NewRequest("GET", "/socket.io/", nil)
	req.Header.Set("Origin", "https://anywhere.example")
	if !a.Allows(req) {
		t.Fatal("wildcard rejected")
	}
}
