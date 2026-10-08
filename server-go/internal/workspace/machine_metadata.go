package workspace

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// LiveMachineMetadata contains public current-connection facts, never API keys,
// provider credentials or private runtime configuration. nil from the probe
// means no current connection: persisted versions alone are not live evidence.
type LiveMachineMetadata struct {
	WorkspaceID     string
	DaemonVersion   string
	ComputerVersion string
	HostKind        string
	RuntimeVersions map[string]string
	StatusVersion   int64
}

type MachineMetadataProbe func(context.Context, string) (*LiveMachineMetadata, error)

func (s *Store) applyLiveMachineMetadata(ctx context.Context, row machineDirectoryRow, model map[string]any) error {
	if s.machineMetadata == nil {
		return nil
	}
	live, err := s.machineMetadata(ctx, row.ID)
	if err != nil {
		return fmt.Errorf("resolve machine connection metadata: %w", err)
	}
	if live == nil {
		model["status"] = ComputerStateOffline
		model["statusSince"] = deriveStatusSince(row)
		return nil
	}
	if live.WorkspaceID != row.ServerID {
		return fmt.Errorf("machine connection metadata workspace mismatch")
	}
	model["statusVersion"] = live.StatusVersion
	versions := make(map[string]string, len(live.RuntimeVersions))
	for key, value := range live.RuntimeVersions {
		versions[key] = value
	}
	model["runtimeVersions"] = versions
	if live.DaemonVersion != "" {
		model["daemonVersion"] = live.DaemonVersion
	}
	if live.ComputerVersion != "" {
		model["computerVersion"] = live.ComputerVersion
		hostKind := live.HostKind
		if hostKind != "desktop_app" {
			hostKind = "standalone"
		}
		model["hostKind"] = hostKind
	}
	if isComputer, _ := model["isComputer"].(bool); !isComputer {
		model["hostKind"] = nil
		return nil
	}
	// No local Hands release-dispatch authority is configured. Preserve TS
	// guard reasons; never invent an update or contact a cloud service on GET.
	model["computerUpgradeAvailable"] = false
	model["computerBroadcastPolicy"] = broadcastPolicyProjection{
		Eligibility: "no_broadcast",
		ReasonCode:  localComputerUpgradeReason(live.ComputerVersion, live.HostKind, row.OS.String),
	}
	return nil
}

var computerSemverPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?(\+[0-9A-Za-z.-]+)?$`)
var computerArchPattern = regexp.MustCompile(`\b(arm64|aarch64|x64|x86 64|amd64)\b`)
var computerOSPattern = regexp.MustCompile(`\b(darwin|macos|mac os|linux|windows|win32)\b`)

func localComputerUpgradeReason(version, hostKind, rawOS string) string {
	if hostKind == "desktop_app" {
		return "app_managed"
	}
	if version == "" {
		return "source_missing"
	}
	if !computerSemverPattern.MatchString(version) {
		return "source_unparseable"
	}
	withoutBuild, _, _ := strings.Cut(version, "+")
	_, pre, hasPre := strings.Cut(withoutBuild, "-")
	if hasPre {
		for _, part := range strings.Split(pre, ".") {
			if len(part) > 1 && part[0] == '0' && allASCIIDigits(part) {
				return "source_unparseable"
			}
		}
	}
	normalizedOS := strings.ToLower(strings.TrimSpace(rawOS))
	normalizedOS = strings.NewReplacer("_", " ", "-", " ").Replace(normalizedOS)
	if !computerArchPattern.MatchString(normalizedOS) || !computerOSPattern.MatchString(normalizedOS) {
		return "platform_unknown"
	}
	return "hands_unavailable"
}

func allASCIIDigits(value string) bool {
	for i := range value {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return value != ""
}
