#!/usr/bin/env bash
# Scheduled backup of a source deployment, meant to be pulled off-site by another machine.
# Writes $RAFT_BACKUP_DIR/<UTC timestamp>/ containing:
#   db.dump        pg_dump custom format of DATABASE_URL (restore with pg_restore)
#   uploads.tar.gz local attachment directory (UPLOADS_DIR or packages/server/uploads)
#   secrets.tar.gz files listed in RAFT_BACKUP_EXTRA (e.g. .env files, daemon key files)
#   MANIFEST, SHA256SUMS, and DONE (written last: a folder without DONE is incomplete)
# plus a `latest` symlink. Keeps the newest $RAFT_BACKUP_KEEP backups.
# Scheduling: pm2 cron uses the HOST's local timezone (and DST). To pin UTC times, let pm2 fire
# hourly (RAFT_BACKUP_CRON="0 * * * *") and set either RAFT_BACKUP_EVERY_HOURS=N (runs when the
# hours since the Unix epoch are a multiple of N: a steady N-hour interval, even when 24 % N != 0)
# or RAFT_BACKUP_UTC_HOUR (once a day); other hours exit quietly. EVERY_HOURS wins if both are set.
# Run by hand with --now to back up immediately.
# The folder can contain secrets: it is created 0700 and files 0600.
set -eu
source "$(dirname "$0")/lib.sh"
: "${RAFT_BACKUP_DIR:?set RAFT_BACKUP_DIR in env.local}"
KEEP=${RAFT_BACKUP_KEEP:-7}
if [ "${1:-}" != "--now" ]; then
  if [ -n "${RAFT_BACKUP_EVERY_HOURS:-}" ]; then
    case $RAFT_BACKUP_EVERY_HOURS in ''|*[!0-9]*|0*) die "RAFT_BACKUP_EVERY_HOURS must be a positive integer";; esac
    [ $(( $(date -u +%s) / 3600 % RAFT_BACKUP_EVERY_HOURS )) -eq 0 ] || exit 0
  elif [ -n "${RAFT_BACKUP_UTC_HOUR:-}" ] && [ "$(date -u +%-H)" != "$RAFT_BACKUP_UTC_HOUR" ]; then
    exit 0
  fi
fi
TS=$(date -u +%Y-%m-%dT%H%M%SZ)
umask 077
mkdir -p "$RAFT_BACKUP_DIR"; chmod 700 "$RAFT_BACKUP_DIR"
OUT=$RAFT_BACKUP_DIR/$TS; TMP=$OUT.partial
rm -rf "$TMP"; mkdir -p "$TMP"
trap 'log "backup FAILED (partial left at $TMP)"; exit 1' ERR

cd "$RAFT_ROOT/packages/server"
# Read DATABASE_URL / UPLOADS_DIR from .env explicitly (never from the caller's env, never printed).
# The URL is split into PG* variables and a private pgpass file so the password never appears in
# pg_dump's command line (visible to anyone running `ps` while the dump runs).
PGPASS_FILE=$(mktemp); chmod 600 "$PGPASS_FILE"
trap 'rm -f "$PGPASS_FILE"' EXIT
eval "$(PGPASS_FILE="$PGPASS_FILE" node -e '
  require("dotenv").config({ quiet: true, override: true });
  const fs = require("node:fs");
  const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  const raw = process.env.DATABASE_URL;
  if (!raw) { console.log("DB_OK=0"); process.exit(0); }
  const u = new URL(raw);
  const host = u.hostname || "localhost", port = u.port || "5432";
  const user = decodeURIComponent(u.username), db = decodeURIComponent(u.pathname.slice(1));
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:");
  fs.writeFileSync(process.env.PGPASS_FILE, [host, port, db, user, decodeURIComponent(u.password)].map(esc).join(":") + "\n", { mode: 0o600 });
  console.log("DB_OK=1");
  console.log("export PGHOST=" + q(host) + " PGPORT=" + q(port) + " PGUSER=" + q(user) + " PGDATABASE=" + q(db));
  const ssl = u.searchParams.get("sslmode"); if (ssl) console.log("export PGSSLMODE=" + q(ssl));
  console.log("UPLOADS=" + q(process.env.UPLOADS_DIR || "uploads"));')"
[ "${DB_OK:-0}" = 1 ] || die "DATABASE_URL missing in packages/server/.env"
export PGPASSFILE=$PGPASS_FILE

log "pg_dump"
pg_dump -Fc --no-owner -f "$TMP/db.dump"
TABLES=$(pg_restore -l "$TMP/db.dump" | grep -c "TABLE DATA")
[ "$TABLES" -gt 0 ] || die "dump has no table data"
rm -f "$PGPASS_FILE"

log "uploads"
UP=$(cd "$RAFT_ROOT/packages/server" && realpath -m "$UPLOADS")
if [ -d "$UP" ]; then tar -czf "$TMP/uploads.tar.gz" -C "$(dirname "$UP")" "$(basename "$UP")"; fi

if [ -n "${RAFT_BACKUP_EXTRA:-}" ]; then
  log "secrets/config"
  # Paths relative to RAFT_ROOT or absolute; missing files are reported, not fatal.
  FILES=()
  for f in $RAFT_BACKUP_EXTRA; do
    p=$f; [ "${p#/}" = "$p" ] && p=$RAFT_ROOT/$p
    if [ -e "$p" ]; then FILES+=("$p"); else log "WARN missing $f"; fi
  done
  [ ${#FILES[@]} -gt 0 ] && tar -czPf "$TMP/secrets.tar.gz" "${FILES[@]}"
fi

{
  echo "created_at=$TS"
  echo "release_sha=$(git -C "$RAFT_ROOT" rev-parse HEAD)"
  echo "db_tables_with_data=$TABLES"
  echo "migrations=$(ls "$RAFT_ROOT"/packages/server/drizzle/*.sql 2>/dev/null | wc -l || true)"
  (cd "$TMP" && ls -l --time-style=+ | awk 'NR>1{print "file=" $NF " bytes=" $5}')
} > "$TMP/MANIFEST"
(cd "$TMP" && sha256sum db.dump MANIFEST $(ls uploads.tar.gz secrets.tar.gz 2>/dev/null) > SHA256SUMS)
chmod 600 "$TMP"/*
mv -T "$TMP" "$OUT"
date -u +%FT%TZ > "$OUT/DONE"
ln -sfn "$TS" "$RAFT_BACKUP_DIR/latest.tmp" && mv -T "$RAFT_BACKUP_DIR/latest.tmp" "$RAFT_BACKUP_DIR/latest"

# Retention: keep the newest $KEEP COMPLETE backups (folders with DONE), so a run of failures
# can never push the last good backups out; drop stale partial/incomplete folders after 12h.
for d in "$RAFT_BACKUP_DIR"/*Z; do [ -f "$d/DONE" ] && echo "$d"; done | sort | head -n -"$KEEP" | xargs -r rm -rf
find "$RAFT_BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d -mmin +720 ! -exec test -f '{}/DONE' \; -exec rm -rf {} +
log "backup OK: $OUT ($(du -sh "$OUT" | cut -f1), $TABLES tables with data)"
