package core

import (
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// OriginAllowlist gates the Engine.IO websocket handshake by the request's
// Origin header (phase-4-messaging.md §7.2: checked against a configured
// allowlist, never derived from Host).
//
// Semantics (fail closed):
//
//   - A request WITHOUT an Origin header is allowed: non-browser clients
//     (the acceptance spike's Node client) omit it, matching the original
//     server where CORS never applies to same-origin/non-browser traffic.
//   - A request WITH an Origin header must match an allowlist entry
//     exactly (scheme+host+port comparison, case-insensitive host) or the
//     wildcard "*".
//   - An EMPTY allowlist rejects every Origin-bearing request: browsers
//     always send Origin on websocket opens, so nothing is silently
//     granted. Tests and the spike configure entries explicitly.
type OriginAllowlist struct {
	wildcard bool
	entries  map[string]struct{}
}

// ParseOriginAllowlist builds an allowlist from configured origins. Entries
// are normalized: scheme lowered, host lowered, default ports dropped
// (http:80, https:443), no trailing slash. "*" allows any origin.
func ParseOriginAllowlist(origins []string) *OriginAllowlist {
	a := &OriginAllowlist{entries: make(map[string]struct{})}
	for _, o := range origins {
		o = strings.TrimSpace(o)
		if o == "" {
			continue
		}
		if o == "*" {
			a.wildcard = true
			continue
		}
		if u, err := url.Parse(o); err == nil && u.Host != "" {
			host := strings.ToLower(u.Hostname())
			port := u.Port()
			if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
				port = ""
			}
			key := strings.ToLower(u.Scheme) + "://" + host
			if port != "" {
				key += ":" + port
			}
			a.entries[key] = struct{}{}
			continue
		}
		// Tolerate bare host[:port] entries by treating them as http.
		a.entries[strings.ToLower("http://"+strings.TrimSuffix(o, "/"))] = struct{}{}
	}
	return a
}

// Empty reports whether nothing is allowed: with no wildcard and no
// entries, every Origin-bearing request is rejected.
func (a *OriginAllowlist) Empty() bool { return !a.wildcard && len(a.entries) == 0 }

// Entries returns the normalized allowlist for logging/config echo.
func (a *OriginAllowlist) Entries() []string {
	out := make([]string, 0, len(a.entries))
	for e := range a.entries {
		out = append(out, e)
	}
	sort.Strings(out)
	return out
}

// Allows checks the handshake request. No Origin header -> true.
func (a *OriginAllowlist) Allows(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if a.wildcard {
		return true
	}
	if u, err := url.Parse(origin); err == nil && u.Host != "" {
		host := strings.ToLower(u.Hostname())
		port := u.Port()
		if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
			port = ""
		}
		key := strings.ToLower(u.Scheme) + "://" + host
		if port != "" {
			key += ":" + port
		}
		_, ok := a.entries[key]
		return ok
	}
	return false
}
