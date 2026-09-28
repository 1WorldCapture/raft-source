#!/usr/bin/env bash
# Daily backup of a source deployment, meant to be pulled off-site by another machine.
# Writes $RAFT_BACKUP_DIR/<UTC timestamp>/ containing:
#   db.dump        pg_dump custom format of DATABASE_URL (restore with pg_restore)
#   uploads.tar.gz local attachment directory (UPLOADS_DIR or packages/server/uploads)
#   secrets.tar.gz files listed in RAFT_BACKUP_EXTRA (e.g. .env files, daemon key files)
#   MANIFEST, SHA256SUMS, and DONE (written last: a folder without DONE is incomplete)
# plus a `latest` symlink. Keeps the newest $RAFT_BACKUP_KEEP backups.
# Scheduling: pm2 cron uses the HOST's local timezone (and DST). To pin a UTC time, let pm2 fire
# hourly (RAFT_BACKUP_CRON="0 * * * *") and set RAFT_BACKUP_UTC_HOUR; other hours exit quietly.
# Run by hand with --now to back up immediately.
# The folder can contain secrets: it is created 0700 and files 0600.
set -eu
source "$(dirname "$0")/lib.sh"
: "${RAFT_BACKUP_DIR:?set RAFT_BACKUP_DIR in env.local}"
KEEP=${RAFT_BACKUP_KEEP:-7}
if [ "${1:-}" != "--now" ] && [ -n "${RAFT_BACKUP_UTC_HOUR:-}" ] && [ "$(date -u +%-H)" != "$RAFT_BACKUP_UTC_HOUR" ]; then
  exit 0
fi
TS=$(date -u +%Y-%m-%dT%H%M%SZ)
umask 077
mkdir -p "$RAFT_BACKUP_DIR"; chmod 700 "$RAFT_BACKUP_DIR"
OUT=$RAFT_BACKUP_DIR/$TS; TMP=$OUT.partial
rm -rf "$TMP"; mkdir -p "$TMP"
trap 'log "backup FAILED (partial left at $TMP)"; exit 1' ERR

cd "$RAFT_ROOT/packages/server"
# Read DATABASE_URL / UPLOADS_DIR from .env explicitly (never from the caller's env, never printed).
eval "$(node -e '
  require("dotenv").config({ quiet: true, override: true });
  const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  console.log("DB_URL=" + q(process.env.DATABASE_URL || ""));
  console.log("UPLOADS=" + q(process.env.UPLOADS_DIR || "uploads"));')"
[ -n "$DB_URL" ] || die "DATABASE_URL missing in packages/server/.env"

log "pg_dump"
pg_dump -Fc --no-owner -d "$DB_URL" -f "$TMP/db.dump"
TABLES=$(pg_restore -l "$TMP/db.dump" | grep -c "TABLE DATA")
[ "$TABLES" -gt 0 ] || die "dump has no table data"
unset DB_URL

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
  echo "migrations=$(ls "$RAFT_ROOT"/packages/server/drizzle/*.sql | wc -l)"
  (cd "$TMP" && ls -l --time-style=+ | awk 'NR>1{print "file=" $NF " bytes=" $5}')
} > "$TMP/MANIFEST"
(cd "$TMP" && sha256sum db.dump MANIFEST $(ls uploads.tar.gz secrets.tar.gz 2>/dev/null) > SHA256SUMS)
chmod 600 "$TMP"/*
mv -T "$TMP" "$OUT"
date -u +%FT%TZ > "$OUT/DONE"
ln -sfn "$TS" "$RAFT_BACKUP_DIR/latest.tmp" && mv -T "$RAFT_BACKUP_DIR/latest.tmp" "$RAFT_BACKUP_DIR/latest"

# Retention: keep the newest $KEEP complete backups; drop stale partials.
ls -1d "$RAFT_BACKUP_DIR"/*Z 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf
find "$RAFT_BACKUP_DIR" -maxdepth 1 -name '*.partial' -mmin +720 -exec rm -rf {} +
log "backup OK: $OUT ($(du -sh "$OUT" | cut -f1), $TABLES tables with data)"
