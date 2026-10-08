package machinews

import (
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// machineSlot serializes registration and the commit/callback window for one
// machine. It is reentrant on the owning goroutine so a callback can call
// Send or Snapshot without deadlocking. The lock is never held across a
// websocket close: Close waits for the read loop, and the read loop may be
// inside the callback that holds this lock.
type machineSlot struct {
	mu    sync.Mutex
	owner atomic.Int64
	depth int

	conn           *machineConn
	pending        *machineConn
	displaced      *pendingOffline
	offline        *pendingOffline
	connGeneration uint64
	statusVersion  uint64

	// onWait, if set, runs when Lock has to wait. Tests use it as a
	// deterministic contention barrier. It must not acquire this slot.
	onWait atomic.Value // func()
}

func (s *machineSlot) Lock() {
	gid := currentGID()
	if s.owner.Load() == gid {
		s.depth++
		return
	}
	if !s.mu.TryLock() {
		if hook, _ := s.onWait.Load().(func()); hook != nil {
			hook()
		}
		s.mu.Lock()
	}
	s.owner.Store(gid)
	s.depth = 1
}

func (s *machineSlot) Unlock() {
	if s.owner.Load() != currentGID() {
		panic("machinews: unlocking a machine slot without owning it")
	}
	s.depth--
	if s.depth > 0 {
		return
	}
	s.depth = 0
	s.owner.Store(0)
	s.mu.Unlock()
}

func currentGID() int64 {
	var buf [64]byte
	n := runtime.Stack(buf[:], false)
	// "goroutine 123 ["
	fields := strings.Fields(string(buf[:n]))
	if len(fields) < 2 {
		return 0
	}
	id, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return id
}
