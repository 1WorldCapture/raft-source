# M3 computer machine management (stable callbacks and errors)

Status: stable for parent wiring. This file supersedes the “PATCH/DELETE are not implemented” gap note in `m3-computer-contract.md`. It does not claim legacy-daemon adoption (`POST /api/computer/adopt-legacy` is still unimplemented).

Owned surface:

- `internal/computer/machine.go` (`RegisterMachine`, `RotateMachineKey`)
- `internal/computer/machine_management.go` (`UpdateMachine`, `DeleteMachine`)
- `legacyweb/computer_machines.go`, `computer_handlers.go`
- tests in `machine_management_test.go` and `computer_management_http_test.go`

## Parent wiring

```go
computerHandlers.Scope = servers.RequireServerScope
computerHandlers.DisconnectMachine = hub.Disconnect // nil is safe
legacyweb.RegisterComputerRoutes(mux, computerHandlers, gate)
```

`DisconnectMachine func(machineID string)` is optional. `RegisterComputerRoutes` does not require it. The handler calls it with the machine id only, and only after a rotate or delete transaction has committed. It is not called for register, patch, 403, 404, 409, or 500. It never receives key material. Do not log the raw `sk_machine_*` / `sk_computer_*` values; rotation’s response body is the only place the new machine key appears.

Every `/api/servers/...` machine route registered here uses `gate.RequireVerifiedProfileComplete` and then `Scope` when `Scope` is non-nil. A nil `Scope` remains legal for isolated tests: the handler resolves membership itself and still fails closed. Do not mount these routes with only `gate.Require`.

Public routes are unchanged and stay on their existing gates:

- `POST /api/auth/device/authorize` public
- `POST /api/auth/device/approve` `gate.Require`
- `POST /api/auth/device/token` public
- `POST /api/computer/attach` and `GET /api/computer/legacy-machines` `gate.Require`
- `POST /api/agent/login` public

`computer.ValidatePrincipalTx(ctx, tx, principal)` is the parent’s live credential fence for runner and machine-frame owners. `Principal.CredentialRevision` comes from `Authenticate`. This management slice does not call it. Rotating a legacy machine key changes the stored verifier, so the previous revision fails `ValidatePrincipalTx` even if socket close is delayed. Deleting the machine revokes linked computers (`revoked_reason = machine_deleted`) before the machine row disappears.

The parent owns `GET /api/servers/{id}/machines` and the collection method fallback. This slice does not register a method-free handler on the collection. It does register method-free 405 fallbacks for the single machine and for rotate-key, after the same auth and scope gates (so anonymous callers get 401, not 405).

## Routes

| Method and path | Success | Errors |
| --- | --- | --- |
| `POST /api/servers/{id}/machines` | 200 `{machine, apiKey}` | 400 `Name is required`; 403 registerMachines sentence; 403 guest sentence; 404 `Server not found` when membership disappears during the post-hash transaction |
| `PATCH /api/servers/{id}/machines/{machineId}` | 200 machine row, no verifier fields | 400 name/description sentences below; 403 editMachines sentence; 404 `Machine not found in this server` |
| `DELETE /api/servers/{id}/machines/{machineId}` | 200 `{ok:true}` | 403 removeMachines sentence; 404 machine sentence; 409 `{error, code:"MACHINE_HAS_ASSIGNED_AGENTS"}`; 500 `{error:"Failed to delete machine", code:"machine_delete_failed"}` |
| `POST .../rotate-key` | 200 `{apiKey}` | 403 rotate sentence; 404 machine sentence |
| other methods on `.../machines/{machineId}` | | 405 `Allow: PATCH, DELETE` |
| other methods on `.../rotate-key` | | 405 `Allow: POST` |

Scope middleware (when wired) still answers first: missing `X-Server-Id` 400, mismatch 400, non-member 403 `Not a member of this server`. Unverified email is 403 `Email verification required`. Incomplete profile is 403 `PROFILE_SETUP_REQUIRED`. Guests who are members get 403 `Guests cannot access server management data` for every method on these paths, including the 405 fallback, and including a guest who created the machine. That guest wall is the HTTP equivalent of the TS `/:id/machines` prefix middleware; it runs before creator/capability checks.

Capability sentences (byte-identical to `routes/servers.ts`):

- `The `registerMachines` capability is required to register machines`
- `The `editMachines` capability or machine creator authority is required to edit machines`
- `The `removeMachines` capability or machine creator authority is required to remove machines`
- `The `rotateMachineKeys` capability or machine creator authority is required to rotate machine keys`

Owner and admin hold those four capabilities. A member who created the machine may edit, delete, and rotate without the capability. A guest may not, even if they created the machine and even if that demotion commits while argon2 is still running: the write transaction re-reads the live role and refuses `guest` before the creator exception. A member who did not create the machine receives the capability sentence.

PATCH body, checked only after the machine is found and the caller is allowed:

- `name` absent: leave the name. Present `null`, non-string, empty, or whitespace-only: 400 `Name is required`. Otherwise store `String.prototype.trim`.
- `description` absent: leave it. Present `null`: store NULL. Present non-string: 400 `Description must be a string`. String: trim; empty becomes NULL; JavaScript UTF-16 length `> 500` is 400 `Description must be 500 characters or less` (an emoji above U+FFFF counts as two).
- Neither field present: 400 `Name or description is required`.
- A forbidden caller is 403 even when the body would also be 400.

The PATCH JSON is the machines row in camelCase (`id`, `serverId`, `userId`, `name`, `description`, `apiKeyPrefix`, `runtimes`, `hostname`, `os`, `daemonVersion`, `computerVersion`, `computerVersionReportedAt`, `lastHeartbeat`, `lastStatus`, `statusChangedAt`, `createdAt`, `legacyKeyMigratedAt`). `api_key_hash` and `api_key_fingerprint` are omitted. Timestamps are UTC millisecond ISO-8601. This is not the list read model (`isComputer`, `agentCount`, … stay on register’s `machine` object only).

## Store rules

`RegisterMachine` and `RotateMachineKey` still derive argon2 material before the transaction. The write transaction then re-reads live membership and the machine binding. `RotateMachineKey`’s `actorRole` argument is ignored so a stale `"admin"` string cannot authorize a member who was demoted during hashing.

- no live membership, deleted workspace, or `joint_storage`: `ErrNotAuthorized` (HTTP 404 `Server not found` if the request already passed scope and then lost membership; scope itself still returns 403 for a non-member)
- machine id not in that workspace: `ErrMachineNotFound` (404 `Machine not found in this server`). Membership is checked first so a non-member does not learn the id.
- member without capability and not the creator: `ErrForbidden`

`DeleteMachine` returns `*MachineDeleteConflictError` with code `MACHINE_HAS_ASSIGNED_AGENTS` and message `Cannot delete computer while it has agents assigned. Remove or migrate all agents first.` when any `agents` row with `deleted_at IS NULL` is bound to the machine. It does not set those `machine_id` values to NULL to force the delete. A soft-deleted agent does not block. In the same transaction, non-revoked `computers` for that machine are updated (`revoked_at`, `revoked_reason='machine_deleted'`) and only then is the machine deleted, so `ON DELETE SET NULL` cannot drop the link first. A later statement failure rolls the revoke back. Already-revoked computers keep their original reason.

## Deferred (do not invent)

M3 has no `agent_migrations` or `agent_runtime_profiles` tables. This slice does not create them, does not emit `MACHINE_HAS_ACTIVE_MIGRATION` or `MACHINE_HAS_ACTIVE_RUNTIME_PROFILE`, and does not clear fictitious profile rows. Those TS delete branches stay deferred until a real migration owns the tables.

`POST /api/computer/adopt-legacy` is not implemented. Nothing here marks `legacy_key_migrated_at` or claims device legacy adoption.

Plan machine quotas stay unlimited (`maxMachines=-1`). No correlation id is invented on the delete 500; the body is `error` + `code` only. TS also emits Socket.IO `machine:updated` after register, patch, and delete. That transport is M4 and is not emitted here.
