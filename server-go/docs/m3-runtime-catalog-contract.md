# M3 runtime catalog contract

Status: implemented in the owned files below. Parent wires routes and the machine-message callback. This worker does not edit `routes.go`, the hub, migrations, `go.mod`, or client code.

Ownership:

- `internal/runtimecatalog/**`
- `internal/transport/legacyweb/runtime_catalog_handlers.go`
- `internal/transport/legacyweb/runtime_catalog_http_test.go`
- this document

The original Web Agent create flow fails closed when `GET /api/servers/:id/machines/:machineId/runtime-options` is absent. That route is mounted here.

## Parent wiring

`machinews.Hub` already satisfies `runtimecatalog.Gateway` (`IsOnline`, `Send`). Do not pass `Hub.Disconnect` to the broker: that method drops the socket. Call `Broker.Disconnect` from the hub disconnect callback so in-flight detects fail instead of succeeding.

`Generation` must read `Hub.Snapshot` and must not call back into the broker. `Broker.settle` holds the broker lock while it re-reads the generation.

```go
broker := runtimecatalog.NewBroker(runtimecatalog.BrokerConfig{
    Gateway: hub, // *machinews.Hub
    Generation: func(machineID string) (uint64, bool) {
        snap := hub.Snapshot(machineID)
        if snap == nil {
            return 0, false
        }
        return snap.Generation, true
    },
})

handlers := &legacyweb.RuntimeCatalogHandlers{
    Store:  runtimecatalog.NewStore(sqlDB),
    Broker: broker,
    // Policy nil => runtimecatalog.C0Policy() (grok and omp disabled).
}

legacyweb.RegisterRuntimeCatalogRoutes(mux, handlers, gate)

// Hub config. OnMessage returns only error; the broker reports whether it
// owned the frame so the agent callback still sees every other message.
OnMessage: func(ctx context.Context, principal computer.Principal, raw json.RawMessage) error {
    handled, err := broker.OnMachineMessage(ctx, principal, raw)
    if handled {
        return err
    }
    if agentOnMessage != nil {
        return agentOnMessage(ctx, principal, raw)
    }
    return nil
},
OnDisconnect: func(ctx context.Context, principal computer.Principal) error {
    broker.Disconnect(principal.MachineID)
    if agentOnDisconnect != nil {
        return agentOnDisconnect(ctx, principal)
    }
    return nil
},
```

## Exported signatures

```go
func C0Policy() Policy
type Policy struct { GrokRuntimeEnabled, OmpRuntimeEnabled bool }

func NewStore(db *sql.DB) *Store
func (*Store) MemberRole(ctx context.Context, workspaceID, userID string) (role string, err error)
func (*Store) Machine(ctx context.Context, id string) (*Machine, error)
func (*Store) Agent(ctx context.Context, id string) (*Agent, error)

func ProjectNewAgentRuntimeOptions(installedRuntimeIDs []string, policy Policy) []SelectionOption
func ProjectExistingAgentRuntimeOptions(installedRuntimeIDs []string, currentRuntime string, policy Policy) []SelectionOption
func ProjectSetupRuntimeOptions(installedRuntimeIDs []string, policy Policy) []SelectionOption

type Gateway interface {
    IsOnline(machineID string) bool
    Send(ctx context.Context, machineID string, payload any) error
}
type GenerationFunc func(machineID string) (generation uint64, ok bool)

func NewBroker(BrokerConfig) *Broker
func (*Broker) Online(machineID string) bool
func (*Broker) Rescan(ctx context.Context, machineID string) error
func (*Broker) DetectModels(ctx context.Context, target Target, runtime string) (Outcome, error)
func (*Broker) Disconnect(machineID string)
func (*Broker) OnMachineMessage(ctx context.Context, principal computer.Principal, raw json.RawMessage) (handled bool, err error)

func RegisterRuntimeCatalogRoutes(mux *http.ServeMux, handlers *RuntimeCatalogHandlers, gate *AuthGate)
```

`RuntimeCatalogHandlers.Policy`, when non-nil, replaces C0 for that request. This package does not read a feature-flag table. A missing flag stays disabled.

`OnMachineMessage` returns `handled=false` for every frame whose `type` is not `machine:runtime_models:result`, including oversized non-results. A result with the expected request id but a different `principal.MachineID` or `principal.WorkspaceID` returns `(true, ErrForgedReply)` and leaves the wait open. An unknown request id returns `(true, nil)` so it is not a successful job and is not forwarded. A generation mismatch returns `(true, ErrStale)` and completes the wait with `ErrStale` without using the payload.

## HTTP surface

All six routes sit behind `AuthGate.RequireVerifiedProfileComplete`. A nil gate answers 401. Header and membership checks run inside the handlers.

| Method | Path | Success |
| --- | --- | --- |
| GET | `/api/servers/{id}/machines/{machineId}/runtime-options` | `{context:"new_agent", machineId, options}` |
| GET | `/api/agents/{id}/runtime-options` | `{context:"existing_agent", machineId, options}` |
| GET | `/api/servers/{id}/machines/{machineId}/runtime-form-definitions/{runtimeId}?schemaVersion=` | builtin `builtin-pi.create.v2` or kimi-sdk `kimi-sdk.create.v1` |
| GET | `.../runtime-form-definitions/{runtimeId}/option-sources/{sourceId}?schemaVersion=` | filtered builtin source, or live kimi `model` source |
| GET | `/api/servers/{id}/machines/{machineId}/runtime-models/{runtime}` | daemon outcome; offline is HTTP 200 `{kind:"error", retryable:true}` |
| POST | `/api/servers/{id}/machines/{machineId}/runtimes/rescan` | `{requested:true}` after `{"type":"machine:runtimes:rescan"}` is sent |

Machine routes require `X-Server-Id` equal to the URL server id (400 `Missing X-Server-Id header` or `X-Server-Id must match server id in URL`). Non-members get 403 `Not a member of this server`. Guests get 403 `Guests cannot access server management data` before any creator bypass. Then the caller must be `machines.user_id` or have `editMachines` (owner/admin). A machine in another workspace is 404. Runtime-models uses `Machine not found in this server`; the other machine routes use `Computer not found`.

Agent options take the scope from `X-Server-Id` only. Guests get 403 `Guests cannot access the server Agent directory` before `viewAgents`. A deleted agent, or an agent whose workspace is not the header scope, is 404 `Agent not found`. If the agent's machine belongs to another workspace, `machineId` is JSON null and installed runtimes are empty.

`admissionReason` is always present on each option, including JSON null. `formDefinitionRef` is omitted unless the runtime is `builtin` or `kimi-sdk` and it is available for new use or is the current runtime.

## Admission and persisted runtimes

Installed ids come only from `machines.runtimes`. NULL means not reported: CLI runtimes are `not_installed`, in-process runtimes (`builtin`, `kimi-sdk`, `cursor-sdk`) are `update_required`. Invalid JSON is 500, not an empty successful list.

C0 (`C0Policy`) matches a missing `grok_runtime_v0` / `omp_runtime_v0` flag: both are off. New-agent and setup omit them. An existing agent whose current runtime is flag-off grok or omp keeps that row as `grandfathered_current` / `feature_flag_off`. A current deprecated runtime (`kimi`, `antigravity`, and gemini when it is current) uses `admissionReason:"deprecated"`. New-agent lists creatable runtimes only (`supported && !deprecated`). Setup is that list without `builtin`. Existing lists non-deprecated runtimes plus the current id. There is no setup HTTP route; `ProjectSetupRuntimeOptions` is for the parent if it projects setup facts.

## Metadata RPC

Detect sends `{"type":"machine:runtime_models:detect","requestId","runtime"}`. Request ids are local UUID v4 values. The wait binds machine id, workspace id, request id, and the generation captured at send. Reply projection follows the daemon result: a typed `outcome` wins; `error:"unsupported"` with no typed outcome falls back to the static claude, copilot, or gemini catalog only. Other runtimes stay `unsupported`. Timeouts are 25s for `cursor-sdk` and 5s otherwise.

Caps: 32 pending replies, 4 per machine, 1 MiB result frame, 2048 models. Over-cap or malformed live lists become `{kind:"error", retryable:true}`, not a truncated success. Offline, timeout, stale generation, disconnect, and busy all become that same HTTP 200 error for `runtime-models`. They never invent models or readiness. Builtin option-source offline is 409 `builtin_catalog_unavailable` / `retry` with no version fields and no options. A live builtin reply without catalog capability is 409 `builtin_catalog_capability_required` / `upgrade_required` and includes the stored daemon and computer versions. Builtin options are the embedded Pi registry intersected with the machine's supported model ids; gateway providers `openai-compatible` and `anthropic-compatible` stay when custom values are allowed. Unknown machine model ids are dropped. Kimi option-source values are the live reply only. Rescan does not wait.

## Omitted

No cursor login, account-usage, agent create/update, feature-flag table, setup HTTP route, or live LLM/browser/cloud call. No migration. Form definitions cover builtin and kimi-sdk only. Parent still has to register the routes and the two callbacks above.
