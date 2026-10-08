package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestM2WorkspacePolicyConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name   string
		values map[string]string
		want   WorkspacePolicySettings
		bad    string
	}{
		{name: "C0", values: map[string]string{}},
		{name: "opener", values: map[string]string{"POLICY_ONBOARDING_OPENER_V2": "1"}, want: WorkspacePolicySettings{OnboardingOpenerV2: true}},
		{name: "wizard", values: map[string]string{"POLICY_ONBOARDING_OWNER_WIZARD_V0": "1"}, want: WorkspacePolicySettings{OnboardingOwnerWizardV0: true}},
		{name: "malformed", values: map[string]string{"POLICY_ONBOARDING_OPENER_V2": "true"}, bad: "must be 0 or 1"},
		{name: "feedback unavailable", values: map[string]string{"POLICY_FEEDBACK_ENABLED": "1"}, bad: "unsupported"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := map[string]string{}
			for key, value := range tc.values {
				env["RAFT_GO_"+key] = value
			}
			dir := t.TempDir()
			cfg, err := Load(lookup(env), dir, filepath.Join(dir, "keys", "jwt-secret"))
			if tc.bad != "" {
				if err == nil || !strings.Contains(err.Error(), tc.bad) {
					t.Fatalf("expected explicit configuration failure %q, got %v", tc.bad, err)
				}
				return
			}
			if err != nil || cfg.WorkspacePolicy != tc.want {
				t.Fatalf("policy = %#v, error = %v; want %#v", cfg, err, tc.want)
			}
		})
	}
}
