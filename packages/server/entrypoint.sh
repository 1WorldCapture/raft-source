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
#
# The runtime image runs the esbuild bundles in packages/server/dist/ instead
# of tsx on src/ (server-image stage 1). The three migration steps mirror
# package.json's db:migrate:deploy exactly; that script keeps its tsx form
# because dev checkouts have no dist/.
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
       node dist/migration-preflight.js \
    && DATABASE_URL="$MIGRATION_URL" \
       SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS="$MS" \
       node dist/migrate-deploy.js \
    && DATABASE_URL="$MIGRATION_URL" \
       SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS="$MS" \
       node dist/verify-feature-flag-admin-privileges.js)
  echo "[entrypoint] migrations complete"
fi

cd /app
# --enable-source-maps maps bundled stack traces back to src/ via the
# external .map files shipped next to dist/*.js.
NODE_OPTIONS="--enable-source-maps${NODE_OPTIONS:+ $NODE_OPTIONS}"
export NODE_OPTIONS
exec node packages/server/dist/server.js
