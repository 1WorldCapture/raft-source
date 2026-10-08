# M2 implementation coordination

Source of truth: `docs/phase-2-workspaces.md` and `contracts/legacyweb/workspaces-route-matrix.json`; TS baseline `c4a5015deb7dcc8b800df96675d899f384f76e36`. Work only under `server-go/`. Do not edit the design inputs, clients, live `var/`, prior migrations, or unrelated changes. No commits/pushes. This is a coordination document, NOT a completion claim.

## Ownership

- Foundation worker: `internal/workspace/store.go`, `model.go`, `service.go`, `policy.go`, `order.go`, basic profile files and its own tests; migration `0003_workspace_foundation.sql` (workspace additions, membership rebuild preserving rows, agreement audit, channels/channel_humans). Own common definitions below. Do not change app/config/transport.
- Setup worker: `internal/workspace/setup*.go`, `internal/workspace/directories*.go` and their tests; migration `0004_workspace_setup.sql` (member setup, computers/machines/agents minimal REAL directories, account first-onboarding facts, survey facts as required). Own projector, commands, machine directory. No product registration/agent writer. Read TS for exact directory/official identity semantics.
- Settings worker: `internal/workspace/settings*.go`, `members*.go`, `sidebar*.go`, their tests; migration `0005_workspace_preferences.sql` (member preferences). Own exact settings/members/sidebar contracts. Do not change common files.
- HTTP worker: `internal/transport/legacyweb/` workspace handler/DTO/scope/tests/routes, `internal/app/app.go`, `internal/platform/config/` policy wiring as necessary, avatar upload reuse. Preserve M1 behavior/tests except honest assertions replaced by implemented M2 contracts. No workspace domain/migration edits.
- Integrator: acceptance/lifecycle tests, Makefile, independent review, integration fixes, release/handoff documentation, full verification.

## Common API contract (implemented by foundation unless noted)

Keep `NewStore(db *sql.DB) *Store`. Add `NewStoreWithOptions(db *sql.DB, opts Options) *Store` where `Options{Clock clock.Clock, Policy Policy}`; store fields `db *sql.DB`, `clock clock.Clock`, `policy Policy`, and helper `func (s *Store) now() time.Time`. Policy fields: `OnboardingOpenerV2 bool`, `OnboardingOwnerWizardV0 bool`, `FeedbackEnabled bool`; all default false (C0). Do not enable unsupported push/platform flags.

Common error: `type DomainError struct { Code string; Message string }`, implement `Error() string`; use `&DomainError{Code: ..., Message: ...}`. Transport maps codes to endpoint status/shape, never mistakes DB failure for authentication failure. Generic codes: `INVALID_INPUT`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`; setup uses its exact TS machine codes. Internal DB errors stay ordinary wrapped errors.

Foundation exports:

- Existing `Membership`, `ListUserServers(ctx,userID) ([]Membership,error)`, `CountMemberships`. Add list `ServerOrderVersion int64`, history fields as needed, preserve existing fields.
- `ServerRecord` with exact external JSON fields, null semantics and UTC millisecond timestamp output (may use custom marshal or transport DTO).
- `CreateWorkspace(ctx,userID,name,slug string) (ServerRecord,error)`; transport handles raw JSON truthiness/type compatibility. Owner from authenticated user; transactional revalidation. Store validates slug and normal string behavior.
- `GetWorkspace(ctx,workspaceID string) (ServerRecord,error)`.
- `GetMembership(ctx,workspaceID,userID string) (Membership,error)` filters deleted/joint_storage and returns FORBIDDEN for lack of membership.
- `ProfilePatch{ Name *string; HideHumansFromMembers *bool }` and `UpdateProfile(ctx,workspaceID,userID string,patch ProfilePatch) (ServerRecord,error)` with transactional capability checks.
- `SetAvatar(ctx,workspaceID,userID,url string) (ServerRecord,error)` with capability checks.
- `WorkspaceOrder{ ServerOrder []string; ServerOrderVersion int64 }` with JSON tags and `GetOrder(ctx,userID string) (WorkspaceOrder,error)`, `UpdateOrder(ctx,userID string,ids []string) (WorkspaceOrder,error)`.
- `func CanManage(role string) bool` = owner/admin.

Creation must insert default rows into BOTH `workspace_member_setup(workspace_id,user_id,status,completion_reason,contract_version)` (not_started, NULL, onboarding-setup-v2) and `workspace_member_preferences(workspace_id,user_id)` within its transaction. Setup/preferences migrations run before app serves. Foundation does not define those tables. Legacy backfills belong to table owners; never auto-complete old owners.

Setup worker exports:

- `SetupProjection` (exact TS JSON model) and `GetSetupProjection(ctx,workspaceID,userID string) (SetupProjection,error)`.
- `TransitionSetup(ctx,workspaceID,userID,action string) (SetupProjection,error)`.
- `SetupResetResult` and `ResetSetup(ctx,workspaceID,userID string) (SetupResetResult,error)`.
- `HandoffSetup(ctx,workspaceID,userID,sessionFamilyID string) (SetupProjection,error)`.
- `ListMachines(ctx,workspaceID,userID string) ([]map[string]any,error)` (exact TS returned field shapes; [] not null).
- Package helper `validateConfiguredAgentTx(ctx context.Context,tx *sql.Tx,workspaceID,agentID string) error`: accepts real active local Agent regardless of official identity (the config setter rule); rejects invalid/nonlocal/deleted.
- Package helper `reconcileOwnersTx(ctx context.Context,tx *sql.Tx,workspaceID string) error`: mark incomplete owners complete/grandfathered, leave completed reasons unchanged. Called by settings transaction; no nested tx. Own exact column names.
- Notify settings worker/integrator of real agent/machine table columns before sidebar visibility tests. Document schema in this file or a separate `docs/m2-directory-schema.md` (setup worker owns that file).

Settings worker exports:

- `ListMembers(ctx,workspaceID,userID string) ([]map[string]any,error)`.
- `GetSettings(ctx,workspaceID,userID string) (map[string]any,error)` returning `{settings:{onboardSettings:...,feedbackSettings:...}}`.
- `GetOnboardingSettings(ctx,workspaceID,userID string) (map[string]any,error)` returning inner settings.
- `UpdateOnboardingSettings(ctx,workspaceID,userID string,fields map[string]any) (map[string]any,error)` (raw JSON for exact absent/null/type rules; all effects in one transaction, uses setup helpers for nonnull agent setter).
- `GetSidebarOrder(ctx,workspaceID,userID string) (map[string]any,error)`.

Read current common APIs before final verification. If an API/schema adjustment is essential, report it clearly and coordinate rather than overwrite another worker's files. Use own temporary test DBs, never `var/`. Failure injection via isolated SQLite triggers is appropriate. Each worker must add behavioral tests, run focused tests after dependent files exist, and report exact commands/results and remaining gaps. In-progress compile failures from another worker's incomplete file are not reasons to skip eventual validation.
