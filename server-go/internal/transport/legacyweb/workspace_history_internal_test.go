package legacyweb

// Unit coverage for the time-dependent list projection (R17): the frozen
// free-trial window and the per-plan history policy. The list endpoint in
// production runs on the real clock (today is past the trial), so the
// boundary branches are pinned here against injected instants.

import (
	"testing"
	"time"
)

func TestPlanHistoryDaysTrialWindow(t *testing.T) {
	inside := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	start := trialWindowStart
	end := trialWindowEnd
	justBefore := start.Add(-time.Millisecond)
	justInside := start
	justBeforeEnd := end.Add(-time.Millisecond)

	cases := []struct {
		name string
		plan string
		at   time.Time
		want int
	}{
		{"free before trial", "free", justBefore, 30},
		{"free at trial start", "free", justInside, -1},
		{"free inside trial", "free", inside, -1},
		{"free just before trial end", "free", justBeforeEnd, -1},
		{"free after trial", "free", end, 30},
		{"empty plan reads free before trial", "", justBefore, 30},
		{"empty plan reads free inside trial", "", inside, -1},
		{"pro unlimited inside trial", "pro", inside, -1},
		{"founder unlimited after trial", "founder", end, -1},
		{"partner unlimited", "partner", inside, -1},
	}
	for _, tc := range cases {
		if got := planHistoryDays(tc.plan, tc.at); got != tc.want {
			t.Errorf("%s: planHistoryDays(%q) = %d, want %d", tc.name, tc.plan, got, tc.want)
		}
	}
	// The window matches the frozen shared constants (TRIAL_START_DATE /
	// TRIAL_END_DATE 2026-06-23T12:00:00Z after the accepted extensions).
	if !start.Equal(time.Date(2026, 4, 18, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("trial start drifted: %v", start)
	}
	if !end.Equal(time.Date(2026, 6, 23, 12, 0, 0, 0, time.UTC)) {
		t.Errorf("trial end drifted: %v", end)
	}
}

func TestHistoryCutoffShape(t *testing.T) {
	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	if got := historyCutoff("pro", now); got != nil {
		t.Errorf("unlimited plan must have a null cutoff, got %v", *got)
	}
	got := historyCutoff("free", now)
	if got == nil {
		t.Fatal("finite plan needs a cutoff")
	}
	if *got != "2026-09-08T12:00:00.000Z" {
		t.Errorf("cutoff = %q, want 30 days back at millisecond precision", *got)
	}
}
