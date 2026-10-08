# M3 creation read-model acceptance

**2026-10-08 parent closeout:** the temporary channel-signature build mismatch recorded below is resolved. The slice is registered in `tests/acceptance/run.mjs`. Both `RAFT_GO_TEST_SUITE=creation-read-models node tests/acceptance/run.mjs` and the full `make check` HTTP runner passed all **9 groups** against the assembled Go server. This is backend HTTP/WebSocket acceptance, not UI E2E. See `phase-3-backend-handoff.md` for final evidence.

Ownership is only:

- `server-go/tests/acceptance/m3-creation-read-models.mjs`
- this document

`run.mjs`, other acceptance modules, Go sources, clients, and `var/` stay with their owners. This file does not start a browser or an LLM. Parent calls the export after the assembled server is listening. This worker does not edit `run.mjs`.

## Parent signature

```js
import { verifyM3CreationReadModels } from './m3-creation-read-models.mjs';

await verifyM3CreationReadModels({ origin, data });
```

`origin` and `data` are the same isolated loopback instance and data directory the other M3 modules receive. The private outbox is `data/outbox`. The function returns `{ passed }`. It creates its own verified account, workspace, device session, and Computer attach through `m3-harness.mjs`. The machine peer is `connectMachine` from `m3-wire-ws.mjs`. Nothing is inserted into SQLite directly.

Standalone, against a server the parent already started:

```sh
RAFT_GO_TEST_URL=http://127.0.0.1:4301 RAFT_GO_TEST_DATA=/path/to/data \
  node server-go/tests/acceptance/m3-creation-read-models.mjs
```

## What it proves

The ready inventory advertised on the socket is `builtin`, `kimi-sdk`, and `claude`. C0 leaves `grok` and `omp` out of new-agent options. The deprecated ids `kimi`, `antigravity`, and `gemini` are also absent. Before `ready`, CLI runtimes are `not_installed` and in-process runtimes (`builtin`, `kimi-sdk`, `cursor-sdk`) are `update_required`. After `ready`, only the three reported ids become `available` and selectable. `admissionReason` is present and null. `formDefinitionRef` is present only for `builtin` (`builtin-pi.create.v2`) and `kimi-sdk` (`kimi-sdk.create.v1`).

Form definition GETs return those schema versions and option-source refs. A stale `schemaVersion` is 409 `stale_form_schema`. `claude` has no form definition (404 `unknown_form_runtime`).

While the Computer is offline, builtin option-source is 409 `builtin_catalog_unavailable` / `retry` with no version fields and no options. `runtime-models` is HTTP 200 `{kind:"error",retryable:true}` and does not invent models.

`GET .../runtime-models/claude` must send `machine:runtime_models:detect`. A result with a different `requestId` is ignored. The correlated live reply is the HTTP body. `POST .../runtimes/rescan` returns `{requested:true}` only after `{"type":"machine:runtimes:rescan"}` is sent, and it does not wait for a result.

`POST /api/agents` with the current builtin ref and `runtimeConfig.model` set to a string must send a builtin detect before it returns. The test replies with that model id. Success is HTTP 200 with `runtime:"builtin"`. An HTTP answer before the detect, including a stale-schema rejection, fails the group.

`POST /api/agents/:id/avatar` is multipart field `avatar`. The returned `avatarUrl` matches `/api/avatars/servers/{sha256}.png`, and `GET` of that path returns `image/png` whose bytes start with the PNG signature.

`POST /api/agents/:id/credentials` with `scopes:["server","channels"]` then:

- `GET /internal/agent-api/server` lists `#all` and `#eng` by name, omits the unjoined private channel and the other workspace's channel, and names the agent and the profile human without putting an `id` on those rows.
- `GET /internal/agent-api/channel-members?channel=#eng` returns `{ref:"#eng",type:"channel"}` plus those same handles.
- `#vault`, `#abroad`, and `#eng:ab12cd34` are 404 `Channel not found: {ref}`.
- A credential whose only scope is `read` gets 403 `capability_not_authorized`.
- `X-Slock-Agent-Active-Capabilities: channels` on `/server` gets 501 `unsupported_capability`.

`POST /internal/computer/preflight` includes `sk_agent` in `registeredPrincipals`, claims `/internal/agent-api/`, and lists the four GET identity routes with principal `sk_agent`.

Detect waits are 8 seconds. The shared HTTP client times out at 20 seconds. Offline catalog reads return immediately. No cursor-sdk probe (25 second budget) is used. Credentials stay in memory and are not printed.

## Historical worker-local result (superseded by parent closeout above)

`node --check tests/acceptance/m3-creation-read-models.mjs` succeeded. The acceptance process did not start.

`CGO_ENABLED=0 go build -o "$TMPDIR/raft-server" ./cmd/raft-server` fails in `internal/transport/legacyweb`, so no loopback server was available. The calls in `channel_handlers.go` do not match `internal/channel/service.go`:

| Call | Store signature |
| --- | --- |
| `UpdateChannel(ctx, c.ID, updates)` at lines 517 and 875 | `UpdateChannel(ctx, workspaceID, actorUserID, channelID, updates)` at line 208 |
| `ArchiveChannel(ctx, c.ID, userID)` at line 594 | `ArchiveChannel(ctx, workspaceID, channelID, archivedByUserID)` at line 368 |
| `UnarchiveChannel(ctx, c.ID)` at line 596 | `UnarchiveChannel(ctx, workspaceID, channelID, userID)` at line 420 |
| `DeleteChannel(ctx, c.ID)` at line 643 | `DeleteChannel(ctx, workspaceID, channelID, userID)` at line 460 |

Marked blocker: the assembled server does not compile, so this slice has no runtime result. The assertions above are unchanged.
