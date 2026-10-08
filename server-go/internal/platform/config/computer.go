package config

import "strings"

// ComputerSettings freezes the environment-controlled admission surfaces.
// These are not the database feature flags: the TS device login surface is
// enabled by default, whereas external Agent bootstrap is opt-in only.
type ComputerSettings struct {
	DeviceLoginEnabled    bool
	AgentBootstrapEnabled bool
}

func readComputerSettings(get func(string) string) ComputerSettings {
	device := strings.ToLower(strings.TrimSpace(get("DEVICE_LOGIN_ENABLED")))
	disabled := device == "0" || device == "false" || device == "no" || device == "off"
	return ComputerSettings{
		DeviceLoginEnabled:    !disabled,
		AgentBootstrapEnabled: strings.EqualFold(strings.TrimSpace(get("AGENT_BOOTSTRAP_ENABLED")), "true"),
	}
}
