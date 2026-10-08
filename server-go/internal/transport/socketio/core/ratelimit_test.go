package core

import (
	"sync"
	"testing"
	"time"
)

func TestLimiterBurstAndRefill(t *testing.T) {
	now := time.Unix(0, 0)
	l := NewLimiter(10, 3, func() time.Time { return now })
	for i := 0; i < 3; i++ {
		if !l.Allow() {
			t.Fatalf("burst %d denied", i)
		}
	}
	if l.Allow() {
		t.Fatal("burst exceeded but allowed")
	}
	now = now.Add(200 * time.Millisecond) // 2 tokens at 10/s
	if !l.Allow() || !l.Allow() {
		t.Fatal("refill failed")
	}
	if l.Allow() {
		t.Fatal("over-refill")
	}
	now = now.Add(time.Hour) // capped at burst
	if !l.Allow() || !l.Allow() || !l.Allow() || l.Allow() {
		t.Fatal("burst cap broken")
	}
}

func TestLimiterConcurrent(t *testing.T) {
	now := time.Unix(0, 0)
	var mu sync.Mutex
	cur := now
	l := NewLimiter(1000, 1000, func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return cur
	})
	var wg sync.WaitGroup
	allowed := make([]int, 8)
	for w := 0; w < 8; w++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				if l.Allow() {
					allowed[i]++
				}
			}
		}(w)
	}
	wg.Wait()
	total := 0
	for _, n := range allowed {
		total += n
	}
	if total > 1000 {
		t.Fatalf("allowed %d > burst 1000", total)
	}
}
