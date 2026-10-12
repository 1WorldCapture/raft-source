#!/usr/bin/env bash
# Run an isolated drill end to end, using the guards in lib.sh.
#
#   RAFT_TEST_EMAIL=… RAFT_TEST_PASSWORD=… \
#     scripts/drill/run-scenario.sh <label> <repo> <workdir> [ref]
#
# Sequence: preflight (rebuild + prove identity + snapshot isolation) →
# scenario → postflight (kill residue, restore owner state, hard-fail on any
# residue). The postflight runs from an EXIT trap, so an aborted drill is still
# cleaned up and still fails loudly.
#
# Credentials come from the environment and are never written to disk, logged, or
# accepted in argv. The scenario creates its own server/channel/agent and deletes
# them again; nothing outside <workdir> and the drill's own /tmp homes is kept.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SELF_DIR/lib.sh"

LABEL="${1:-}"
REPO="${2:-}"
WORK="${3:-/tmp/drill}"
REF="${4:-HEAD}"
[[ -n "$LABEL" && -n "$REPO" ]] || drill::fail "usage: run-scenario.sh <label> <repo> <workdir> [ref]"

: "${RAFT_TEST_EMAIL:?set RAFT_TEST_EMAIL}"
: "${RAFT_TEST_PASSWORD:?set RAFT_TEST_PASSWORD}"
BASE_URL="${RAFT_TEST_BASE_URL:-https://raft.tailf3efbe.ts.net:8443}"
# Owner policy: tailnet names only. Refuse to start a drill against the public
# 1wc.io names, where a local proxy can cut TLS and look like a server fault.
drill::assert_tailscale_endpoint "$BASE_URL"
RUNTIME="${RAFT_TEST_RUNTIME:-antigravity-stream}"
MODEL="${RAFT_TEST_MODEL:-gemini-3.8-flash-low}"
# Windows, not rigour: this run exists to prove the tooling, not to re-measure
# delivery. Override to widen.
SETTLE_WAIT="${RAFT_DRILL_SETTLE_WAIT:-180}"
RETRY_WINDOW="${RAFT_DRILL_RETRY_WINDOW:-180}"

HOME_DIR="$WORK/home-$LABEL"
mkdir -p "$WORK"
LOGIN_STATE="$WORK/login-$LABEL.json"
# The token is written 0600 into the drill workdir and deleted with it. It is
# never logged, and never lands in the repository.
umask 077

cleanup() {
  local rc=$?
  drill::log "running postflight"
  if [[ -f "$WORK/restore-ref.txt" ]]; then
    RAFT_DRILL_HOMES="$HOME_DIR" bash "$SELF_DIR/postflight.sh" "$REPO" "$WORK" \
      'packages/computer/dist/raft-computer.js __service' || rc=1
  else
    drill::warn "preflight never completed — skipping postflight gates (nothing was built or moved)"
  fi
  rm -f "$LOGIN_STATE"
  exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------- preflight --
bash "$SELF_DIR/preflight.sh" "$REPO" "$REF" "$WORK" >/dev/null
TARGET_SHA="$(git -C "$REPO" rev-parse HEAD)"
drill::log "drill $LABEL starting against $BASE_URL @ ${TARGET_SHA:0:12}"

# Remove any stale login item BEFORE starting so a crash cannot leave one behind.
drill::remove_tmp_loginitems >/dev/null

mkdir -p "$HOME_DIR"
chmod 700 "$HOME_DIR"

# ------------------------------------------------------------------ scenario --
curl -s --max-time 30 -X POST "$BASE_URL/api/auth/login" -H 'Content-Type: application/json' \
  --data "$(python3 -c 'import json,os,sys;print(json.dumps({"email":os.environ["RAFT_TEST_EMAIL"],"password":os.environ["RAFT_TEST_PASSWORD"]}))')" \
  > "$LOGIN_STATE" || drill::fail "login request failed"
TOKEN="$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('accessToken',''))" "$LOGIN_STATE")"
[[ -n "$TOKEN" ]] || drill::fail "login returned no token"
drill::log "authenticated as ${RAFT_TEST_EMAIL}"

# mint the user session the attach step needs (device-code login needs a browser)
TOKEN="$TOKEN" LOGIN_STATE="$LOGIN_STATE" HOME_DIR="$HOME_DIR" BASE_URL="$BASE_URL" python3 - <<'PY'
import json, os
d = json.load(open(os.environ["LOGIN_STATE"]))
u = d.get("user") or {}
p = os.path.join(os.environ["HOME_DIR"], "computer", "user-session.json")
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump({
    "kind": "user-session", "schemaVersion": 1,
    "userId": u.get("id") or d.get("userId", ""),
    "accessToken": os.environ["TOKEN"],
    "refreshToken": d.get("refreshToken", ""),
    "serverUrl": os.environ["BASE_URL"],
    "email": u.get("email", ""),
}, open(p, "w"), indent=2)
os.chmod(p, 0o600)
PY

SLUG="drill-$LABEL-$(date +%H%M%S)-$RANDOM"
SID="$(curl -s --max-time 30 -X POST "$BASE_URL/api/servers" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -d "{\"name\":\"$SLUG\",\"slug\":\"$SLUG\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")"
[[ -n "$SID" ]] || drill::fail "could not create the drill server"
drill::log "server $SID ($SLUG)"

export RAFT_HOME="$HOME_DIR" SLOCK_HOME="$HOME_DIR"
export SLOCK_DAEMON_TRACE_MAX_FILE_AGE_MS=7200000 SLOCK_DAEMON_TRACE_MAX_FILES=200

( cd "$REPO" && timeout 240 node packages/computer/dist/raft-computer.js attach "$SLUG" ) >"$WORK/attach-$LABEL.log" 2>&1 \
  || drill::fail "attach failed: $(tail -2 "$WORK/attach-$LABEL.log")"
rm -f "$HOME_DIR/computer/run/service.sock"
( cd "$REPO" && nohup node packages/computer/dist/raft-computer.js __service >"$WORK/svc-$LABEL.log" 2>&1 & )
sleep 18
( cd "$REPO" && timeout 120 node packages/computer/dist/raft-computer.js start ) >"$WORK/start-$LABEL.log" 2>&1
sleep 20

RUN="$HOME_DIR/computer/servers/$SID/runner.log"
grep -oE "antigravity-stream \([0-9.]+\)" "$RUN" 2>/dev/null | head -1 || drill::warn "agy runtime not reported in runner.log"

CID="$(curl -s --max-time 30 -X POST "$BASE_URL/api/channels" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -H "X-Server-Id: $SID" -d "{\"name\":\"drill-$LABEL\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")"
AID="$(curl -s --max-time 60 -X POST "$BASE_URL/api/agents" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -H "X-Server-Id: $SID" \
  -d "{\"name\":\"drill-$LABEL\",\"runtime\":\"$RUNTIME\",\"model\":\"$MODEL\",\"description\":\"Isolated drill. Reply once per message with a single word. Do not use browser tools.\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")"
[[ -n "$CID" && -n "$AID" ]] || drill::fail "could not create the drill channel/agent"
curl -s --max-time 30 -X POST "$BASE_URL/api/channels/$CID/members" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -H "X-Server-Id: $SID" -d "{\"agentId\":\"$AID\"}" >/dev/null
drill::log "channel $CID, agent $AID ($RUNTIME / $MODEL)"
sleep 25

send() { curl -s --max-time 30 -X POST "$BASE_URL/api/messages" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" -H "X-Server-Id: $SID" -d "$1" >/dev/null; }
send "{\"channelId\":\"$CID\",\"content\":\"@drill-$LABEL think step by step at length, then reply DONE.\"}"
sleep 3
for i in 1 2 3 4 5; do
  send "{\"channelId\":\"$CID\",\"content\":\"@drill-$LABEL probe $i: reply with the single word P$i.\"}"
  sleep 1
done
drill::log "scenario sent (6 messages); settle ${SETTLE_WAIT}s + observe ${RETRY_WINDOW}s"
sleep "$SETTLE_WAIT"
sleep "$RETRY_WINDOW"

# ------------------------------------------------------------------ results --
mkdir -p "$WORK/out-$LABEL"
cp "$RUN" "$WORK/out-$LABEL/runner.log" 2>/dev/null
cp -r "$HOME_DIR"/machines "$WORK/out-$LABEL/machines" 2>/dev/null
curl -s --max-time 30 -H "Authorization: Bearer $TOKEN" -H "X-Server-Id: $SID" \
  "$BASE_URL/api/messages/channel/$CID" > "$WORK/out-$LABEL/messages.json"

python3 - "$WORK/out-$LABEL" "$LABEL" <<'PY'
import collections, glob, json, os, sys
out, label = sys.argv[1], sys.argv[2]
routed = collections.Counter(); outcomes = collections.Counter()
for f in glob.glob(os.path.join(out, "machines", "*", "traces", "*.jsonl")):
    for line in open(f):
        line = line.strip()
        if not line:
            continue
        try:
            x = json.loads(line)
        except Exception:
            continue
        n, a = x.get("name", ""), x.get("attrs") or {}
        if n in ("daemon.agent.delivery.routed", "daemon.agent.delivery"):
            outcomes[(n, a.get("outcome"))] += 1
        if n == "daemon.agent.delivery.routed":
            routed[a.get("messageId") or ""] += 1
print(f"=== drill {label}: delivery summary ===")
print(f"distinct messageIds routed : {len(routed)}")
print(f"routed more than once      : {[m[:8] for m, c in routed.items() if c > 1] or 'none'}")
try:
    d = json.load(open(os.path.join(out, "messages.json")))
    m = d if isinstance(d, list) else d.get("messages", [])
    users = [x for x in m if "user" in str(x.get("senderType", "")).lower()]
    agents = [str(x.get("content"))[:60] for x in m if "agent" in str(x.get("senderType", "")).lower()]
    print(f"messages                   : user={len(users)} agent={len(agents)}")
    if agents:
        print(f"agent reply                : {agents[0]!r}")
except Exception as e:
    print("messages.json unreadable:", e)
for (n, o), c in sorted(outcomes.items(), key=lambda i: -i[1]):
    print(f"  {c:>3}  {n}  [{o}]")
PY
drill::log "evidence in $WORK/out-$LABEL"

# ------------------------------------------------------- server-side cleanup --
curl -s --max-time 30 -X POST  "$BASE_URL/api/agents/$AID/stop"   -H "Authorization: Bearer $TOKEN" -H "X-Server-Id: $SID" >/dev/null 2>&1
sleep 2
curl -s --max-time 30 -X DELETE "$BASE_URL/api/agents/$AID"        -H "Authorization: Bearer $TOKEN" -H "X-Server-Id: $SID" >/dev/null 2>&1
curl -s --max-time 30 -X DELETE "$BASE_URL/api/channels/$CID"      -H "Authorization: Bearer $TOKEN" -H "X-Server-Id: $SID" >/dev/null 2>&1
curl -s --max-time 30 -X DELETE "$BASE_URL/api/servers/$SID"      -H "Authorization: Bearer $TOKEN" -H "X-Server-Id: $SID" >/dev/null 2>&1
drill::log "drill server objects deleted"