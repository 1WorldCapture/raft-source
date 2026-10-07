# Raft mobile

Expo client for a private Raft deployment. Phase 1 covers sign-in, servers, channels, messages, threads, and live updates.

## Layout

- `app/` — expo-router screens. Signed-in navigation is a bottom tab bar (home, tasks, members, settings); channel, thread, activity, saved, and search cover that bar
- `src/ui/` — design tokens, Space Grotesk / Space Mono, and the shared controls
- `src/i18n/` — web catalogs plus `mobile.*` strings
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

Then open the project in the iOS simulator, Android emulator, or Expo Go. The server address comes from `EXPO_PUBLIC_RAFT_SERVER_URL` at build time. There is no address screen. A missing or invalid value stops on a configuration error.

Tokens and the server address live in expo-secure-store. They are not written to logs.

## Checks

```sh
pnpm --filter @botiverse/raft-mobile test
pnpm --filter @botiverse/raft-mobile typecheck
pnpm --filter @botiverse/raft-mobile lint
pnpm --filter @botiverse/raft-mobile check:colors
```

The interface stays light. Fonts load before the splash hides. Chinese falls back to PingFang SC on iOS and the system CJK face on Android.

Lint uses oxlint, the same linter as `packages/web`, instead of a second ESLint setup.

Mention matching imports `createRaftStructuredUserRefRegex` from `@botiverse/raft-shared`. The package barrel pulls in generated server modules, so the app imports `src/raftRefs.ts` directly.
