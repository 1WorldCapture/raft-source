# M3B agent contract (main AGENT slice)

Parent wires the constructors below. This worker does not edit `routes.go`, `go.mod`, clients, or `var/`. Runner mint/revoke/list/stop (`internal/agent/runner_access.go`, `legacyweb/runner_*.go`) and runtime-options/catalog routes belong to other workers and are not registered here.

## Constructors and registration

```go
func NewCredentialHasher(pepper []byte) (*CredentialHasher, error)

func NewStore(handle *sql.DB, opts StoreOptions) *Store
type StoreOptions struct {
    Clock                   clock.Clock
    Hasher                  *CredentialHasher
    OnboardingOpenerV2      bool
    SelfHostedRunnerEnabled bool
}

func NewService(store *Store, opts ServiceOptions) *Service
type ServiceOptions struct {
    Gateway           Gateway // fixed at assembly; MACHINEWS hub satisfies it
    ServerURL         string
    DeviceAuthEnabled bool
    Logger            *slog.Logger
}

func NewBootstrapExchanger(store *Store) *BootstrapExchanger
// *BootstrapExchanger implements computer.AgentBootstrapExchanger:
// ExchangeAgentBootstrapToken(ctx, rawToken, computer.TokenUseObservation) (computer.AgentBootstrapExchange, error)
// Failures are *computer.BootstrapError. Assign to ComputerHandlers.AgentBootstrap.

func IdentityInternalRoutes() []computer.InternalRouteEntry
// GET /internal/agent-api
// GET /internal/agent-api/
// GET /internal/agent-api/server
// GET /internal/agent-api/channel-members
// each principal "sk_agent"

func RegisterAgentRoutes(mux *http.ServeMux, handlers *AgentHandlers, gate *AuthGate)
type AgentHandlers struct {
    Store          *agent.Store
    Service        *agent.Service
    Computers      *ComputerHandlers          // unused by this slice; runner worker may read it
    RuntimeCatalog *runtimecatalog.Broker     // nil skips live detect; parent should set this
    AvatarDir      string                     // private PNG directory; parent should set this
}
```

`gate` must be non-nil. Credential and `GET /api/agents/manageable` use `RequireVerified` and do **not** require `X-Server-Id`. Other `/api/agents` routes use verified auth, then `X-Server-Id` membership, then the guest read gate.

## Machine callbacks

Assign these on the hub config before serving. They match `machinews.OnReadyCallback`, `OnMessageCallback`, and `OnDisconnectCallback`.

```go
func (*Service) OnReady(ctx context.Context, p computer.Principal, raw json.RawMessage) error
func (*Service) OnMessage(ctx context.Context, p computer.Principal, raw json.RawMessage) error
func (*Service) OnDisconnect(ctx context.Context, p computer.Principal) error
```

Each mutating path re-reads, inside one short write transaction, `computer.ValidatePrincipalTx`. That checks the verifier revision `Authenticate` stored on `Principal.CredentialRevision` (`json:"-"`), revocation, migration, workspace, and the current machine link. An empty revision fails closed. `AuthError` commits nothing and sends nothing. Any other error is returned.

Agent-scoped frames also require `agents.machine_id` to be that machine and `deleted_at IS NULL`. Argon and `Gateway.Send` run outside the transaction.

`OnReady` marks bound non-stopped agents listed in `runningAgents` active, and sends a real `agent:stop` when a stopped agent is still reported running. Agents absent from the list keep their status. Pending `agent:purge` rows are then sent. `OnMessage` applies only `agent:status` (including `sleeping` → active), `agent:session`, `agent:session:invalidate`, and `agent:purge:result`. Other frames, including activity and any briefing or message type, are ignored. `OnDisconnect` rechecks the principal and does not change agent status (the TS disconnect projection skips the status write).

Launch fence (in memory on `*Service`, not a queue): when `machines.daemon_version` is semver `>= 0.30.1`, `Start` mints `launchId` and stores it before `Gateway.Send`. Send failure drops that id only. A later `agent:status`, `agent:session`, or `agent:session:invalidate` whose `launchId` is missing or different is ignored. No fence (older daemon) accepts those frames. An older daemon start does not clear an existing fence. Session and full reset clear it, then the restart arms a new one. `agent:start` carries `launchId` beside `config`.

`Gateway` is `IsOnline(machineID) bool` and `Send(ctx, machineID, payload any) error`. Lifecycle payloads are `agent:start` (with `config` and optional `launchId`), `agent:stop`, `agent:reset-workspace`, and `agent:purge`.

## Routes this slice registers

| Method and path | Auth | Success | Errors |
| --- | --- | --- | --- |
| GET `/api/agents/manageable` | user | 200 `{ok,data:{agents,reason,manageable_server_count}}` | 401 |
| POST `/api/agents/{id}/credentials` | user, no `X-Server-Id` | 201 `{credentialId,apiKey,scopes,agentId,agentName,serverId}` | 404 `device_login_disabled` / `agent_missing`; 403 `insufficient_role`; 400 `scopes_invalid` / `scopes_empty` / `name_invalid` |
| GET `/api/agents/{id}/credentials` | user | 200 `{agentId,credentials}` | same authority as mint; mint gate does not apply |
| DELETE `/api/agents/{id}/credentials/{credentialId}` | user | 204, including a repeat revoke | 404 `credential_missing` |
| POST `/api/agents/{id}/bootstrap-tokens` | user + `X-Server-Id` | 201 `{tokenId,bootstrapToken,tokenPrefix,ttlExpiresAt,scopes,agentId,agentName,serverId}` | 404 `self_hosted_runner_bootstrap_disabled`; 403 `insufficient_role`; 400 `ttl_invalid` / `ttl_too_long` |
| GET `/internal/agent-api` and `/internal/agent-api/` | Bearer `sk_agent_*` | 200 whoami (`agentId,agentName,agentDisplayName,serverId,serverRole,serverCapabilities,credentialId,scopes`). No capability check | 401 missing / `invalid_principal` / invalid / `Agent no longer exists` / `Server no longer exists` |
| GET `/internal/agent-api/server` | `sk_agent_*` scope `server` | 200 directory: runtime context, role, capabilities, channels `{id,name,joined,type,description}`, agents `{name,description,status,activity,activityDetail,role}` (no agent UUID; guest role is null), humans `{name,description,role}` | 403 `capability_not_authorized`; 501 `unsupported_capability` when `X-Slock-Agent-Active-Capabilities` omits `server` |
| GET `/internal/agent-api/channel-members?channel=` | `sk_agent_*` scope `channels` | 200 `{channel:{ref,type},agents,humans}` after server-side handle resolution (`#name`, `DM:@peer`) | 400 missing `channel`; 404 `Channel not found: {ref}` for private/joint without membership, another workspace, or an 8-hex thread suffix |
| GET/POST `/api/agents`, GET/PATCH/DELETE `/api/agents/{id}`, POST `.../start\|stop\|reset\|assign-machine` | user + `X-Server-Id` | existing handlers | guests may only GET list and detail |
| GET `/api/agents/{id}` | user + `X-Server-Id` | 200 includes soft-deleted profiles (`deletedAt`) for members and for guests who share a channel | 401 without auth; 404 foreign workspace (not 403) |
| POST `/api/agents/{id}/avatar` | user + `editAgents` or human creator | 200 agent DTO, PNG stored at `/api/avatars/servers/{sha256}.png` | 403 before the body is decoded; then the shared PNG errors (`PROFILE_AVATAR_TOO_LARGE`, `PROFILE_AVATAR_BAD_FORMAT`) |
| GET/POST `/api/agents/{id}/onboarding-identity-adoption` | same edit authority | GET adoption preview; POST calls `AdoptOnboardingIdentity` in one transaction when `canAdopt` | 400 when the agent is not `workspaces.onboarding_agent_id`; 409 `Agent name is already taken` leaves the role unchanged |
| other `/internal/agent-api/...` | see below | none | known M4/M5 family: 501 `not_implemented` after `sk_agent_*` auth; unknown path: 401 `auth_policy_unregistered_path` before auth |

A user JWT on these internal routes is 401. Scope miss is 403 `{error, code:"capability_not_authorized", requiredCapability}`. Hidden human directories (`hide_humans_from_members` and the agent is not `admin`) expose only community / community-cn owners and admins.

`POST /api/agent/login` stays on the computer worker. Point `ComputerHandlers.AgentBootstrap` at `NewBootstrapExchanger`. Append `IdentityInternalRoutes()` to `ComputerHandlers.InternalRoutes` so preflight lists the four GET rows. The handlers are mounted by `RegisterAgentRoutes` and do not go through the computer dispatcher. Parent should also set `AgentHandlers.RuntimeCatalog` and `AgentHandlers.AvatarDir`. This worker does not edit `app/m3.go`.

`app/m3.go` already calls `RegisterAgentRoutes`, `NewBootstrapExchanger`, and the three hub callbacks, and it claims the `/internal/agent-api/` prefix. It does not yet append `IdentityInternalRoutes()` or set `RuntimeCatalog` / `AvatarDir`, so preflight's `computerSurface` still omits the new rows and live catalog detect stays off until parent wires the broker. A valid builtin/kimi form ref is admitted when the broker is nil. A kimi reasoning effort with a nil broker is 409 `runtime_model_source_unavailable`.

Official Cindy creation writes the agent row, admin membership, `workspaces.onboarding_agent_id`, and the owner's `setup_status=complete` in one transaction, compared against the caller's pre-read owner setup status (`SERVER_SETUP_CHANGED_RETRY` when reset wins). Reset after that pointer or `complete` status stays the workspace store's refusal.

## Security rules implemented here

- `FindCredentialByAPIKey` verifies argon2id, then re-reads `revoked_at` before trusting the row.
- `MintCredential` hashes outside the write transaction, then re-reads the live agent, live workspace, and issuing member inside that transaction.
- `RevokeCredential` updates `WHERE revoked_at IS NULL`, so the first timestamp and reason stay.
- Credential list masking uses a bounded prefix and does not slice past a short value.
- No hash and no `Gateway.Send` run inside a write transaction.

## Form definition refs

`runtimecatalog.ValidateRuntimeFormDefinitionRef` is not exported. Create and update use the same pure rule against `BuiltinPiFormSchemaVersion` (`builtin-pi.create.v2`) and `KimiSDKFormSchemaVersion` (`kimi-sdk.create.v1`): protocol 1, registered runtime, matching schema, no extra keys. The normalized runtime (`runtimeConfig.runtime`, else the runtime field) must equal `runtimeId` or the response is 400 `form_runtime_mismatch`. A stale envelope is 409 `{error, issues:[{code,pointer}]}`. Builtin runtime config without a ref stays 409 `form_definition_ref_required`. External agents with a ref stay 400.

When `RuntimeCatalog` is set, builtin/kimi call `Broker.DetectModels`. Builtin failure is 409 `builtin_catalog_unavailable` with `recovery: "retry"`. Kimi timeout/offline with no reasoning effort is allowed. Kimi with an effort, or `unsupported`, is 409 `runtime_model_source_${kind}`. A live string model id absent from the list is 400 `invalid_option`. An object-shaped builtin model is not compared as a string.

## Not in this slice

- Runner endpoints under `/internal/computer/runners` (runner worker).
- Runtime option and catalog HTTP routes (runtimecatalog worker). This slice only calls the broker seam.
- Messages, history, unread, briefing, Socket.IO, mention delivery, reminders. Those families answer 501 `not_implemented` and do not return an empty success.
- Grok/omp feature-flag admission.
- Disconnect does not emit a live-activity offline event.
- Repeat credential revoke is 204, matching `revokeAgentCredential` returning true when `revokedAt` is already set. `docs/m3-acceptance-contract.md` currently says the repeat is 404 `credential_missing`.
- `m3-agent-identity.mjs` still expects deleted GET 404. This server returns 200 with `deletedAt`. Parent is correcting that expectation.
