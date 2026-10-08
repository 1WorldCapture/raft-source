// Wire-level /api/agent/login contract: surface flag, honest 503 without the
// AGENT worker's exchanger, and the closed error-code matrix through a real
// single-consume exchanger implementation of the seam interface.
package legacyweb_test

import (
	"context"
	"net/http"
	"sync"
	"testing"

	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/transport/legacyweb"
)

// countingExchanger is a real (test-scope) implementation of the seam: one
// successful exchange per token, distinct closed-set failures afterwards.
type countingExchanger struct {
	mu        sync.Mutex
	exchanged map[string]int
}

func (c *countingExchanger) ExchangeAgentBootstrapToken(_ context.Context, rawToken string, _ computer.TokenUseObservation) (computer.AgentBootstrapExchange, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.exchanged == nil {
		c.exchanged = map[string]int{}
	}
	switch rawToken {
	case "bad":
		return computer.AgentBootstrapExchange{}, &computer.BootstrapError{Code: computer.BootstrapTokenInvalid}
	case "gone":
		return computer.AgentBootstrapExchange{}, &computer.BootstrapError{Code: computer.BootstrapTokenConsumed}
	}
	c.exchanged[rawToken]++
	if c.exchanged[rawToken] > 1 {
		return computer.AgentBootstrapExchange{}, &computer.BootstrapError{Code: computer.BootstrapTokenConsumed}
	}
	return computer.AgentBootstrapExchange{
		APIKey:        "sk_agent_exchangedkey0000000000000000000000",
		CredentialID:  "cred-1",
		AgentID:       "agent-1",
		AgentName:     "Cindy",
		WorkspaceID:   "w1",
		WorkspaceSlug: "alpha",
		Scopes:        []string{"messages:send"},
	}, nil
}

func TestAgentLoginSurfaceStates(t *testing.T) {
	off := newComputerEnv(t)
	if code, body, _ := off.serve("POST", "/api/agent/login", `{"bootstrapToken":"tok"}`, nil); code != http.StatusNotFound || body["code"] != computer.BootstrapSurfaceDisabled {
		t.Fatalf("disabled surface = %d %v", code, body["code"])
	}

	on := newComputerEnvWith(t, func(h *legacyweb.ComputerHandlers) {
		h.AgentBootstrapEnabled = true
	})
	if code, body, _ := on.serve("POST", "/api/agent/login", `{"bootstrapToken":"tok"}`, nil); code != http.StatusServiceUnavailable || body["code"] != computer.BootstrapExchangerMissing {
		t.Fatalf("no exchanger = %d %v", code, body["code"])
	}
	if code, body, _ := on.serve("POST", "/api/agent/login", `{"bootstrapToken":"   "}`, nil); code != http.StatusBadRequest || body["code"] != computer.BootstrapMissingToken {
		t.Fatalf("blank token = %d %v", code, body["code"])
	}
}

func TestAgentLoginExchange(t *testing.T) {
	exchanger := &countingExchanger{}
	e := newComputerEnvWith(t, func(h *legacyweb.ComputerHandlers) {
		h.AgentBootstrapEnabled = true
		h.AgentBootstrap = exchanger
	})

	code, body, raw := e.serve("POST", "/api/agent/login", `{"bootstrapToken":"tok-1"}`, nil)
	if code != http.StatusOK {
		t.Fatalf("exchange = %d %s", code, raw)
	}
	if body["apiKey"] != "sk_agent_exchangedkey0000000000000000000000" ||
		body["credentialId"] != "cred-1" || body["agentId"] != "agent-1" ||
		body["agentName"] != "Cindy" || body["serverId"] != "w1" || body["serverSlug"] != "alpha" {
		t.Fatalf("exchange body: %s", raw)
	}
	if scopes, _ := body["scopes"].([]any); len(scopes) != 1 || scopes[0] != "messages:send" {
		t.Fatalf("scopes = %v", body["scopes"])
	}

	// Closed error matrix.
	if code, body, _ := e.serve("POST", "/api/agent/login", `{"bootstrapToken":"tok-1"}`, nil); code != http.StatusGone || body["code"] != computer.BootstrapTokenConsumed {
		t.Fatalf("replay = %d %v", code, body["code"])
	}
	if code, body, _ := e.serve("POST", "/api/agent/login", `{"bootstrapToken":"bad"}`, nil); code != http.StatusUnauthorized || body["code"] != computer.BootstrapTokenInvalid {
		t.Fatalf("invalid = %d %v", code, body["code"])
	}
	if code, body, _ := e.serve("POST", "/api/agent/login", `{"bootstrapToken":"gone"}`, nil); code != http.StatusGone || body["code"] != computer.BootstrapTokenConsumed {
		t.Fatalf("gone = %d %v", code, body["code"])
	}
}
