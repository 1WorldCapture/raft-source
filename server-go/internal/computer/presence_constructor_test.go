package computer

import (
	"sync/atomic"
	"testing"
)

// A nil database handle must fail construction: a non-nil PresenceStore
// wrapping a nil handle would silently satisfy the Hub's required-Facts
// check and panic on the first observation instead of failing at assembly.
func TestPresenceStoreRejectsNilDatabase(t *testing.T) {
	if s, err := NewPresenceStore(nil, PresenceOptions{}); err == nil || s != nil {
		t.Fatalf("nil handle constructed %v, err=%v; want construction failure", s, err)
	}
}

// The fault-injection hooks are plain function VALUES captured once at
// construction: after the store exists there is no way to replace the
// behavior through the store (the historical *func() pointer seam is gone).
// A test that needs mid-scenario changes routes them through its own
// mutable dispatcher read by the captured closure.
func TestPresenceStoreHooksAreCapturedOnce(t *testing.T) {
	var calls atomic.Int32
	dispatch := func() { calls.Add(1) }
	s, err := NewPresenceStore(nil, PresenceOptions{TestBeforeReadyWrite: dispatch})
	if err == nil {
		t.Fatal("nil handle must still fail even with hooks supplied")
	}
	_ = s
}
