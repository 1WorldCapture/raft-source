package machinews

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"raft.local/server-go/internal/computer"
)

// Authenticator is the COMPUTER seam: *computer.Store satisfies it. The
// authenticator owns the whole key decision — format classification, key
// verification, machine-link, migrated-legacy rejection and workspace
// liveness for BOTH key families (sk_computer_* and legacy
// sk_machine_/sk_daemon_) — exactly the TS route→service split, where the
// route only extracts the credential and maps the deny reason.
type Authenticator interface {
	Authenticate(ctx context.Context, key string) (computer.Principal, error)
}

// OnReadyCallback receives the raw ready frame after its machine facts have
// been persisted. p is the principal of the connection that sent the frame.
type OnReadyCallback func(ctx context.Context, p computer.Principal, ready json.RawMessage) error

// OnMessageCallback receives every non-transport inbound frame, verbatim, in
// per-machine order. Authorization to the machine<->agent binding happens in
// the Agent store; machinews never acks on its behalf.
type OnMessageCallback func(ctx context.Context, p computer.Principal, msg json.RawMessage) error

// OnDisconnectCallback fires once, after the disconnect grace window has
// passed with no replacement connection, alongside the offline projection.
type OnDisconnectCallback func(ctx context.Context, p computer.Principal) error

// ReasonException is the route-level bucket for authenticator
// infrastructure failures (TS "exception"): answered with 500 and no
// Slock-Reason header.
const ReasonException = "exception"

// denyReasons is the closed Slock-Reason set: the computer package's denial
// reasons (byte-identical to the TS union) plus the route-level exception
// bucket. An AuthError whose Reason is outside this set is treated as an
// infrastructure failure.
var denyReasons = map[string]bool{
	computer.ReasonMissingKey:              true,
	computer.ReasonInvalidKeyFormat:        true,
	computer.ReasonComputerNotFound:        true,
	computer.ReasonComputerRevoked:         true,
	computer.ReasonComputerMachineUnlinked: true,
	computer.ReasonComputerKeyMismatch:     true,
	computer.ReasonServerNotFound:          true,
	computer.ReasonMachineNotFound:         true,
	computer.ReasonMachineKeyInvalid:       true,
	computer.ReasonLegacyKeyMigrated:       true,
	ReasonException:                        true,
}

// bearerPattern mirrors the TS /^Bearer\s+(.+)$/i extraction.
var bearerPattern = regexp.MustCompile(`(?i)^Bearer\s+(.+)$`)

// extractAPIKey resolves the daemon credential: Authorization: Bearer first,
// then the legacy ?key= query form (accepted for old daemons during rollout,
// never logged, never echoed).
func extractAPIKey(r *http.Request) string {
	raw := r.Header.Get("Authorization")
	if raw != "" {
		if m := bearerPattern.FindStringSubmatch(raw); m != nil {
			if token := strings.TrimSpace(m[1]); token != "" {
				return token
			}
		}
	}
	return r.URL.Query().Get("key")
}

// denyReasonFrom maps an authenticator failure to its wire reason. ok is
// false for infrastructure errors (plain errors, or an AuthError outside the
// closed set), which map to the 500/exception path.
func denyReasonFrom(err error) (reason string, ok bool) {
	if ae := computer.AsAuthError(err); ae != nil && denyReasons[ae.Reason] {
		return ae.Reason, true
	}
	return ReasonException, false
}
