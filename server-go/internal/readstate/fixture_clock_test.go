package readstate

import (
	"sync/atomic"
	"time"
)

// concurrentFixtureClock is shared by the message-writing goroutine, the
// readstate store and its channel dependency. A plain clock.Fixed.T may not
// be mutated while either store concurrently validates an access token.
type concurrentFixtureClock struct {
	nanos atomic.Int64
}

func newConcurrentFixtureClock(t time.Time) *concurrentFixtureClock {
	clock := &concurrentFixtureClock{}
	clock.nanos.Store(t.UnixNano())
	return clock
}

func (c *concurrentFixtureClock) Now() time.Time {
	return time.Unix(0, c.nanos.Load()).UTC()
}

func (c *concurrentFixtureClock) Advance(delta time.Duration) {
	c.nanos.Add(int64(delta))
}
