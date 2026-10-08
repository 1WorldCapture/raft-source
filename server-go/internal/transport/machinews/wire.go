package machinews

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Frame types this transport itself owns. Everything else is forwarded
// verbatim to the OnMessage callback.
const (
	frameTypeMachineContext = "machine:context"
	frameTypePing           = "ping"
	frameTypePong           = "pong"
	frameTypeReady          = "ready"
	frameTypeShutdown       = "machine:shutdown"
)

// machineContextFrame is the first frame sent after a successful upgrade,
// before registration can replay any queued work (machineContext.ts).
type machineContextFrame struct {
	Type      string `json:"type"`
	MachineID string `json:"machineId"`
	ServerID  string `json:"serverId"`
}

// pingFrame is both the heartbeat request and the daemon liveness probe
// reply — the TS server answers an inbound ping with ping, not pong.
type pingFrame struct {
	Type string `json:"type"`
}

var pingBytes = []byte(`{"type":"ping"}`)

// readyFrame carries the subset of the TS ready union this transport
// validates and persists. Pointer fields distinguish "absent" (do not touch
// the persisted column) from "present" — the TS `!== undefined` semantics.
// migrationTransport and lifecycleAcks are accepted but not acted on (M4/M5).
type readyFrame struct {
	Type               string          `json:"type"`
	Capabilities       []string        `json:"capabilities"`
	Runtimes           []string        `json:"runtimes"`
	RuntimeVersions    map[string]any  `json:"runtimeVersions"`
	RunningAgents      []string        `json:"runningAgents"`
	Hostname           *string         `json:"hostname"`
	OS                 *string         `json:"os"`
	DaemonVersion      *string         `json:"daemonVersion"`
	ComputerVersion    *string         `json:"computerVersion"`
	HostKind           string          `json:"hostKind"`
	MigrationTransport json.RawMessage `json:"migrationTransport"`
	LifecycleAcks      json.RawMessage `json:"lifecycleAcks"`
}

// shutdownReasons mirrors MACHINE_SHUTDOWN_REASONS.
var shutdownReasons = map[string]bool{
	"computer_stop": true,
	"daemon_stop":   true,
	"unknown":       true,
}

// computerHostKinds mirrors COMPUTER_HOST_KINDS; missing or unknown values
// normalize to standalone.
var computerHostKinds = map[string]bool{
	"desktop_app": true,
	"standalone":  true,
}

// normalizeComputerHostKind ports normalizeComputerHostKind.
func normalizeComputerHostKind(value string) string {
	if computerHostKinds[value] {
		return value
	}
	return "standalone"
}

// Bounded-input caps. The TS server trusted a fully authenticated peer; Go
// validates with modest caps so a hostile machine cannot balloon rows. See
// the contract doc.
const (
	maxReadyRuntimes      = 128
	maxRuntimeIDLength    = 64
	maxReadyRunningAgents = 512
	maxReadyCapabilities  = 64
	maxHostnameLength     = 256
	maxOSLength           = 128
	maxVersionLength      = 128
	maxRuntimeVersions    = 32
	maxRuntimeVersionLen  = 128
)

// parseEnvelope extracts just the frame discriminator. It returns an error
// for frames without a non-empty string type; the caller drops them (TS
// parity: invalid JSON is logged, never fatal to the connection).
func parseEnvelope(data []byte) (string, error) {
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return "", fmt.Errorf("invalid frame JSON: %w", err)
	}
	if env.Type == "" {
		return "", fmt.Errorf("frame has no type")
	}
	return env.Type, nil
}

// validateReady performs strict shape validation and normalization. It
// returns the validated fields ready for persistence. Runtimes/runningAgents
// entries must be non-empty bounded strings; runtimeVersions follows the
// exact TS normalization (allow-list by runtimes, <=32 entries, trimmed
// 1..128 values).
func validateReady(frame *readyFrame) error {
	if len(frame.Runtimes) > maxReadyRuntimes {
		return fmt.Errorf("ready: runtimes exceeds %d entries", maxReadyRuntimes)
	}
	seenRuntime := make(map[string]bool, len(frame.Runtimes))
	for _, r := range frame.Runtimes {
		if r == "" || len(r) > maxRuntimeIDLength {
			return fmt.Errorf("ready: invalid runtime id")
		}
		seenRuntime[r] = true
	}
	if len(frame.RunningAgents) > maxReadyRunningAgents {
		return fmt.Errorf("ready: runningAgents exceeds %d entries", maxReadyRunningAgents)
	}
	for _, a := range frame.RunningAgents {
		if a == "" || len(a) > maxRuntimeIDLength {
			return fmt.Errorf("ready: invalid running agent id")
		}
	}
	if frame.Hostname != nil && len(*frame.Hostname) > maxHostnameLength {
		return fmt.Errorf("ready: hostname too long")
	}
	if frame.OS != nil && len(*frame.OS) > maxOSLength {
		return fmt.Errorf("ready: os too long")
	}
	if frame.DaemonVersion != nil && len(*frame.DaemonVersion) > maxVersionLength {
		return fmt.Errorf("ready: daemonVersion too long")
	}
	if frame.ComputerVersion != nil && len(*frame.ComputerVersion) > maxVersionLength {
		return fmt.Errorf("ready: computerVersion too long")
	}
	return nil
}

// normalizeRuntimeVersions ports normalizeRuntimeVersions exactly: keys must
// be reported runtimes, at most 32 entries survive, keys <=64 chars, values
// trimmed to a non-empty string of at most 128 chars.
func normalizeRuntimeVersions(raw map[string]any, runtimes []string) map[string]string {
	if raw == nil {
		return map[string]string{}
	}
	allowed := make(map[string]bool, len(runtimes))
	for _, r := range runtimes {
		allowed[r] = true
	}
	versions := map[string]string{}
	count := 0
	for id, value := range raw {
		if count >= maxRuntimeVersions {
			break
		}
		if !allowed[id] || len(id) > maxRuntimeIDLength {
			continue
		}
		version, ok := value.(string)
		if !ok {
			continue
		}
		version = strings.TrimSpace(version)
		if version == "" || len(version) > maxRuntimeVersionLen {
			continue
		}
		versions[id] = version
		count++
	}
	return versions
}

// normalizeCapabilities keeps the original strings whose trim is non-empty
// (TS filter semantics) and bounds the list.
func normalizeCapabilities(raw []string) []string {
	out := make([]string, 0, len(raw))
	for _, c := range raw {
		if strings.TrimSpace(c) == "" {
			continue
		}
		out = append(out, c)
		if len(out) >= maxReadyCapabilities {
			break
		}
	}
	return out
}
