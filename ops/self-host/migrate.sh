#!/usr/bin/env bash
# Apply database migrations with the server's guarded deploy path (db:migrate:deploy).
# That path refuses to run unless the migration connection has an explicit statement_timeout
# delivered through the DSN's libpq `options=-c statement_timeout=<ms>` AND the same value is
# declared in SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS. We derive that DSN from
# DATABASE_URL in packages/server/.env for this one command only, so the running server's
# connections are not affected. Values are never printed.
set -eu
source "$(dirname "$0")/lib.sh"
MS=${RAFT_MIGRATION_TIMEOUT_MS:-60000}
cd "$RAFT_ROOT/packages/server"
MIGRATION_URL=$(node -e '
  require("dotenv").config({ quiet: true, override: true });
  const u = new URL(process.env.DATABASE_URL);
  u.searchParams.set("options", `-c statement_timeout=${process.argv[1]}`);
  process.stdout.write(u.toString());' "$MS")
log "db:migrate:deploy (statement_timeout=${MS}ms)"
DATABASE_URL=$MIGRATION_URL SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS=$MS pnpm run db:migrate:deploy
