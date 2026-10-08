package machinews

import "errors"

// Sentinel errors returned by the Hub public API. They are stable contract
// values; callers may compare with errors.Is.
var (
	// ErrHubClosed is returned by Send (and logs on new handshakes) after
	// Close. The hub refuses new connections once closed.
	ErrHubClosed = errors.New("machinews: hub closed")

	// ErrMachineOffline is returned by Send when the machine row exists but
	// no live connection is registered.
	ErrMachineOffline = errors.New("machinews: machine not connected")

	// ErrMachineUnknown is returned by Send when no machines row exists.
	ErrMachineUnknown = errors.New("machinews: unknown machine")

	// ErrSendQueueFull is returned by Send when the machine's bounded
	// outbound queue is full. The frame is NOT enqueued; the caller decides
	// how to retry. The connection is never grown without bound.
	ErrSendQueueFull = errors.New("machinews: send queue full")

	// errStale means this connection is no longer the machine's current
	// generation. Callers drop the mutation instead of committing it.
	errStale = errors.New("machinews: stale connection")

	// errNoMachineRow means the machines row disappeared before publish.
	errNoMachineRow = errors.New("machinews: machine row missing")
)

// Disconnect causes carried on the internal disconnect pipeline. They appear
// in logs (never on the wire) and are closed-set by construction.
const (
	causeSocketClose       = "socket_close"
	causeSocketError       = "socket_error"
	causeHeartbeatTimeout  = "heartbeat_timeout"
	causeReplaced          = "superseded_connection"
	causeServerDisconnect  = "server_disconnect"
	causeHubClosing        = "hub_closing"
	causePrincipalRevoked  = "principal_revoked"
	causeContextSendFailed = "machine_context_send_failed"
)
