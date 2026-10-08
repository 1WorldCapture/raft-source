package core

import (
	"sync"
	"sync/atomic"
)

// Lifetime joins handshakes, room setup barriers, heartbeat ticks, wire
// drainers and closer goroutines the same way machinews.lifetime does:
// enter/Add and markClosed share one mutex so Close's Wait cannot miss a
// goroutine that has already been admitted.
type Lifetime struct {
	mu     sync.Mutex
	wg     sync.WaitGroup
	closed bool
	active atomic.Int32
}

// Enter registers one goroutine-to-be. False once closed.
func (l *Lifetime) Enter() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return false
	}
	l.wg.Add(1)
	l.active.Add(1)
	return true
}

// Leave releases one Enter.
func (l *Lifetime) Leave() {
	l.active.Add(-1)
	l.wg.Done()
}

// Go spawns fn tracked by this lifetime. False (not spawned) once closed.
func (l *Lifetime) Go(fn func()) bool {
	if !l.Enter() {
		return false
	}
	go func() {
		defer l.Leave()
		fn()
	}()
	return true
}

// MarkClosed forbids new goroutines; existing ones keep running.
func (l *Lifetime) MarkClosed() {
	l.mu.Lock()
	l.closed = true
	l.mu.Unlock()
}

// Active reports the number of live tracked goroutines.
func (l *Lifetime) Active() int32 { return l.active.Load() }

// Wait blocks until every tracked goroutine has left.
func (l *Lifetime) Wait() { l.wg.Wait() }
