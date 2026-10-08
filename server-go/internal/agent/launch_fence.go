// Launch fence for agent:start. The server mints a launch id before Send
// when the daemon reports >= 0.30.1 (the version that echoes launchId).
// A later agent:status or agent:session on the same connection is applied
// only when its launchId is the current fence. Delayed frames from the
// previous start cannot overwrite the new launch. There is no delivery queue.
package agent

import (
	"crypto/rand"
	"fmt"
	"strconv"
	"strings"
)

// armLaunch records the expected launch id for a guarded daemon and returns
// it. Older or missing versions stay in legacy mode and return "".
func (s *Service) armLaunch(agentID, daemonVersion string) string {
	if s == nil || agentID == "" || !supportsLaunchGuard(daemonVersion) {
		return ""
	}
	id, err := newLaunchID()
	if err != nil {
		return ""
	}
	s.launchMu.Lock()
	defer s.launchMu.Unlock()
	if s.launchID == nil {
		s.launchID = map[string]string{}
	}
	s.launchID[agentID] = id
	return id
}

// rollbackLaunch drops the fence when Send failed and nobody has replaced it.
func (s *Service) rollbackLaunch(agentID, launchID string) {
	if s == nil || launchID == "" {
		return
	}
	s.launchMu.Lock()
	defer s.launchMu.Unlock()
	if s.launchID[agentID] == launchID {
		delete(s.launchID, agentID)
	}
}

// clearLaunch returns the agent to legacy acceptance (session/full reset).
func (s *Service) clearLaunch(agentID string) {
	if s == nil || agentID == "" {
		return
	}
	s.launchMu.Lock()
	defer s.launchMu.Unlock()
	delete(s.launchID, agentID)
}

// acceptLaunch applies planLifecycleEventAcceptance. A missing fence accepts
// every event. A guarded agent rejects a missing or different launchId.
func (s *Service) acceptLaunch(agentID string, launchID *string) bool {
	if s == nil {
		return true
	}
	s.launchMu.Lock()
	expected := s.launchID[agentID]
	s.launchMu.Unlock()
	if expected == "" {
		return true
	}
	if launchID == nil || *launchID == "" || *launchID != expected {
		return false
	}
	return true
}

// supportsLaunchGuard reports daemon versions that echo launchId (>= 0.30.1).
func supportsLaunchGuard(version string) bool {
	major, minor, patch, ok := parseDaemonSemver(version)
	if !ok {
		return false
	}
	if major > 0 {
		return true
	}
	if minor > 30 {
		return true
	}
	return minor == 30 && patch >= 1
}

func parseDaemonSemver(version string) (major, minor, patch int, ok bool) {
	version = strings.TrimSpace(version)
	if version == "" {
		return 0, 0, 0, false
	}
	parts := strings.SplitN(version, ".", 3)
	if len(parts) < 3 {
		return 0, 0, 0, false
	}
	patchText := parts[2]
	for i, r := range patchText {
		if r < '0' || r > '9' {
			patchText = patchText[:i]
			break
		}
	}
	var err error
	if major, err = strconv.Atoi(parts[0]); err != nil {
		return 0, 0, 0, false
	}
	if minor, err = strconv.Atoi(parts[1]); err != nil {
		return 0, 0, 0, false
	}
	if patch, err = strconv.Atoi(patchText); err != nil {
		return 0, 0, 0, false
	}
	return major, minor, patch, true
}

func newLaunchID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16]), nil
}

func stringOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
