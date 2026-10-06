#!/bin/sh
# Container entrypoint for the raft server image.
#
# RAFT_RUN_MIGRATIONS=1 (set by the self-hosted docker-compose deployment)
# runs the guarded migration path before starting the server — the same
# semantics as ops/self-host/migrate.sh: the migration connection gets an
# explicit libpq statement_timeout via the DSN `options` parameter, and the
# same value is declared in SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS
# (migrateDeploy refuses to run without the matching pair). Idempotent:
# every migration applies at most once, so boots after the first are no-ops.
# Any other value (or unset) skips migration — the official deploy flow,
# which owns its own migration step, keeps its previous behavior exactly.
set -e

if [ "${RAFT_RUN_MIGRATIONS}" = "1" ]; then
  MS="${RAFT_MIGRATION_TIMEOUT_MS:-60000}"
  MIGRATION_URL=$(node -e '
    const u = new URL(process.env.DATABASE_URL);
    u.searchParams.set("options", `-c statement_timeout=${process.argv[1]}`);
    process.stdout.write(u.toString());
  ' "$MS")
  echo "[entrypoint] running guarded migrations (statement_timeout=${MS}ms)"
  (cd packages/server \
    && DATABASE_URL="$MIGRATION_URL" \
       SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS="$MS" \
       pnpm run db:migrate:deploy)
  echo "[entrypoint] migrations complete"
fi

cd /app
exec npx tsx packages/server/src/server.ts
