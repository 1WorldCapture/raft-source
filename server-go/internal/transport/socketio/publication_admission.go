package socketio

import (
	"context"
	"encoding/json"

	"raft.local/server-go/internal/transport/socketio/core"
)

// PublishFilteredContext is the durable publisher's error-reporting seam.
// An empty rooms slice considers all OPENED sockets; otherwise only sockets
// subscribed to at least one supplied room are considered. include narrows
// those candidates through an already-projected authority binding, and MUST
// do only bounded memory reads (no database/network calls).
//
// Unlike best-effort convenience methods, cancellation, guard acquisition
// and serialization failures are returned to the outbox owner: an intent
// must not be marked processed when admission never ran. Queue overflow or
// revoked individual connections retain the established disconnect/recover
// policy rather than retrying the entire fanout indefinitely.
func (g *Gateway) PublishFilteredContext(ctx context.Context, rooms []string, event string, payload any, include func(core.Identity) bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	conns := g.reg.OpenedSnapshot()
	if len(rooms) != 0 {
		conns = g.reg.RoomMembers(rooms...)
	}
	frame := core.Frame{Event: event, Payload: data}
	err = g.withGuard(ctx, func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		for _, cs := range conns {
			if include != nil && !include(cs.Identity()) {
				continue
			}
			if err := g.enqueue(cs, frame); err != nil {
				g.handleEnqueueErr(cs, err)
			}
		}
		return nil
	})
	if err != nil {
		g.metrics.guardAbandoned.Add(1)
	}
	return err
}
