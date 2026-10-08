// Cross-worker seams this package defines: the agent bootstrap exchanger
// implemented by the AGENT worker, and the internal-surface registry entry
// the preflight endpoint reflects. See docs/m3-computer-contract.md §2.7/2.8.
package computer

import "context"

// AgentBootstrapExchanger consumes a web-admin-issued bootstrap token and
// returns a fresh sk_agent_* credential. The AGENT worker owns the storage,
// pepper and single-consume CAS (TS services/agentCredentialService.ts
// consumeAgentBootstrapToken).
type AgentBootstrapExchanger interface {
	ExchangeAgentBootstrapToken(ctx context.Context, rawToken string, obs TokenUseObservation) (AgentBootstrapExchange, error)
}

// AgentBootstrapExchange is the successful exchange payload
// (TS agentLogin.ts 200 body fields).
type AgentBootstrapExchange struct {
	APIKey        string
	CredentialID  string
	AgentID       string
	AgentName     string
	WorkspaceID   string
	WorkspaceSlug string
	Scopes        []string
}

// BootstrapError carries the closed agent-login failure set.
type BootstrapError struct{ Code string }

func (e *BootstrapError) Error() string { return "computer: bootstrap exchange failed: " + e.Code }

// Bootstrap failure codes (TS agentLogin.ts error matrix).
const (
	BootstrapTokenInvalid     = "token_invalid"
	BootstrapTokenRevoked     = "token_revoked"
	BootstrapTokenExpired     = "token_expired"
	BootstrapTokenConsumed    = "token_consumed"
	BootstrapAgentMissing     = "agent_missing"
	BootstrapPepperMissing    = "bootstrap_token_pepper_missing"
	BootstrapMissingToken     = "missing_bootstrap_token"
	BootstrapSurfaceDisabled  = "self_hosted_runner_bootstrap_disabled"
	BootstrapExchangerMissing = "bootstrap_exchanger_unavailable"
)

// InternalRouteEntry is one row of the /internal/* route-auth registry the
// preflight endpoint reflects (TS routeAuthPolicy). Path uses the registry
// pattern style: literal segments plus ":name" placeholders.
type InternalRouteEntry struct {
	Method    string
	Path      string
	Principal string
}
