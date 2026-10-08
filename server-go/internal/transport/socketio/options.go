package socketio

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"raft.local/server-go/internal/platform/clock"
	"raft.local/server-go/internal/transport/socketio/core"
)

// Options is the wiring surface the parent (internal/app) uses to compose
// the Socket.IO transport with the auth/channel/message/readstate modules.
// Nothing here imports those modules: the gateway consumes the callback
// interfaces below, so the cross-module dependency lock lands in the parent
// only.
type Options struct {
	Logger *slog.Logger
	Clock  clock.Clock

	// Auth authenticates handshakes in two steps mirroring the original
	// server's ordering (socket/index.ts): Identify decodes the token
	// synchronously WITHOUT database access, then the gateway snapshots the
	// authorization fence, then Authenticate runs the database-backed
	// validation. A revocation that commits while Authenticate reads the
	// database is caught by the post-auth fence re-read.
	Auth HandshakeAuth

	// Fence is the shared authorization fence. Its Generation method runs
	// on every publish to every connection: it must be non-blocking and
	// must not perform network I/O. Required.
	Fence core.AuthorizationFence

	// ChannelRooms resolves a freshly opened connection's authorized
	// channel/DM subscription set (the TS server joins every channel and DM
	// for unread tracking). The rooms:joined barrier completes only after
	// this returns. Required.
	ChannelRooms InitialRoomsResolver

	// Join authorizes join:channel requests. Fail-closed: errors and false
	// both leave the connection unsubscribed (silently to the client, like
	// the original). Required.
	Join RoomAccess

	// Resume serves sync:resume pages from the persistent read model.
	// Required.
	Resume ResumeProvider

	// Heartbeat supplies each workspace's committed message high-water for
	// application heartbeats. Required.
	Heartbeat HeartbeatSource

	// Guard serializes "eligibility check + non-blocking admission" against
	// authority-changing commits (the parent implements it with
	// db.WithAuthorityReadContext). It wraps every publish's fence check +
	// bounded enqueue and the admission fence snapshots; it MUST NOT cover
	// a blocking network write or a wait on a consumer. Nil degrades to
	// unguarded check-then-use (recorded once in logs); production wires
	// the parent guard.
	Guard AdmissionGuard

	// Origins is the handshake Origin allowlist. Empty rejects every
	// Origin-bearing (browser) request — configure the web origin
	// explicitly; origins are never derived from Host.
	Origins []string

	// Bounds. Zero falls back to core defaults (documented first-load test
	// values, not verified capacity).
	MaxEventBytes      int64
	MaxQueueMessages   int
	MaxQueueBytes      int64
	MaxConnsPerUser    int
	EventRatePerSecond float64
	EventBurst         float64
	HeartbeatInterval  time.Duration
	RoomSetupTimeout   time.Duration
	// WriteStallTimeout bounds how long a drainer waits for the transport
	// to become writable again (upstream write backpressure / dead peer)
	// before the connection is raw-closed with its buffers discarded. Zero
	// defaults to DefaultWriteStallTimeout.
	WriteStallTimeout time.Duration
	// ResumeFrameOverheadBytes is the accounting headroom reserved for the
	// sync:resume:response envelope around its messages.
	ResumeFrameOverheadBytes int64
}

// validate checks required dependencies.
func (o *Options) validate() error {
	if o.Guard == nil {
		return errors.New("socketio: Options.Guard is required (the parent's authority-read guard); refusing unguarded check-then-use")
	}
	if o.Auth == nil {
		return errors.New("socketio: Options.Auth is required")
	}
	if o.Fence == nil {
		return errors.New("socketio: Options.Fence is required")
	}
	if o.ChannelRooms == nil {
		return errors.New("socketio: Options.ChannelRooms is required")
	}
	if o.Join == nil {
		return errors.New("socketio: Options.Join is required")
	}
	if o.Resume == nil {
		return errors.New("socketio: Options.Resume is required")
	}
	if o.Heartbeat == nil {
		return errors.New("socketio: Options.Heartbeat is required")
	}
	return nil
}

func (o *Options) withDefaults() Options {
	out := *o
	if out.MaxEventBytes <= 0 {
		out.MaxEventBytes = core.DefaultMaxEventBytes
	}
	if out.MaxQueueMessages <= 0 {
		out.MaxQueueMessages = core.DefaultMaxQueueMessages
	}
	if out.MaxQueueBytes <= 0 {
		out.MaxQueueBytes = core.DefaultMaxQueueBytes
	}
	if out.MaxConnsPerUser <= 0 {
		out.MaxConnsPerUser = core.DefaultMaxConnsPerUser
	}
	if out.EventRatePerSecond <= 0 {
		out.EventRatePerSecond = core.DefaultEventRatePerSecond
	}
	if out.EventBurst <= 0 {
		out.EventBurst = core.DefaultEventBurst
	}
	if out.HeartbeatInterval <= 0 {
		out.HeartbeatInterval = core.HeartbeatInterval
	}
	if out.RoomSetupTimeout <= 0 {
		out.RoomSetupTimeout = DefaultRoomSetupTimeout
	}
	if out.WriteStallTimeout <= 0 {
		out.WriteStallTimeout = DefaultWriteStallTimeout
	}
	if out.ResumeFrameOverheadBytes <= 0 {
		out.ResumeFrameOverheadBytes = 256
	}
	if out.Logger == nil {
		out.Logger = slog.Default()
	}
	if out.Clock == nil {
		out.Clock = clock.Real{}
	}
	return out
}

// DefaultRoomSetupTimeout bounds the authorized room-setup barrier. The
// original server had no bound (a wedged DB query left the connection
// pre-barrier forever); the Go adapter fails closed and disconnects so the
// client retries against the current authorization state.
const DefaultRoomSetupTimeout = 10 * time.Second

// DefaultWriteStallTimeout bounds a wedged outbound write before a raw
// close-with-discard. The upstream websocket writer has no write deadline,
// so a zero-window peer could otherwise pin the write queue forever.
const DefaultWriteStallTimeout = 30 * time.Second

// AdmissionGuard closes the check/use race between an authorization commit
// and a publish: inside Guard, fence reads and bounded queue offers are
// atomic with respect to authority-changing writes (the parent's
// db.WithAuthorityReadContext holds the admission fence against
// db.WithWriteTx). fn must perform NO network writes and must not wait on
// a consumer; violating that is a caller bug.
type AdmissionGuard interface {
	Guard(ctx context.Context, fn func() error) error
}

// TokenProof is the verified access token's own timing evidence, frozen
// into the connection identity at admission. The parent revalidates this
// exact proof; a newer token for the same user/family never extends an
// older socket, and each socket dies at its own token's expiry.
type TokenProof struct {
	IssuedAt  time.Time
	ExpiresAt time.Time // zero = authenticator supplied none
}

// HandshakeAuth is the injected authenticator. It MUST NOT hold a database
// transaction that waits on network I/O (phase-4 design §2).
type HandshakeAuth interface {
	// Identify decodes the access token WITHOUT touching the database:
	// signature and token type only (the TS server's synchronous
	// verifyToken). ErrInvalidTokenType / ErrInvalidOrExpiredToken classify
	// the rejection. The returned proof is the VERIFIED token's own
	// IssuedAt/ExpiresAt — not a lookup of the newest token for the user.
	Identify(ctx context.Context, token string) (userID string, sessionFamilyID string, proof TokenProof, err error)

	// Authenticate performs the full database-backed validation for the
	// identified user: the exact token (by its proof) is still the live
	// family's token, the session is active, and, when the client bound a
	// workspace, membership plus the current role.
	Authenticate(ctx context.Context, req HandshakeRequest) (*Admission, error)
}

// HandshakeRequest is everything the authenticator may rely on. Auth
// carries exactly the original client's fields {token, serverId:
// string|null, clientKind}; HTTP is the Engine.IO upgrade request itself.
type HandshakeRequest struct {
	Auth core.HandshakeAuth
	HTTP *http.Request
}

// Admission is the database-backed verdict. The workspace binding comes
// from the CLIENT's serverId (frozen into the identity); the authenticator
// only answers the role for that binding.
type Admission struct {
	// ServerRole is the role observed at admission ("guest", "member",
	// ...). Required for workspace-bound connections; it feeds
	// guest-scoped revocation matching.
	ServerRole string
}

// Handshake sentinel errors: these map 1:1 to the exact connect_error
// strings the original web client matches (see core events).
var (
	ErrInvalidTokenType      = errors.New(core.ReasonInvalidTokenType)
	ErrInvalidOrExpiredToken = errors.New(core.ReasonInvalidOrExpiredToken)
	ErrNotAMember            = errors.New(core.ReasonNotAMember)
)

// InitialRoomsResolver supplies the authorized channel/DM room set of a
// freshly opened connection.
type InitialRoomsResolver interface {
	ChannelRooms(ctx context.Context, id core.Identity) ([]string, error)
}

// RoomAccess authorizes a channel subscription request.
type RoomAccess interface {
	CanJoin(ctx context.Context, id core.Identity, channelID string) (bool, error)
}

// ResumeProvider serves one sync:resume page from the persistent read
// model. The provider applies visibility filtering for the frozen identity;
// the gateway only shapes transport concerns.
//
// byteBudget is the wire budget the page MUST fit into (a 500-message page
// of 32000-CJK-char bodies is ~3x the 1 MiB queue bound; an oversized page
// would overflow the bounded queue, force a slow-consumer disconnect and
// re-connect-loop). Providers SHOULD page by budget themselves; the
// gateway additionally trims any page that still exceeds it, keeping
// currentSeq/hasMore truthful for the trimmed prefix.
type ResumeProvider interface {
	SyncVisible(ctx context.Context, id core.Identity, lastSeq int64, maxMessages int, byteBudget int64) (ResumePage, error)
}

// ResumePage mirrors the original sync:resume:response envelope
// {messages, currentSeq, hasMore} (limit 500). Messages are pre-serialized
// canonical messages; the gateway never rewrites them.
type ResumePage struct {
	Messages []json.RawMessage
	// Seqs aligns 1:1 with Messages (each canonical message's create seq).
	// The gateway needs it to keep currentSeq truthful when it trims a page
	// to the byte budget; a page without Seqs is delivered verbatim and
	// must already fit the budget.
	Seqs       []int64
	CurrentSeq int64
	HasMore    bool
}

// HeartbeatSource supplies the workspace message high-water. It is a
// committed-seq hint for the client's gap detection, NOT a delivery cursor
// and NOT an ack.
type HeartbeatSource interface {
	WorkspaceSeq(ctx context.Context, workspaceID string) (int64, error)
}
