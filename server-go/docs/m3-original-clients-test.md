# M3 original-client compatibility test

**2026-10-08 parent closeout:** registered in `tests/acceptance/run.mjs` and executed successfully both with `RAFT_GO_TEST_SUITE=original-clients` and through full `make check`. Unmodified Computer/Daemon clients passed direct connection, configured device-verification origin, and isolated same-origin proxy forwarding of `/api`, `/internal` and `/daemon` with WebSocket upgrade. No Web UI, browser or real model provider was started. Older parent-wiring instructions below are retained as implementation history; see `phase-3-backend-handoff.md` for current delivery evidence.

Ownership is only:

- `server-go/tests/acceptance/original-clients.mjs`
- `server-go/tests/fixtures/original-clients/**`
- this document

The acceptance runner, the existing `m3-*` scripts, Go sources, client packages, lockfiles, and `var/` stay with their owners. This suite does not skip when client dependencies are missing: the repository test requires them. The server under test is still the Go process.

## Parent signature

```js
import { verifyOriginalClients } from './original-clients.mjs';

await verifyOriginalClients({
  origin, // loopback Go base URL, same value the other acceptance modules receive
  data,   // that process's data directory; the private outbox is data/outbox
  capture({ stream, text }) {
    // stream is 'stdout' or 'stderr'.
    // Called once per stream after the tsx child exits, and only when the
    // captured text has no credential material. Feed `text` into the runner's
    // existing log buffer if that buffer is scanned. Do not print it first.
  },
  // executable is optional. Default: <repo>/node_modules/.bin/tsx
  // Pass an absolute path only when the runner cannot use that default.
});
```

`verifyOriginalClients({ origin, data, capture, executable? })` returns `{ ok: true, verificationOrigin }`. `verificationOrigin` is the absolute origin from the original `DeviceAuthClient.authorize` result (`verificationUri`), never a code or token. `capture` is required. Secrets are not returned.

Wire it after the Go process is fully assembled (computer, runners, and `/daemon/connect` all registered). It creates its own verified account and workspace through `m3-harness.mjs` (`createVerifiedAccount`, `createWorkspace`). It does not reuse another module's computer key and it does not mark setup complete.

Standalone, with a server the parent already started:

```sh
RAFT_GO_TEST_URL=http://127.0.0.1:4301 RAFT_GO_TEST_DATA=/path/to/data \
  node server-go/tests/acceptance/original-clients.mjs
```

## What the original clients do

The parent process only performs product registration and profile completion, then writes one JSON fixture to the child's stdin. The fixture's user token never goes in argv or in the child environment. The child runs with a private `HOME` and no inherited proxy variables. Its deadline is 80s; the parent kills it at 100s. Proxy sockets, daemon sockets, and reconnect timers are closed in `finally`.

`node_modules/.bin/tsx` loads these modules unchanged:

- `packages/computer/src/apiClient.ts`: `DeviceAuthClient`, `ComputerAttachClient`, `ServersClient`, `AuthClient`, `ServerMachinesClient`, `RunnersClient`
- `packages/daemon/src/connection.ts`: `DaemonConnection`

`ws` is resolved with `createRequire` from `packages/daemon/package.json` and used as the real network constructor. `DaemonConnection`'s `wsFactory` only captures that socket so the test can call `terminate()` and observe the client's own reconnect. There is no fake socket.

Covered behavior, on the direct Go origin and again through the proxy:

1. `DeviceAuthClient.authorize('raft-computer')`, one `token()` call that returns `pending`, then product `POST /api/auth/device/approve` with the registered user's bearer token, then `token()` until `success`. The issued token's `userId` is the approving user. A denied grant (`approve: false`) is checked on the direct origin; `token()` returns `denied`.
2. `AuthClient.me()` matches the verified profile.
3. `ServersClient.list()` uses its hardcoded `GET /api/servers/` (trailing slash). The proxy observation requires that exact path and rejects a no-slash list.
4. `ComputerAttachClient.attach` then `preflight` with the issued `sk_computer_*` key.
5. `ServerMachinesClient.list` shows that machine as the current user's computer.
6. `RunnersClient.list()` and `list({ all: true })` must return `success` with whitelist `agentId`, `name`, `status`, `model`, `runtime`, in that order. HTTP 401 is a failure. The runners extension is implemented, so the older fail-closed alternative does not apply here.
7. `DaemonConnection` with `onMessage`, `onConnect`, and `onDisconnect`. The first frame is `machine:context` for the attached machine. `onConnect` sends the TypeScript `emitReady` payload: `agent:start`, `agent:stop`, `AGENT_PURGE_CAPABILITY`, `agent:deliver`, `workspace:files`, `WIKI_WORKSPACE_PACK_CAPABILITY`, `BUILT_IN_READY_CAPABILITIES`, an idle `migrationTransport`, hostname, os, and the daemon package version. No supervisor, CLI install, or LLM runs, so the runtime inventory is the explicit report `original-client` / `0` rather than a local runtime probe. The directory must then show those facts and `status: "online"`.
8. The client sends `{type:'ping'}`. The server echo is `{type:'ping'}`. `onMessage` answers that ping with `{type:'pong'}`, which is what `packages/daemon/src/core.ts` does. `terminate()` on the captured real socket must disconnect and reconnect: a second `onConnect`, another `machine:context`, and another ping echo. `minReconnectDelayMs: 200` is the original connection option, not a substitute transport.

Subprocess stdout and stderr are held inside the parent. Output that contains a known fixture secret, an `sk_*` credential, a bearer token, a JWT, or a key-valued `accessToken` / `refreshToken` / `apiKey` / `deviceCode` / `userCode` / `password` fails the test and is not passed to `capture`. Only `PASS original-clients …` lines are written to the parent console.

## Proxy and the 5175 observation

`tests/fixtures/original-clients/proxy.mjs` listens on an ephemeral `127.0.0.1` port and forwards to the Go origin. It copies the Vite dev and preview table for the routes this client uses:

| Prefix | Vite options this proxy applies |
|---|---|
| `/api` | `changeOrigin: true`, `xfwd: true` (`X-Forwarded-For`, `X-Forwarded-Port` from the incoming Host, `X-Forwarded-Proto`) |
| `/internal` | same as `/api` |
| `/daemon` | `ws: true` only. Host is not rewritten and `xfwd` is not added. |

`/socket.io` is not proxied. The computer and daemon clients do not use it, and browser Socket.IO is outside M3.

The web UI's dev origin (documented as 5175) is a same-origin base URL: HTTP `/api` and `/internal` plus WebSocket `/daemon/connect` share it, and Vite forwards them to Go. This test uses an ephemeral port so it does not take over a live Vite process. Success through that proxy means a client configured with the web origin can reach Go when this proxy table is in front of it. The direct Go URL remains the other supported base URL. `verificationUri` must be an absolute `/login/device` URL whose origin is not the origin the client called. When the server is started with `RAFT_GO_WEB_ORIGIN=http://127.0.0.1:5175`, that origin is what `device-verification-origin` reports.

## Local checks that do not need the Go server

```sh
node --check server-go/tests/acceptance/original-clients.mjs
node --check server-go/tests/fixtures/original-clients/drive.mjs
node --check server-go/tests/fixtures/original-clients/proxy.mjs
node_modules/.bin/tsx server-go/tests/fixtures/original-clients/drive.mjs --self-check
```

`--self-check` imports the original classes, resolves `ws` from the daemon package, and opens a real `DaemonConnection` through the proxy to a stdlib upgrade stub. It is not a product session and it does not replace `verifyOriginalClients`.

## Honest limits

No Vite process, no browser, no web build, no OS service or supervisor, no Computer CLI install, and no LLM. Offline projection after the final `disconnect()` is left to the machine WebSocket suite; this test checks the reconnect itself while the client still wants the socket. `verifyOriginalClients` does not start Go. A failure against an assembled server is a failure, not a skipped dependency.

## Checks already run

`node --check` passed for the acceptance module, the driver, and the proxy. `tsx …/drive.mjs --self-check` passed: the original classes import, `ws` resolves from the daemon package, and a real `DaemonConnection` opens through the proxy.

`verifyOriginalClients` was also run against a temporary build of the current server (`RAFT_GO_WEB_ORIGIN=http://127.0.0.1:5175`, private data directory, process removed afterward). It passed:

- `PASS original-clients direct`
- `PASS original-clients device-verification-origin http://127.0.0.1:5175`
- `PASS original-clients proxy`
- `PASS original-clients proxy-forwarded /api /internal /daemon`

That run is not a substitute for the parent wiring this call into `run.mjs`.
