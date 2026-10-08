# M4 implementation lock / live coordination

2026-10-08. Implementing against `bc65213b377a992c381e809c72ba50ca9af367fd` (M3 invitations/UI fixes committed). Scope is the four approved M4 design documents. This is a coordination record, NOT an acceptance result. The user explicitly reserves browser/UI testing for another person; no browser, UI build/test or `packages/web` modifications. Original JS protocol and pure reducer tests are backend compatibility evidence only.

## Final backend closeout — 2026-10-08

The integrator completed the current dirty checkout's M4 backend closeout and ran a full successful `make check` after the authority, private-audience, publication, queue and test-fixture fixes. Cross-build, dependency verification/tidy-diff and the pinned vulnerability scanner were also executed. The authoritative evidence and explicit remaining boundaries are in [phase-4-backend-handoff.md](phase-4-backend-handoff.md).

This does not sign off UI or deploy a running instance. P8 stays with the user's UI collaborator; P9/Stage promotion stays with the release owner. The local binary still reports Stage `m3`, revision `bc65213`, modified=true. Migrations now include the previously integrated `0013_activity_mute_epochs.sql`; no 0001–0009 history was rewritten. The ownership and seam notes below are retained as the implementation record, not a substitute for the final handoff.

## Ownership

- Parent/integrator: `internal/app/**`, `routes.go`, existing dispatch registration, `internal/auth/**`, `internal/platform/db/**`, `internal/realtime/**`, dependency integration, `Makefile`, `tests/acceptance/run.mjs`, final backend tests/reports. No commits/push/live restart.
- Channel worker: `internal/channel/**`, new `legacyweb/m4_conversation*.go`, channel/conversation tests and its report. No shared router edit.
- Message worker: `internal/message/**`, new `legacyweb/m4_message*.go`, message/reaction tests and report. No shared router edit.
- Readstate worker: `internal/readstate/**`, new `legacyweb/m4_readstate*.go`, state/Activity tests and report. No shared router edit.
- Socket worker: `internal/transport/socketio/**`, isolated spike/protocol runner and report. No primary go.mod until parent integration.

Migration numbers are assigned by parent: **0010_messaging_foundation.sql** for messages/mentions/reactions/DM/follows/publications; **0011_readstate_activity.sql** for readstate/Activity (now reviewed and installed from the worker draft, with extra composite/cascade FKs and integer overflow CHECKs); **0012_authority_epochs.sql** for transactional authority generations (see m4-authority-contract.md). Never edit 0001–0009. All tests use disposable data and ports, not var*, 4301/5175, existing screenshots or user sessions.

## Shared schema and transaction seams

Read actual `0010_messaging_foundation.sql` before coding. Message timestamps are Unix milliseconds, global message `seq` is SQLite AUTOINCREMENT PRIMARY KEY (safe JS integer CHECK); `id` remains stable UUID and UNIQUE. Message `thread_id` refers from the parent message to the thread channel; replies use that channel as channel_id, their own thread_id remains null. Human mentions are `message_mentions(message_id, user_id, workspace_id)` with identity derived from the directory. Reactions are `(message_id,user_id,emoji)` plus created_at; message revision changes only on actual mutation. DM uniqueness is `(workspace_id,user_low,user_high)` with a unique channel_id; self-DM uses one roster row. `thread_follows` stores explicit unfollowed_at and revision.

Parent supplies these shared helpers (do not implement competing ones):

```go
// internal/platform/db; Executor exposes ExecContext, QueryContext, QueryRowContext.
func WithWriteTx(ctx context.Context, handle *sql.DB, fn func(*sql.Tx) error) error
func WithReadSnapshot(ctx context.Context, handle *sql.DB, fn func(Executor) error) error
func WithAuthorityRead(handle *sql.DB, fn func() error) error
// WithWriteTx holds a per-database authorization fence through commit. Readers
// using WithAuthorityRead cannot authorize/enqueue across that commit boundary.
// WithReadSnapshot uses a pinned connection + BEGIN DEFERRED, not BEGIN IMMEDIATE;
// it does not take the authority fence, permitting WAL concurrent writers.

// internal/auth; claims MUST first originate from verified JWT, never request body.
func ValidateHumanTx(ctx context.Context, ex Queryer, claims AccessTokenClaims, now time.Time) error
// ValidateHumanTx checks expiry/type/nonempty family, actual family ownership and
// revocation, real verified/profile-complete user. Failure is auth.ErrTokenInvalid.

// internal/realtime; no transport dependency, persistent references only.
type Publication struct {
    ID int64
    WorkspaceID, ObjectType, ObjectID, EventType string
    Revision int64
    SubjectUserID, ScopeID string // optional owner/scope references, NEVER payload
}
func Enqueue(ctx context.Context, ex Executor, p Publication) error
// Enqueue participates in the caller's transaction, idempotent by object/event/
// revision+subject; applies a bounded pending budget. No network, no raw payload.
```

Parent has implemented `db.AuthorityGeneration(handle,kind,id)` and `db.RegisterAuthorityListener` for user/workspace/family scope generations. The durable epoch changes are captured in the write transaction and published to memory after commit BEFORE releasing the admission fence; eviction wakes run afterward. Socket integration requirements are recorded in m4-socket-integration-notes.md.

Every M4 mutation uses WithWriteTx and revalidates full `auth.AccessTokenClaims` inside it. Every authenticated read uses the same human/membership/channel policy, reads an actual consistent snapshot, and limits work. Do not call a nontransactional DB helper from inside a transaction. Avoid import cycles (channel does not import message/readstate/transport; readstate may read agreed message facts directly).

## Channel worker's cross-module API (freeze first)

```go
type Conversation struct {
    Channel *Channel
    Root *Channel
    ParentMessageID string
    Role string
    IsMember bool
}
func (s *Store) AuthorizeConversationTx(ctx context.Context, ex Executor,
    workspaceID, channelID, userID string, posting bool) (*Conversation, error)
func (s *Store) SelectSyncAudienceTx(ctx context.Context, ex Executor,
    workspaceID, channelID, userID string) (bool, error)
func (s *Store) ListSubscriptionsTx(ctx context.Context, ex Executor,
    workspaceID, userID string) ([]string, error)
func (s *Store) EnsureDMTx(ctx context.Context, tx *sql.Tx,
    workspaceID, userID, otherUserID string) (*Channel, error)
func (s *Store) EnsureThreadTx(ctx context.Context, tx *sql.Tx,
    workspaceID, channelID, parentMessageID, userID string) (*Channel, error)
func (s *Store) SetThreadFollowTx(ctx context.Context, tx *sql.Tx,
    workspaceID, threadID, userID string, follow, automatic bool) error
```

Base authorization always requires current workspace membership; public means readable to that workspace, not to strangers. DM only participants (including self); thread inherits its valid root; reject nested/cyclic/cross-space/missing parents. History/context/explicit join do not require follow; sync/resume add active follow. Public-thread live can include explicit viewers; private/DM-thread live is active followers only. Do not auto-follow on read. Posting requires real channel membership except thread inheritance per reference, nonarchived root and channel, and system-channel restrictions.

Message worker exports `NewStore(handle *sql.DB, channels *channel.Store) *Store`, `Create(ctx context.Context, claims auth.AccessTokenClaims, workspaceID string, input CreateInput) (*Message,error)` and `CreateTx(ctx context.Context, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID string, input CreateInput) (*Message,error)`. `CreateInput` contains `ChannelID, Content string`, `RandomID *string`, `Mentions []Mention` (`Mention{Type,ID,Name string}`). Additional fields may be added for presence-aware unsupported input handling. The conversation HTTP worker may import message and call CreateTx after EnsureThreadTx for optional initial content in ONE db.WithWriteTx. It must not call Create (nested transaction). Channel worker owns thread follow mutations and author auto-follow on ensure; message worker calls SetThreadFollowTx for reply sender/human mentions as required by TS fixture. Do not insert channel_humans from message/readstate.

## HTTP integration

Expose a `Register(mux, gate)`/handler registration helper for new endpoints, but do not edit app/routes.go or existing ChannelHandlers dispatcher. Parent integrates. Use existing gate/scope mechanisms. Parent adds `accessClaims(r)` in legacyweb (verified JWT saved in context) for full in-transaction identity. Existing `userID`, `scopeRole`, channel/workspace scopes stay compatible. For cross-module domain APIs choose small explicit signatures and document them early in worker report; do not require parent to guess constructor fields. Readstate's follow/unfollow is owned by channel worker; Done/undone/read/read-all/mute/Activity are readstate-owned.

Wire source: exact committed TS/Web + approved contracts. No fabricated success/empty counts for required functionality. v2 write envelope vs v1 bare DTO, MessagePage vs sync array vs resume envelope remain distinct. Shared projections never contain private reaction viewer/read/mute data. Structured agent mention/agent DM/task/attachment effects explicitly reject before commit; human mention/self-DM are included. All optional future surfaces remain explicit authorized 501.

## Verification

Each worker adds behavior/negative/concurrency/rollback tests and records actual commands, failures and sandbox limitations. Parent performs all real-listener and integrated tests; do not skip failures to claim green. Socket spike must use the installed original JS client, not a custom raw-WS stand-in. Fixtures must be generated by actual reference functions/normalizers/reducers where feasible. Backend completion is separate from pending UI sign-off.
