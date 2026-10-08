# M3 runner access (daemon startup credential)

Owner of this slice: `internal/agent/runner_access.go`, `internal/agent/runner_access_test.go`, `internal/transport/legacyweb/runner_*.go`, this file. No schema change, no `routes.go` / app / client / `go.mod` edit. Parent wires the two calls below.

This is the M3 launch-identity dependency the original daemon requires before it can start a managed runner. It is not the M5 delivery queue and not an empty-success placeholder.

## Sources read

- `packages/server/src/routes/internalComputer.ts` list (`GET /runners`), stop (`POST /runners/:agentId/stop`), mint (`POST /runners/:agentId/credentials`), revoke (`DELETE /runners/:agentId/credentials/:credentialId`), provider-connection (`POST /runners/:agentId/provider-connection`)
- `packages/server/src/services/agentCredentialService.ts` `ALLOWED_AGENT_CAPABILITIES`, `normalizeAgentCapabilities`, `mintAgentCredential`, `revokeAgentCredential`, `generateAgentApiKeyMaterial`
- `packages/server/src/routes/internalComputer.runners.test.ts`
- `packages/server/src/middleware/auth.ts` `requireComputerAuth` and `packages/server/src/middleware/routeAuthPolicy.ts` registry rows
- `packages/daemon/src/core.ts` `requestRunnerCredentialOnce` / `mintRunnerCredential`
- `packages/daemon/src/agentProcessManager.ts` `requestManagedRunnerCredentialOnce`, `revokeManagedRunnerCredential`, `buildSpawnConfig` → `materializeProviderConnectionForSpawn`
- `packages/daemon/src/providerConnectionLaunch.ts`
- Go: `internal/agent/credentials.go` (`CredentialHasher`), `0008` `agent_credentials`, `internal/agent/service.go` `Stop`, `internal/transport/legacyweb/computer_internal.go` dispatcher

The ordinary `agent:start` frame stays credential-free (existing `AgentStartConfig`). The daemon asks this surface for `sk_agent_*` with its computer/machine bearer after it receives start.

## Parent wiring

```go
access, err := agent.NewRunnerAccess(handle, agent.RunnerAccessOptions{
    Clock:  clock,
    Hasher: hasher, // the same *agent.CredentialHasher passed to agent.NewStore
})
runners := &legacyweb.RunnerHandlers{
    Access:    access,
    Computers: computerHandlers,          // requireComputerAuth
    Lifecycle: agentService,              // *agent.Service satisfies agent.RunnerLifecycle
}
computerHandlers.InternalRoutes = append(computerHandlers.InternalRoutes, legacyweb.RunnerRouteManifest()...)
legacyweb.RegisterComputerRoutes(mux, computerHandlers, gate)
legacyweb.RegisterRunnerRoutes(mux, runners)
```

`RegisterRunnerRoutes` mounts method-specific patterns that are more specific than `ComputerHandlers`' `/internal/computer/` subtree. The subtree dispatcher still answers every non-`/preflight` registry row with 401 `auth_policy_unregistered_path`. Both calls are required: the manifest makes preflight truthful; the mux patterns are what actually serve the daemon.

`RunnerRouteManifest` paths (registry form, principal `sk_computer`):

| Method | Path |
| --- | --- |
| GET | `/runners` |
| POST | `/runners/:agentId/stop` |
| POST | `/runners/:agentId/credentials` |
| DELETE | `/runners/:agentId/credentials/:credentialId` |
| POST | `/runners/:agentId/provider-connection` |

Go patterns use `{agentId}` / `{credentialId}`. Auth is `requireComputerAuth`: `sk_computer_*` canonical, `sk_machine_*` phase-1 alias, `sk_agent_*` and user JWT are 401 `invalid_principal`. No user session wrapper.

## Signatures

```go
type RunnerBinding struct {
    ComputerID, MachineID, WorkspaceID string
    LegacyMachine bool // sk_machine_* alias; no computers row
}

func NewRunnerAccess(db *sql.DB, opts RunnerAccessOptions) (*RunnerAccess, error)
func NormalizeRunnerScopes(scopes []string) ([]string, error) // nil = all capabilities
func ValidateRunnerName(name *string) error

func (*RunnerAccess) Mint(ctx, binding RunnerBinding, agentID string, scopes []string, name *string) (*MintedRunnerCredential, error)
func (*RunnerAccess) Revoke(ctx, binding RunnerBinding, agentID, credentialID string) error
func (*RunnerAccess) List(ctx, binding RunnerBinding, scope string) ([]RunnerSummary, error)
func (*RunnerAccess) ConfirmRunner(ctx, binding RunnerBinding, agentID string) (*Agent, error)
func (*RunnerAccess) Authorize(ctx, binding RunnerBinding, needMachine bool) error

type RunnerLifecycle interface {
    Stop(ctx context.Context, a *Agent) error // *agent.Service
}
```

`MintedRunnerCredential` fields: `CredentialID`, `APIKey` (raw, once), `Scopes`, `AgentID`, `AgentName`, `WorkspaceID` (wire name `serverId`).

`RunnerSummary` JSON: `agentId`, `name`, `status`, `model`, `runtime` only (`RunnerListFields`).

## Behavior

Computer identity is the live row, not the machine id captured at the start of argon2.

1. Validate scopes and name.
2. Read the current computer (or legacy machine) and require the agent to be non-deleted, in that workspace, and on that computer's current `machine_id`.
3. Hash `sk_agent_*` with `CredentialHasher` **outside** any write transaction.
4. Open a short `BEGIN IMMEDIATE` transaction, re-read the computer/machine/workspace and the agent, then insert. If the computer was revoked, the legacy key was migrated, the workspace was deleted, or the agent was reassigned to another machine or space, the transaction rolls back and no row is committed.

Revoke uses the same re-read inside the write transaction before `revoked_at` is set. A reassignment rolls the revoke back. Reason is `managed_runner_launch_ended` (`RunnerRevokeReason`). `created_by_user_id` and `revoked_by_user_id` stay NULL. Already-revoked rows return success and keep the original reason. Rows are not deleted. Existing credentials are not revoked by a later mint.

There is no expiry. `agent_credentials` has no `expires_at`. A credential stays usable until revoke (the main Store's `FindCredentialByAPIKey` is unchanged and applies no TTL).

Key format, same as `CredentialHasher.newAPIKeyMaterial`: `sk_agent_` + 64 lowercase hex characters (32 random bytes). Persisted: argon2id PHC in `api_key_hash`, first 16 characters in `api_key_prefix`. The raw key is not stored.

Scopes: omitted or JSON null-absent → the full v0 set. `null` or a non-array → 400 `scopes_invalid` / `scopes must be an array of capability literals`. A value outside the enum → 400 `scopes_invalid` / `scopes must each be one of: send, read, mentions, tasks, reactions, server, channels, knowledge, mcp`. `[]` → 400 `scopes_empty`. Accepted values are deduped and sorted before storage and in the 201 body. Name omitted or JSON null is NULL; otherwise a string of 1..200 code points or 400 `name_invalid`.

List: `scope` absent, empty, or `machine` is the computer's current machine. `scope=server` is every non-deleted agent in that workspace, including other machines. Anything else is 400 `invalid_scope`. Deleted agents are omitted. The SELECT is the whitelist; `session_id` and `env_vars` are not loaded.

Stop: `ConfirmRunner` applies the same binding rule (404 `agent_missing`, no existence leak across machine or space). Then `Lifecycle.Stop` (`*agent.Service`), which sends `agent:stop` and persists `stopped` even when the gateway send fails. Nil lifecycle after a confirmed agent is 503 `orchestrator_unavailable`. This route does not implement a second stop path. External runtimes therefore receive the service's 400 `External agents do not use Raft-managed runtime lifecycle` and are left unchanged.

### HTTP

| Route | Success | Errors |
| --- | --- | --- |
| GET `/internal/computer/runners` | 200 `{whitelist, runners}` | 400 `invalid_scope`; 401 computer auth; 500 `Computer authentication state missing` / `computer_binding_missing` / `machine_binding_missing` |
| POST `.../runners/{agentId}/stop` | 200 `{ok:true, agentId}` | 404 `agent_missing`; 503 `orchestrator_unavailable`; service errors passed through |
| POST `.../runners/{agentId}/credentials` | 201 `{credentialId, apiKey, scopes, agentId, agentName, serverId}` | 400 scope/name codes above; 404 `agent_missing`; 401 if the computer/legacy key was revoked or migrated during hashing |
| DELETE `.../credentials/{credentialId}` | 204 empty, including already revoked | 404 `agent_missing` or `credential_missing` |
| POST `.../provider-connection` | none in this slice | see C0 below |

Auth failures match `requireComputerAuth`: missing bearer `Missing computer credential`; wrong principal `invalid_principal`; bad or revoked `sk_computer_*` `Invalid computer credential`; migrated `sk_machine_*` `legacy_machine_key_migrated`. Unregistered siblings such as agent-o11y stay 401 `auth_policy_unregistered_path`.

Daemon mint body (both core and agentProcessManager): `scopes` the nine capabilities, `name` `runner:{runtime}:{agentId[:8]}`, bearer computer/machine key, `Content-Type: application/json`. It accepts the response when `apiKey` is a string starting with `sk_agent_`. Revoke is `DELETE` with the same bearer and treats any completed response as the launch-cleanup attempt.

500 fallbacks when the error is not a domain code: `Failed to list runners`, `Failed to stop runner`, `Failed to mint runner credential`, `Failed to revoke runner credential`. Nil `Access` or missing computer store is 503 `runner_access_unavailable` / `computer_auth_unavailable`, not a fake 200.

## C0 provider-connection

`materializeProviderConnectionForSpawn` calls this route only when the runtime config is `builtin` and `provider.kind == "connection"`. Ordinary claude/codex/… launches do not. On the TS server a missing feature flag is disabled and the route returns:

```json
404 {"error":"Provider connections are not enabled for this server","code":"provider_connections_disabled"}
```

This Go server has no provider-connection flag table and no ciphertext store (no schema added here). The route authenticates, re-checks the live computer binding, and returns that refusal. It does not read the body into the response and does not invent `envVars` or an API key. Enabling materialization needs a later store; it is not faked.

## Tests

`go test ./internal/agent/ -run 'Runner' -count=1` and `go test ./internal/transport/legacyweb/ -run 'Runner' -count=1`.

SQL: real 0008 table, real argon2id, lookup through `Store.FindCredentialByAPIKey`, cross-machine, cross-space, deleted agent, revoke idempotency, and rollback when the write transaction observes reassignment, computer revocation, legacy-key migration, or a commit failure.

HTTP: computer bearer, `sk_agent_*` / JWT rejection, unregistered sibling, list whitelist (seeded `session_id` / `env_vars` absent), `scope=server`, mint format and codes, cross-machine/cross-space, revoke, legacy alias, revoked computer, stop via `*agent.Service` (`agent:stop` + `stopped`), nil lifecycle 503, external-runtime service 400, preflight manifest, provider refusal without the submitted secret.
