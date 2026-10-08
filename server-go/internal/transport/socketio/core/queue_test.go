package core

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

func frameFor(event string, n int) Frame {
	payload, _ := json.Marshal(map[string]int{"n": n})
	return Frame{Event: event, Payload: payload}
}

func TestQueueCountBound(t *testing.T) {
	q := NewOutboundQueue(3, 1<<20)
	for i := 0; i < 3; i++ {
		if err := q.Offer(frameFor("e", i)); err != nil {
			t.Fatalf("offer %d: %v", i, err)
		}
	}
	if err := q.Offer(frameFor("e", 99)); err != ErrQueueFull {
		t.Fatalf("want ErrQueueFull, got %v", err)
	}
	if !q.Overflowed() {
		t.Fatal("overflow flag not set")
	}
	if q.Len() != 3 {
		t.Fatalf("len = %d", q.Len())
	}
	// FIFO order preserved.
	for i := 0; i < 3; i++ {
		f, err := q.Take(nil)
		if err != nil {
			t.Fatalf("take: %v", err)
		}
		var m map[string]int
		if err := json.Unmarshal(f.Payload, &m); err != nil {
			t.Fatal(err)
		}
		if m["n"] != i {
			t.Fatalf("order broken: %v", m)
		}
	}
}

func TestQueueByteBound(t *testing.T) {
	q := NewOutboundQueue(100, 128)
	small := json.RawMessage(`"ab"`) // event(1)+16+4 accounted bytes < 128
	if err := q.Offer(Frame{Event: "e", Payload: small}); err != nil {
		t.Fatalf("first offer within bytes: %v", err)
	}
	for i := 0; i < 100; i++ {
		big, _ := json.Marshal(make([]string, 64))
		if err := q.Offer(Frame{Event: "e", Payload: big}); err == ErrQueueFull {
			return // bound hit
		}
	}
	t.Fatal("byte bound never enforced")
}

func TestQueueCloseDrainsThenRefuses(t *testing.T) {
	q := NewOutboundQueue(4, 1<<20)
	_ = q.Offer(frameFor("a", 1))
	q.Close()
	if err := q.Offer(frameFor("b", 2)); err != ErrQueueClosed {
		t.Fatalf("offer after close: %v", err)
	}
	// Pending frame still drained.
	f, err := q.Take(nil)
	if err != nil || f.Event != "a" {
		t.Fatalf("drain after close: %v %v", f, err)
	}
	if _, err := q.Take(nil); err != ErrQueueClosed {
		t.Fatalf("take exhausted: %v", err)
	}
}

func TestQueueTakeUnblocksOnDone(t *testing.T) {
	q := NewOutboundQueue(4, 1<<20)
	done := make(chan struct{})
	go func() {
		time.Sleep(20 * time.Millisecond)
		close(done)
	}()
	start := time.Now()
	if _, err := q.Take(done); err != ErrQueueClosed {
		t.Fatalf("want closed on done, got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("Take blocked past done")
	}
}

func TestQueueConcurrentOfferDrain(t *testing.T) {
	q := NewOutboundQueue(64, 1<<30)
	var wg sync.WaitGroup
	stop := make(chan struct{})
	// 4 drainers.
	for d := 0; d < 4; d++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				f, err := q.Take(nil)
				if err != nil {
					return
				}
				_ = f
			}
		}()
	}
	// 8 offerers.
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(seed int) {
			defer wg.Done()
			for i := 0; i < 500; i++ {
				_ = q.Offer(frameFor("e", seed*1000+i))
			}
		}(w)
	}
	// Stopper closes after offers settle.
	go func() {
		time.Sleep(150 * time.Millisecond)
		q.Close()
	}()
	_ = stop
	wg.Wait()
	q.Close()
}
