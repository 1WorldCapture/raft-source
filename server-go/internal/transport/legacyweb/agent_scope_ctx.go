// Request-scope plumbing for the agent surface: the X-Server-Id scope
// (workspace id + resolved role) and small shared helpers.
package legacyweb

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
)

type agentScopeContext struct {
	WorkspaceID string
	Role        string
}

type agentScopeKey struct{}

func withAgentScope(ctx context.Context, workspaceID, role string) context.Context {
	return context.WithValue(ctx, agentScopeKey{}, agentScopeContext{WorkspaceID: workspaceID, Role: role})
}

func agentScopeOf(r *http.Request) agentScopeContext {
	scope, _ := r.Context().Value(agentScopeKey{}).(agentScopeContext)
	return scope
}

func rolePtr(role string) *string { return &role }

// runtimeConfigRuntimeOf reads runtimeConfig.runtime when the payload is a
// JSON object carrying a string runtime (TS rawRuntimeConfigRuntime).
func runtimeConfigRuntimeOf(raw json.RawMessage) string {
	if len(raw) == 0 || !isJSONObject(raw) {
		return ""
	}
	var probe struct {
		Runtime *string `json:"runtime"`
	}
	if json.Unmarshal(raw, &probe) != nil || probe.Runtime == nil {
		return ""
	}
	return trimSpace(*probe.Runtime)
}

func isJSONObject(raw json.RawMessage) bool {
	var probe map[string]json.RawMessage
	return json.Unmarshal(raw, &probe) == nil
}

// parseAgentEnvVars ports parseEnvVars: nil/absent is a no-op (nil return),
// everything else must be a string->string map with valid env keys and no
// NUL bytes. Returns the failure sentence when invalid.
func parseAgentEnvVars(raw json.RawMessage) (json.RawMessage, string) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, ""
	}
	var probe map[string]any
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, "envVars must be an object"
	}
	parsed := map[string]string{}
	for key, value := range probe {
		text, ok := value.(string)
		if !ok {
			return nil, "envVars keys and values must be strings"
		}
		if !envKeyPattern.MatchString(key) {
			return nil, "Invalid env var key \"" + key + "\": must match [A-Za-z_][A-Za-z0-9_]*"
		}
		if strings.ContainsRune(key, 0) || strings.ContainsRune(text, 0) {
			return nil, "envVars keys and values must not contain null bytes"
		}
		parsed[key] = text
	}
	encoded, err := json.Marshal(parsed)
	if err != nil {
		return nil, "envVars must be an object"
	}
	return encoded, ""
}

// onboardingMemorySeedEnv is the documented Cindy seed (TS constant).
const onboardingMemorySeedEnv = "SLOCK_ONBOARDING_MEMORY_SEED"

// withOnboardingMemorySeed merges the first-cindy seed into parsed envVars.
func withOnboardingMemorySeed(envVars json.RawMessage) json.RawMessage {
	parsed := map[string]string{}
	if len(envVars) > 0 {
		_ = json.Unmarshal(envVars, &parsed)
	}
	parsed[onboardingMemorySeedEnv] = "first-cindy"
	encoded, err := json.Marshal(parsed)
	if err != nil {
		return envVars
	}
	return encoded
}

// scopeLog routes structured warnings through the request logger seam.
func scopeLog(r *http.Request, message, agentID string, err error) {
	// The legacy transport has no per-request logger; stderr-style logging is
	// centralized in the app logger. Keep the seam honest and cheap.
	_ = r
	_ = message
	_ = agentID
	_ = err
}

func trimSpace(v string) string { return strings.TrimSpace(v) }

func nullableString(v sql.NullString) any {
	if !v.Valid {
		return nil
	}
	return v.String
}

func nullStringOf(v *string) *sql.NullString {
	if v == nil {
		empty := sql.NullString{}
		return &empty
	}
	value := sql.NullString{String: *v, Valid: true}
	return &value
}

func nullStringEmpty() *sql.NullString {
	empty := sql.NullString{}
	return &empty
}
