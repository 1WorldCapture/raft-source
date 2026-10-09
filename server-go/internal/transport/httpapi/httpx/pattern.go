// Shared request-shape patterns and small rendering helpers common to every
// HTTP leaf.
package httpx

import (
	"database/sql"
	"net/http"
	"regexp"
	"time"

	"raft.local/server-go/internal/platform/ratelimit"
)

// UUIDPattern is the canonical UUID shape used by path/query identifiers.
var UUIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// MachineIDPattern is the machine/computer row id shape.
var MachineIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// EnvKeyPattern is the env var key shape ([A-Za-z_][A-Za-z0-9_]*).
var EnvKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Uint64Pattern is the canonical unsigned integer literal shape.
var Uint64Pattern = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

// ClientIPOf resolves the client IP for audit records (best effort, same
// derivation as the rate limiter).
func ClientIPOf(r *http.Request) string { return ratelimit.ClientIP(r) }

// NullableString renders a SQL nullable string as a JSON value (nil when
// NULL) without inventing empty-string sentinels.
func NullableString(v sql.NullString) any {
	if !v.Valid {
		return nil
	}
	return v.String
}

// ISOMillisStr renders epoch millis as the wire ISO-8601 millisecond shape.
func ISOMillisStr(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}
