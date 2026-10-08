package core

import (
	"errors"
	"sync"
)

// OutboundQueue is the per-connection bounded pending-send backlog bounded
// BOTH by envelope count and by accounted bytes (phase-4-messaging.md §7.2
// first-load values: 256 envelopes / 1 MiB). It is the backpressure point
// between publish paths and the connection's wire drainer.
//
// Behavior on bound breach is deliberate: the offer fails and the caller
// disconnects the connection (close the transport, let the original client
// auto-reconnect and gap-sync). Silently dropping a frame while the
// connection keeps looking synchronized is forbidden (phase-4-messaging.md
// §7.2: "超限明确断开，让客户端重连补同步；不得静默丢一条后继续报告完全同步").
type OutboundQueue struct {
	mu        sync.Mutex
	frames    []Frame
	bytes     int64
	maxMsgs   int
	maxBytes  int64
	notify    chan struct{}
	done      chan struct{} // closed on Close: wakes EVERY drainer
	closed    bool
	overflow  bool
	closeOnce sync.Once
}

// Queue errors.
var (
	// ErrQueueFull means a bound was breached: count or bytes.
	ErrQueueFull = errors.New("socketio: outbound queue full")
	// ErrQueueClosed means the queue was drained and closed: the
	// connection is going away; offers are refused.
	ErrQueueClosed = errors.New("socketio: outbound queue closed")
)

// NewOutboundQueue builds a queue with the given bounds (values <= 0 fall
// back to the package defaults).
func NewOutboundQueue(maxMsgs int, maxBytes int64) *OutboundQueue {
	if maxMsgs <= 0 {
		maxMsgs = DefaultMaxQueueMessages
	}
	if maxBytes <= 0 {
		maxBytes = DefaultMaxQueueBytes
	}
	return &OutboundQueue{
		maxMsgs:  maxMsgs,
		maxBytes: maxBytes,
		notify:   make(chan struct{}, 1),
		done:     make(chan struct{}),
	}
}

// Offer appends a frame if both bounds hold. On ErrQueueFull the frame is
// NOT appended; the caller must disconnect the connection.
func (q *OutboundQueue) Offer(f Frame) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return ErrQueueClosed
	}
	if len(q.frames) >= q.maxMsgs || q.bytes+f.Bytes() > q.maxBytes {
		q.overflow = true
		return ErrQueueFull
	}
	q.frames = append(q.frames, f)
	q.bytes += f.Bytes()
	select {
	case q.notify <- struct{}{}:
	default:
	}
	return nil
}

// Take returns the next frame in FIFO order, blocking until one is
// available, the queue closes, or done fires. After close it drains the
// remaining frames first (bounded by what is already queued), then returns
// ErrQueueClosed. Safe for several concurrent takers: Close broadcasts via
// a closed channel so no taker can sleep through shutdown.
func (q *OutboundQueue) Take(done <-chan struct{}) (Frame, error) {
	for {
		q.mu.Lock()
		if len(q.frames) > 0 {
			f := q.frames[0]
			q.frames = q.frames[1:]
			q.bytes -= f.Bytes()
			q.mu.Unlock()
			return f, nil
		}
		if q.closed {
			q.mu.Unlock()
			return Frame{}, ErrQueueClosed
		}
		notify, closed := q.notify, q.done
		q.mu.Unlock()
		select {
		case <-notify:
		case <-closed:
			// Loop: drain-then-exit is decided under the lock above.
		case <-done:
			return Frame{}, ErrQueueClosed
		}
	}
}

// Closed reports whether Close was called (frames may still be draining).
func (q *OutboundQueue) Closed() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.closed
}

// Len reports the pending envelope count.
func (q *OutboundQueue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.frames)
}

// Bytes reports the pending accounted bytes.
func (q *OutboundQueue) Bytes() int64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.bytes
}

// Overflowed reports whether any offer ever breached a bound since the
// queue was created (diagnostics; the caller disconnects on first breach).
func (q *OutboundQueue) Overflowed() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.overflow
}

// Close marks the queue closed. Pending frames stay readable until drained
// (Take keeps returning them), then Take returns ErrQueueClosed. Idempotent.
// Closing the done channel wakes every blocked taker at once.
func (q *OutboundQueue) Close() {
	q.closeOnce.Do(func() {
		q.mu.Lock()
		q.closed = true
		q.mu.Unlock()
		close(q.done)
	})
}
