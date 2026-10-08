package config

import "fmt"

// loadWorkspacePolicy freezes the small M2 local policy surface. It does not
// claim to be the cloud feature-flag service or silently enable missing writers.
func loadWorkspacePolicy(get func(string) string) (WorkspacePolicySettings, error) {
	var policy WorkspacePolicySettings
	for _, flag := range []struct {
		name   string
		target *bool
	}{
		{"POLICY_ONBOARDING_OPENER_V2", &policy.OnboardingOpenerV2},
		{"POLICY_ONBOARDING_OWNER_WIZARD_V0", &policy.OnboardingOwnerWizardV0},
		{"POLICY_FEEDBACK_ENABLED", &policy.FeedbackEnabled},
	} {
		switch get(flag.name) {
		case "", "0":
			*flag.target = false
		case "1":
			*flag.target = true
		default:
			return policy, fmt.Errorf("RAFT_GO_%s must be 0 or 1", flag.name)
		}
	}
	if policy.FeedbackEnabled {
		return policy, fmt.Errorf("RAFT_GO_POLICY_FEEDBACK_ENABLED=1 is unsupported: the feedback service is not implemented in M2")
	}
	return policy, nil
}
