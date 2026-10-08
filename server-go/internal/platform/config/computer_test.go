package config

import "testing"

func TestComputerSurfaceDefaultsAreNotFeatureFlagDefaults(t *testing.T) {
	got := readComputerSettings(func(string) string { return "" })
	if !got.DeviceLoginEnabled || got.AgentBootstrapEnabled {
		t.Fatalf("device login defaults on; external agent bootstrap defaults off: %+v", got)
	}
}

func TestComputerSurfaceEnvironmentMatchesReference(t *testing.T) {
	for _, raw := range []string{"0", " false ", "NO", "off"} {
		got := readComputerSettings(func(key string) string {
			if key == "DEVICE_LOGIN_ENABLED" {
				return raw
			}
			return ""
		})
		if got.DeviceLoginEnabled {
			t.Errorf("device disable %q was ignored", raw)
		}
	}
	for _, raw := range []string{"", "1", "true", "yes", "legacy-other-value"} {
		got := readComputerSettings(func(key string) string {
			if key == "DEVICE_LOGIN_ENABLED" {
				return raw
			}
			return ""
		})
		if !got.DeviceLoginEnabled {
			t.Errorf("reference device enabled value %q was changed", raw)
		}
	}
	for _, raw := range []string{"", "1", "false", "yes", "true", " TRUE "} {
		got := readComputerSettings(func(key string) string {
			if key == "AGENT_BOOTSTRAP_ENABLED" {
				return raw
			}
			return ""
		})
		want := raw == "true" || raw == " TRUE "
		if got.AgentBootstrapEnabled != want {
			t.Errorf("bootstrap %q: %v", raw, got.AgentBootstrapEnabled)
		}
	}
}
