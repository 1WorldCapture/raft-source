package machinews

import (
	"sync"
	"sync/atomic"
)

// lifetime joins handshakes, connection loops, timer callbacks and closer
// goroutines. enter/Add and markClosed share one mutex, so Close's Wait
// cannot miss a goroutine that has already been admitted.
type lifetime struct {
	mu     sync.Mutex
	wg     sync.WaitGroup
	closed bool
	active atomic.Int32
}

func (l *lifetime) enter() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	l.wg.Add(1)
	l.active.Add(1)
	return true
}

func (l *lifetime) leave() {
	l.active.Add(-1)
	l.wg.Done()
}

func (l *lifetime) Go(fn func()) bool {
	if !l.enter() {
		return false
	}
	go func() {
		defer l.leave()
		fn()
	}()
	return true
}

func (l *lifetime) markClosed() {
	l.mu.Lock()
	l.closed = true
	l.mu.Unlock()
}

func (l *lifetime) wait() {
	l.wg.Wait()
}
