package machinews

import (
	"context"
	"encoding/json"
	"errors"

	"raft.local/server-go/internal/computer"
)

// AdmissionFunc is the caller-supplied authorization callback for
// SendWithAdmission. It runs while the machine slot guard is HELD, in the
// established lock order slot -> (caller authority fence / SQL facts) ->
// enqueue, so the caller may re-verify Agent/launch/channel permission
// against a live fact snapshot and still complete the bounded enqueue
// atomically under the same slot: nothing can replace the connection between
// the callback's checks and the frame entering the send queue. The
// principal argument is the AUTHENTICATED machine identity (never a payload
// field); enqueue is the ONLY way the frame is queued — refusing (any error)
// queues nothing.
type AdmissionFunc func(ctx context.Context, principal computer.Principal, enqueue func() error) error

// errAdmissionRequired marks a nil admission callback. A dispatch without
// an authorization callback fails closed; there is no "just send it" mode.
var errAdmissionRequired = errors.New("machinews: SendWithAdmission requires a non-nil admission callback")

// SendWithAdmission delivers one payload to the machine's CURRENT published
// connection behind a caller-supplied admission callback. Unlike Send —
// which revalidates only the Computer principal — this is the M5 controlled
// delivery entry: the caller (the delivery dispatcher) verifies the full
// Agent/launch/channel authorization inside the callback, holding the shared
// authority fence and a live fact snapshot through the actual bounded
// enqueue. Lock order (machinecontrol/lifecycle contract §5): the slot guard
// is acquired here and held across the callback; the callback's own order
// must be fence/SQL only (never acquire the machine slot — it is already
// held, and no other path may take the fence while holding a slot it does
// not release). A nil admission fails closed. Frame-scoped contexts (every
// ready/message/disconnect callback) can deliver only to their own
// generation, exactly like Send.
func (h *Hub) SendWithAdmission(ctx context.Context, machineID string, payload any, admission AdmissionFunc) error {
	if payload == nil {
		return errors.New("machinews: nil payload")
	}
	if admission == nil {
		return errAdmissionRequired
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if h.closing.Load() {
		return ErrHubClosed
	}
	scope, scoped := frameScopeFrom(ctx)
	if scoped && scope.machineID != machineID {
		return ErrMachineOffline
	}
	s := h.slotExisting(machineID)
	if s == nil {
		if scoped {
			return ErrMachineOffline
		}
		return h.offlineOrUnknown(ctx, machineID)
	}
	s.Lock()
	held := true
	defer func() {
		if held {
			s.Unlock()
		}
	}()
	c := s.conn
	if h.closing.Load() {
		return ErrHubClosed
	}
	if scoped && (c == nil || c != scope.conn || c.generation != scope.generation || c.isRetired()) {
		return ErrMachineOffline
	}
	if c == nil || c.isRetired() {
		// Release before the facts lookup so this path never holds the slot
		// across an unbounded DB read (same discipline as Send).
		held = false
		s.Unlock()
		return h.offlineOrUnknown(ctx, machineID)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := h.revalidate(ctx, c.principal); err != nil {
		held = false
		s.Unlock()
		if computer.AsAuthError(err) != nil {
			h.revoke(c, err)
		}
		return err
	}
	if h.closing.Load() {
		return ErrHubClosed
	}
	if s.conn != c || c.isRetired() || (scoped && c.generation != scope.generation) {
		return ErrMachineOffline
	}
	// The callback runs INSIDE the slot guard. enqueue re-checks ownership
	// under the still-held lock and is bounded (queue full -> typed error,
	// never a block).
	enqueue := func() error {
		if !h.owns(s, c) {
			return errStale
		}
		if h.closing.Load() {
			return ErrHubClosed
		}
		return c.enqueue(data)
	}
	return admission(ctx, c.principal, enqueue)
}
