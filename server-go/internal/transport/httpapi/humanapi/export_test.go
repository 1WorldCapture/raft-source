package humanapi

// Test-only exports of unexported projection constants for the external
// test package (the standard export_test bridge).
var (
	TrialWindowStartForTest = trialWindowStart
	TrialWindowEndForTest   = trialWindowEnd
)

// PlanHistoryDaysForTest exposes the per-plan history-day projection.
var PlanHistoryDaysForTest = planHistoryDays

// HistoryCutoffForTest exposes the history cutoff projection.
var HistoryCutoffForTest = historyCutoff
