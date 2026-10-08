// BootstrapExchanger is the AGENT implementation of
// computer.AgentBootstrapExchanger. Parent assigns it to
// ComputerHandlers.AgentBootstrap. The HTTP route stays in the computer
// worker; this type owns pepper, single-consume CAS and sk_agent_* mint.
package agent

import (
	"context"

	"raft.local/server-go/internal/computer"
)

// IdentityInternalRoutes is the sk_agent_* read surface parent merges into
// the internal-route registry. These rows are the M3 reads this slice
// actually serves. Later message, task, and wiki paths stay off the
// registry until those slices exist; the HTTP catch-all denies them.
func IdentityInternalRoutes() []computer.InternalRouteEntry {
	return []computer.InternalRouteEntry{
		{Method: "GET", Path: "/internal/agent-api", Principal: "sk_agent"},
		{Method: "GET", Path: "/internal/agent-api/", Principal: "sk_agent"},
		{Method: "GET", Path: "/internal/agent-api/server", Principal: "sk_agent"},
		{Method: "GET", Path: "/internal/agent-api/channel-members", Principal: "sk_agent"},
	}
}

// BootstrapExchanger consumes one web-issued bootstrap token.
type BootstrapExchanger struct {
	Store *Store
}

// NewBootstrapExchanger builds the adapter. Store must carry the credential
// hasher (pepper); a nil hasher surfaces as bootstrap_token_pepper_missing.
func NewBootstrapExchanger(store *Store) *BootstrapExchanger {
	return &BootstrapExchanger{Store: store}
}

// ExchangeAgentBootstrapToken implements computer.AgentBootstrapExchanger.
func (e *BootstrapExchanger) ExchangeAgentBootstrapToken(ctx context.Context, rawToken string, obs computer.TokenUseObservation) (computer.AgentBootstrapExchange, error) {
	if e == nil || e.Store == nil || e.Store.hasher == nil {
		return computer.AgentBootstrapExchange{}, &computer.BootstrapError{Code: computer.BootstrapPepperMissing}
	}
	var ip, ua *string
	if obs.IP != "" {
		ip = &obs.IP
	}
	if obs.UserAgent != "" {
		ua = &obs.UserAgent
	}
	minted, err := e.Store.ConsumeBootstrapToken(ctx, rawToken, ip, ua)
	if err != nil {
		if code, ok := bootstrapCode(err); ok {
			return computer.AgentBootstrapExchange{}, &computer.BootstrapError{Code: code}
		}
		return computer.AgentBootstrapExchange{}, err
	}
	var slug string
	_ = e.Store.db.QueryRowContext(ctx, `
		SELECT slug FROM workspaces WHERE id = ? AND deleted_at IS NULL`, minted.WorkspaceID).Scan(&slug)
	return computer.AgentBootstrapExchange{
		APIKey:        minted.APIKey,
		CredentialID:  minted.CredentialID,
		AgentID:       minted.AgentID,
		AgentName:     minted.AgentName,
		WorkspaceID:   minted.WorkspaceID,
		WorkspaceSlug: slug,
		Scopes:        minted.Scopes,
	}, nil
}

func bootstrapCode(err error) (string, bool) {
	domain := AsError(err)
	if domain == nil {
		return "", false
	}
	switch domain {
	case ErrTokenInvalid:
		return computer.BootstrapTokenInvalid, true
	case ErrTokenRevoked:
		return computer.BootstrapTokenRevoked, true
	case ErrTokenExpired:
		return computer.BootstrapTokenExpired, true
	case ErrTokenConsumed:
		return computer.BootstrapTokenConsumed, true
	case ErrAgentMissing:
		return computer.BootstrapAgentMissing, true
	default:
		if domain.Code == "token_invalid" || domain.Code == "token_revoked" ||
			domain.Code == "token_expired" || domain.Code == "token_consumed" ||
			domain.Code == "agent_missing" {
			return domain.Code, true
		}
		return "", false
	}
}
