// Package machinecontrol coordinates the machine event flow between the
// daemon transport, the runtime-catalog broker and the agent lifecycle
// service. It owns no facts: every principal revalidation delegates to the
// computer domain, runtime routing to the broker, agent lifecycle effects to
// the agent service. The transport calls these handlers synchronously inside
// the current connection's admission protection.
package machinecontrol

import (
	"context"
	"encoding/json"
	"errors"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/runtimecatalog"
)

// ValidatePrincipal cheaply rechecks a previously proven principal
// (credential revision, revocation, workspace and machine binding).
type ValidatePrincipal func(ctx context.Context, p computer.Principal) error

// Coordinator is the machine event coordinator wired into the daemon Hub.
// Its dependencies are validated and bound once, before exposing listeners.
type Coordinator struct {
	service  *agent.Service
	broker   *runtimecatalog.Broker
	validate ValidatePrincipal
}

// NewCoordinator rejects incomplete wiring instead of admitting a partially
// initialized public struct whose dependencies can later be replaced.
func NewCoordinator(service *agent.Service, broker *runtimecatalog.Broker, validate ValidatePrincipal) (*Coordinator, error) {
	if service == nil || broker == nil || validate == nil {
		return nil, errors.New("machinecontrol: service, broker and principal validator are required")
	}
	return &Coordinator{service: service, broker: broker, validate: validate}, nil
}

// OnReady persists the ready facts (delegated) and notifies the agent
// lifecycle, revalidating the principal first.
func (c *Coordinator) OnReady(ctx context.Context, principal computer.Principal, raw json.RawMessage) error {
	if err := c.validate(ctx, principal); err != nil {
		return err
	}
	return c.service.OnReady(ctx, principal, raw)
}

// OnMessage routes a daemon frame through the runtime-catalog broker first;
// unhandled frames go to the agent lifecycle service.
func (c *Coordinator) OnMessage(ctx context.Context, principal computer.Principal, raw json.RawMessage) error {
	if err := c.validate(ctx, principal); err != nil {
		return err
	}
	handled, err := c.broker.OnMachineMessage(ctx, principal, raw)
	if handled || err != nil {
		return err
	}
	return c.service.OnMessage(ctx, principal, raw)
}

// OnDisconnect detaches the broker connection and records the agent-side
// disconnect effect.
func (c *Coordinator) OnDisconnect(ctx context.Context, principal computer.Principal) error {
	c.broker.Disconnect(principal.MachineID)
	return c.service.OnDisconnect(ctx, principal)
}
