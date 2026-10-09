package machinecontrol_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"raft.local/server-go/internal/agent"
	"raft.local/server-go/internal/application/machinecontrol"
	"raft.local/server-go/internal/computer"
	"raft.local/server-go/internal/runtimecatalog"
)

func TestCoordinatorRejectsMissingDependencies(t *testing.T) {
	service, broker := &agent.Service{}, &runtimecatalog.Broker{}
	validate := func(context.Context, computer.Principal) error { return nil }
	for _, tc := range []struct {
		name     string
		service  *agent.Service
		broker   *runtimecatalog.Broker
		validate machinecontrol.ValidatePrincipal
	}{
		{"service", nil, broker, validate},
		{"broker", service, nil, validate},
		{"validator", service, broker, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := machinecontrol.NewCoordinator(tc.service, tc.broker, tc.validate)
			if err == nil || c != nil {
				t.Fatalf("incomplete construction: coordinator=%v err=%v", c, err)
			}
		})
	}
}

func TestCoordinatorBindsValidationBeforeCallbacks(t *testing.T) {
	denied := errors.New("revoked principal")
	calls := 0
	validate := func(context.Context, computer.Principal) error {
		calls++
		return denied
	}
	// Zero-valued downstream components are intentional sentinels: any
	// dispatch before validation would invoke their uninitialized internals.
	c, err := machinecontrol.NewCoordinator(&agent.Service{}, &runtimecatalog.Broker{}, validate)
	if err != nil {
		t.Fatal(err)
	}
	validate = func(context.Context, computer.Principal) error {
		t.Fatal("constructor input rebinding must not replace the captured validator")
		return nil
	}
	for _, callback := range []func(context.Context, computer.Principal, json.RawMessage) error{c.OnReady, c.OnMessage} {
		if err := callback(t.Context(), computer.Principal{}, json.RawMessage(`{}`)); !errors.Is(err, denied) {
			t.Fatalf("validation denial was lost: %v", err)
		}
	}
	if calls != 2 {
		t.Fatalf("validator called %d times, want once per callback", calls)
	}
}
