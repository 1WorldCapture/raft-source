package socketio

import (
	"context"
	"errors"
	"testing"
	"time"

	"raft.local/server-go/internal/transport/socketio/core"
)

func TestDurablePublicationAdmissionReturnsFailures(t *testing.T) {
	refused := errors.New("temporary admission failure")
	guard := &armGuard{refuse: refused}
	g, _, _, _ := newTestGateway(t, func(opts *Options) { opts.Guard = guard })
	t.Cleanup(func() { _ = g.Close() })
	guard.armNow()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := g.PublishFilteredContext(ctx, nil, "test", map[string]any{}, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled publication was not retryable: %v", err)
	}
	if err := g.PublishFilteredContext(context.Background(), nil, "test", func() {}, nil); err == nil {
		t.Fatal("serialization failure silently completed a durable publication")
	}
	if err := g.PublishFilteredContext(context.Background(), nil, "test", map[string]any{}, nil); !errors.Is(err, refused) {
		t.Fatalf("guard failure was not propagated to the durable owner: %v", err)
	}
	if g.Snapshot().GuardAbandoned != 1 {
		t.Fatalf("abandoned admission was not counted: %+v", g.Snapshot())
	}
}

func TestQueuedFrameRechecksFenceBeforeDelayedWake(t *testing.T) {
	g, transport, _, fence := newTestGateway(t, nil)
	t.Cleanup(func() { _ = g.Close() })
	transport.setUnwritable("queued", true)
	if _, err := admitWS(t, g, "queued", "u1", "w1", "u1/f1"); err != nil {
		t.Fatal(err)
	}
	g.Opened("queued")
	waitUntil(t, time.Second, func() bool {
		cs, ok := g.reg.Get("queued")
		return ok && cs.Queue().Len() != 0
	}, "room barrier is queued behind an unwritable transport")
	if err := g.PublishFilteredContext(context.Background(), []string{core.ChannelRoom("ch1")}, "sensitive", map[string]any{"body": "queued under old permission"}, nil); err != nil {
		t.Fatal(err)
	}
	// Only the committed fence changes. Deliberately do not call Revoke:
	// this models an asynchronous eviction wake that has not arrived yet.
	fence.Bump(core.WorkspaceFenceScope("w1"))
	transport.setUnwritable("queued", false)
	waitUntil(t, time.Second, func() bool { return transport.closeCount("queued") != 0 }, "stale queued transport closes before delayed eviction")
	for _, frame := range transport.frames("queued") {
		if frame.Event == "sensitive" {
			t.Fatal("queued content reached the wire after its authority generation became stale")
		}
	}
}
