// Package clock abstracts time so session expiry, token TTLs and replay
// windows are testable.
package clock

import "time"

// Clock returns the current instant.
type Clock interface {
	Now() time.Time
}

// Real is the production wall clock.
type Real struct{}

// Now implements Clock.
func (Real) Now() time.Time { return time.Now() }

// Fixed is a manually advanced clock for tests.
type Fixed struct{ T time.Time }

// Now implements Clock.
func (f *Fixed) Now() time.Time { return f.T }

// Advance moves the fixed clock forward.
func (f *Fixed) Advance(d time.Duration) { f.T = f.T.Add(d) }
