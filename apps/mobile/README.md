# Raft mobile

Expo client for a private Raft deployment. Phase 1 covers sign-in, servers, channels, messages, threads, and live updates.

## Layout

- `app/` — expo-router screens (server address, login, servers, channels, messages, threads)
- `src/api/` — fetch client, token refresh, health check
- `src/model/` — message, mention, and unread parsing
- `src/realtime/` — socket.io connection
- `src/state/` — zustand cache and the secure-store session

## Start

From the repository root:

```sh
pnpm install
pnpm --filter @botiverse/raft-mobile start
```

Then open the project in the iOS simulator, Android emulator, or Expo Go. The first screen asks for the server origin, for example `https://raft.example.com` or `127.0.0.1:8787`. The app calls `GET /health` and only saves the address when the response is `{ "status": "ok" }`.

Tokens and the server address live in expo-secure-store. They are not written to logs.

## Checks

```sh
pnpm --filter @botiverse/raft-mobile test
pnpm --filter @botiverse/raft-mobile typecheck
pnpm --filter @botiverse/raft-mobile lint
```

Lint uses oxlint, the same linter as `packages/web`, instead of a second ESLint setup.

Mention matching imports `createRaftStructuredUserRefRegex` from `@botiverse/raft-shared`. The package barrel pulls in generated server modules, so the app imports `src/raftRefs.ts` directly.
