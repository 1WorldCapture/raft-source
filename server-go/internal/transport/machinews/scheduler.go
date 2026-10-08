package machinews

import (
	"container/heap"
	"sync"
	"time"
)

// Scheduler abstracts the timer primitives the hub needs (heartbeat ticks,
// the delayed offline projection, ready-fact persist retries). Production
// uses RealScheduler; tests use ManualScheduler so every timer fires at a
// pinned instant instead of a sleep.
type Scheduler interface {
	// After runs fn once, no earlier than d from now. The returned stop
	// function cancels the callback if it has not started.
	After(d time.Duration, fn func()) (stop func())

	// Tick runs fn repeatedly, every d, until the returned stop function is
	// called. Ticks never overlap.
	Tick(d time.Duration, fn func()) (stop func())
}

// RealScheduler wires the Scheduler interface onto the runtime timer
// primitives. Each timer consumes one goroutine only while firing; a tick
// loop runs on its own goroutine so callbacks may block briefly without
// drifting the schedule.
type RealScheduler struct{}

// After implements Scheduler.
func (RealScheduler) After(d time.Duration, fn func()) (stop func()) {
	t := time.AfterFunc(d, fn)
	return func() { t.Stop() }
}

// Tick implements Scheduler.
func (RealScheduler) Tick(d time.Duration, fn func()) (stop func()) {
	done := make(chan struct{})
	once := &sync.Once{}
	go func() {
		ticker := time.NewTicker(d)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				fn()
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}

// ManualScheduler is a deterministic Scheduler for tests: nothing fires by
// itself; Advance runs every due callback on the caller's goroutine, in
// deadline order. Callbacks that schedule more work are picked up by the
// same Advance call.
type ManualScheduler struct {
	mu    sync.Mutex
	now   time.Time
	items manualQueue
	seq   uint64
}

type manualItem struct {
	deadline time.Time
	seq      uint64
	fn       func()
	stopped  bool
}

// NewManualScheduler pins the scheduler clock at start.
func NewManualScheduler(start time.Time) *ManualScheduler {
	return &ManualScheduler{now: start}
}

// Now reports the scheduler's pinned instant.
func (m *ManualScheduler) Now() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.now
}

// After implements Scheduler.
func (m *ManualScheduler) After(d time.Duration, fn func()) (stop func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	item := &manualItem{deadline: m.now.Add(d), seq: m.seq, fn: fn}
	heap.Push(&m.items, item)
	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		item.stopped = true
	}
}

// Tick implements Scheduler: a self-rescheduling one-shot so Advance can
// fire ticks deterministically. The returned stop function is idempotent.
func (m *ManualScheduler) Tick(d time.Duration, fn func()) (stop func()) {
	t := &tickGeneration{sched: m, interval: d, fn: fn}
	t.schedule()
	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		t.stopped = true
	}
}

type tickGeneration struct {
	sched    *ManualScheduler
	interval time.Duration
	fn       func()
	stopped  bool
}

func (t *tickGeneration) schedule() {
	t.sched.mu.Lock()
	defer t.sched.mu.Unlock()
	if t.stopped {
		return
	}
	t.sched.seq++
	item := &manualItem{deadline: t.sched.now.Add(t.interval), seq: t.sched.seq, fn: func() {
		t.sched.mu.Lock()
		stopped := t.stopped
		t.sched.mu.Unlock()
		if stopped {
			return
		}
		t.fn()
		t.schedule()
	}}
	heap.Push(&t.sched.items, item)
}

// Advance moves the pinned clock to now (which must not move backwards) and
// runs every due callback, earliest first, including work scheduled by the
// callbacks themselves. It returns the number of callbacks run.
func (m *ManualScheduler) Advance(now time.Time) int {
	run := 0
	for {
		m.mu.Lock()
		if now.Before(m.now) {
			m.mu.Unlock()
			panic("ManualScheduler: time moved backwards")
		}
		item := m.popDue(now)
		if item == nil {
			m.now = now
			m.mu.Unlock()
			return run
		}
		m.now = item.deadline
		m.mu.Unlock()
		item.fn()
		run++
	}
}

// AdvanceBy is Advance relative to the current pinned instant.
func (m *ManualScheduler) AdvanceBy(d time.Duration) int {
	m.mu.Lock()
	now := m.now.Add(d)
	m.mu.Unlock()
	return m.Advance(now)
}

func (m *ManualScheduler) popDue(now time.Time) *manualItem {
	for m.items.Len() > 0 {
		item := m.items[0]
		if item.deadline.After(now) {
			return nil
		}
		heap.Pop(&m.items)
		if item.stopped {
			continue
		}
		return item
	}
	return nil
}

type manualQueue []*manualItem

func (q manualQueue) Len() int { return len(q) }
func (q manualQueue) Less(i, j int) bool {
	if !q[i].deadline.Equal(q[j].deadline) {
		return q[i].deadline.Before(q[j].deadline)
	}
	return q[i].seq < q[j].seq
}
func (q manualQueue) Swap(i, j int) { q[i], q[j] = q[j], q[i] }
func (q *manualQueue) Push(x any)   { *q = append(*q, x.(*manualItem)) }
func (q *manualQueue) Pop() any {
	old := *q
	n := len(old)
	item := old[n-1]
	old[n-1] = nil
	*q = old[:n-1]
	return item
}
