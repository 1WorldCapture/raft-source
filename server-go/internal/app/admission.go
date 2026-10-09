package app

import (
	"context"
	"errors"

	"raft.local/server-go/internal/application/agentdelivery"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/transport/machinews"
)

// admittedHub is the production SendWithAdmission entry. The delivery pump
// depends on the application interface, not on the hub package.
type admittedHub struct {
	hub *machinews.Hub
}

func (h admittedHub) SendAdmitted(ctx context.Context, machineID string, payload any, admission func(context.Context, computer.Principal, func() error) error) error {
	if h.hub == nil {
		return agentdelivery.ErrDispatchRefused
	}
	return classifyMachineSend(h.hub.SendWithAdmission(ctx, machineID, payload, admission))
}

func classifyMachineSend(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, machinews.ErrMachineOffline), errors.Is(err, machinews.ErrMachineUnknown):
		return agentdelivery.ErrMachineOffline
	case errors.Is(err, machinews.ErrHubClosed):
		return agentdelivery.ErrHubClosed
	case errors.Is(err, machinews.ErrSendQueueFull):
		return agentdelivery.ErrSendDeferred
	}
	if computer.AsAuthError(err) != nil {
		return agentdelivery.ErrDispatchRefused
	}
	return err
}
