# `scripts/drill/` — isolated drill / observation guards

Guards for running an isolated daemon + Computer against a live server without
touching anything that belongs to the machine's owner.

They exist because of two mistakes that produced *confident numbers from an
unverified environment*:

1. **A `dist/` can be stale while its `package.json` version still matches the
   release.** Version and provenance are different questions. During the 0.2.4
   duplicate-delivery observation, `packages/computer/dist` was a build from
   before several shipped changes; the version number looked correct, so the
   run would have quietly mixed versions. Builds now bake their commit
   (`scripts/build-provenance.mjs`), so a dist can be *asked* which commit it
   came from.
2. **A drill can leave residue in the owner's account.** `raft-computer start`
   registers a `build.raft.computer.login.*` LaunchAgent in the *real*
   `~/Library/LaunchAgents` regardless of `RAFT_HOME`. It is removed on
   teardown, but it exists for the whole run. A login item survived long enough
   to be noticed by someone else.

## Rules these enforce

| Guard | Rule |
| --- | --- |
| `drill::require_clean_tree` | Refuse to switch refs on a dirty tree. Never lose work. **No environment bypass** — a bypass here means overwriting in-progress work. |
| `drill::restore_ref_trap` | Put the worker's ref back on EXIT/INT/TERM, so a killed drill can't leave the tree detached. |
| `drill::rebuild_at_ref` | Rebuild shared **+** daemon **+** computer at an exact commit. |
| `drill::assert_dist_provenance` | A dist must carry the expected baked commit. **A version number is not accepted as identity.** |
| `drill::fingerprint` | Content hash, independent of any version string. |
| `drill::snapshot_launchagents` / `drill::diff_launchagents` | Snapshot the owner's LaunchAgents before, and **prove they are restored** after. |
| `drill::remove_tmp_loginitems` | Remove **only** `/tmp`-rooted login items; warn loudly about anything else and leave it alone. |
| `drill::kill_pid_tree` | Kill by pid tree. Relative-path cmdlines (`node packages/computer/dist/…`) are the case an absolute-only `pkill` silently misses. |
| `drill::assert_tailscale_endpoint` | Only tailnet (`*.ts.net`) or loopback endpoints. Our environments are reached over tailscale, never the public `*.1wc.io` names — where a local proxy can cut TLS mid-handshake and the resulting failure is indistinguishable from a real server fault. Bypass is possible via `RAFT_DRILL_ALLOW_ANY_ENDPOINT=1` but **warns loudly**. |

Every guard **fails loudly**. A drill whose identity or isolation cannot be
proven is worse than no drill.

## Running the Desktop app against an isolated root

Bringing the Computer up on a scratch root is the fiddliest part of a drill, and
most of the traps look like product bugs. They are not.

### Order matters: prepare the root BEFORE the app starts

The Computer can only converge if the root already has a **user session** and a
**server attachment**. Do them first, from the CLI, then launch the app:

```bash
# with HOME + RAFT_HOME + SLOCK_HOME all pointing at the scratch root
raft-computer attach /<slug> --server-url "$BASE_URL" --no-start
raft-computer doctor          # attach + preflight green, service still stopped
# only now launch the app
```

If the root has no session and no attachment, the app's Computer page offers
`Start`, and pressing it can fail with
`HOST_LIFECYCLE_LAST_KNOWN_GOOD_UNVERIFIED` — a *last-known-good carrier*
complaint that is really a missing-prerequisite symptom.

**Do not run `raft-computer start` before the app.** It writes a `cli` owner
record into the root, and you can no longer tell which code path brought the
Computer up. On a prepared root the app starts it by itself and the page shows
`Restart`/`Stop` instead of `Start`.

### The app's default server is not 8443

A fresh `userData` has no server configured, so the app logs in against its
default server. With a 8443-only test account that surfaces as
**"email or password incorrect"** — which reads like bad credentials and is not.
Point it at 8443 explicitly before logging in:

```bash
# write to a temp file, then rename — otherwise a relaunch can race the write
printf '{\n  "origin": "https://<host>.ts.net:8443",\n  "generation": 2,\n  "updatedAt": "%s"\n}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ROOT/userData/server-origin.json.tmp"
mv "$ROOT/userData/server-origin.json.tmp" "$ROOT/userData/server-origin.json"
cat "$ROOT/userData/server-origin.json"   # CONFIRM it landed…
# …then restart the app, so it re-reads the origin.
```

**Do not relaunch in the same breath as the write.** Relaunching before the
origin is durably on disk races it: the app starts against the old (or no)
server and the login comes back **401**, which reads as a credential problem
rather than a timing one. Reproduced independently on 2026-10-12; the second
attempt, after confirming the file was written, worked. **Verify the file
before you relaunch** — a re-read is enough, no need to trust the exit status.

### Every raft-computer call needs all three home variables

`HOME` alone is **not** enough. Without `RAFT_HOME` and `SLOCK_HOME` it reads the
operator's real `~/.slock` and cheerfully reports *that* as healthy — a passing
`doctor` that says nothing about your root. Always check the `Using state at …`
line names the root you meant.

### Capture the owner record on BOTH sides of the click

`computer/host-lifecycle-owner.json` is cheap to snapshot and impossible to
recover later. If it is read only *after* a failure you cannot tell whether the
record was `cli` at the moment of the throw and got rewritten to `app`
afterwards — which is exactly the ambiguity that left one 0.2.5 investigation
open. Snapshot before you click, snapshot after, and diff.

### Archive the evidence BEFORE you delete the root

`--cleanup` removes the whole staging root, and the evidence lives inside it.
Copy anything you intend to argue from to a durable location **first** — Anna's
0.2.6 root B run archived its 7 screenshots under
`notes/drill-logs/<root>/` *before* teardown; an earlier run of mine deleted the
root with its evidence still inside, leaving only quoted text in the thread.

Worth keeping, at minimum: the owner record snapshots from both sides of the
click, the app/service log tails, and the exact command output a verdict rests
on. Sanity-check it before deleting: **is every claim I am about to make still
backed by a file that exists?**

### Deleting the disposable server does NOT delete its `computers` row

Confirmed on 8443 (2026-10-12): after `DELETE /api/servers/<id>` returns
`{"ok":true}` and `/api/servers` lists nothing, the machine's **attach row in
`computers` survives**. One drill root was left behind on 8443 this way, and the
machine had accumulated 26 historical rows from earlier drills.

So `POST /api/servers` in the setup needs a matching **explicit row cleanup** in
teardown — otherwise every drill permanently adds a machine row. Verify it, do
not assume the cascade: re-query and confirm the row is gone, and say so in the
report if it cannot be removed.

### Traces do not upload from an isolated root

An isolated home has no trace-ingest credentials, so the Computer logs trace
upload 401s. That is expected there, not a fault to chase — but it means
**trace-based observation does not work inside a drill**. Collect what you need
from local state and log files instead.

## What is still unexplained

A 0.2.5 drill saw the app's `Start` fail with
`HOST_LIFECYCLE_LAST_KNOWN_GOOD_UNVERIFIED`. On 0.2.6 with a prepared root it
did **not** reproduce, and `host-lifecycle-owner.json` came out byte-identical
before and after — so the owner record's *shape* is not the trigger. The exact
trigger in that 0.2.5 run is **unknown**; the difference in outcomes coincided
with the root having (or lacking) a session and attachment, but that was never
isolated to the single variable.

**Do not record it as "caused by missing prerequisites."** If it reappears on a
real install, capture the owner record immediately before the click and the app
log after the `converge:` line — those two artefacts are the whole reason this
section exists.

`services/start.ts` and `services/stop.ts` call `convergeCliHostLifecycle` for
owner `app` as well; it works only because of that early return. Recorded as
fragile, deliberately **not** changed.

## Shell traps that cost real time here

- `ditto src dst` where `dst` **does not exist** makes `dst` *become* the copy.
  Create the destination directory first, or pass the full `…/Name.app` path.
- `set -e` aborts **before** `$?` is read when a command fails, so a check whose
  *expected* result is a non-zero exit needs `set +e` around it.
- `ps … | grep "$ROOT"` matches the checking script's own command line when the
  root path appears in it, and can SIGTERM the script doing the cleanup. Filter
  the grep out (`grep -v grep`) or match on a narrower pattern.
- An apostrophe inside `${var:?message}` (`May's`) is parsed as a quote
  delimiter and the whole script fails to parse.

## Why it builds in your worktree instead of a separate `git worktree`

This is a real trade-off, not an oversight.

A separate worktree avoids touching your checkout entirely, which is
attractive. But it needs its **own `pnpm install`**: pnpm resolves workspace
packages through symlinks, so symlinking the existing `node_modules` into the
worktree makes the build compile **the original tree's sources** — the "isolated"
build would silently be the operator's checkout, defeating the point. A genuine
worktree install costs minutes and needs the registry/cache.

So isolation here comes from **refusing a dirty tree and guaranteeing the ref is
restored**, not from a second checkout. `restore_ref_trap` covers the interrupt
paths, and if restoration ever fails it prints the exact `git checkout` command
to recover. If a worktree-based mode is wanted later, it belongs behind an
explicit flag that also runs `pnpm install` in the worktree.

## Usage

```bash
REPO=/path/to/raft-source
WORK=/tmp/my-drill

# prove the environment
scripts/drill/preflight.sh "$REPO" <commit-or-HEAD> "$WORK"

# ... run the drill, then always:
RAFT_DRILL_HOMES=/tmp/my-drill/home-1 scripts/drill/postflight.sh "$REPO" "$WORK" \
  'packages/computer/dist/raft-computer.js __service'
```

`postflight.sh` should run from an `EXIT` trap so it runs even when the drill
fails — a failed drill still leaves residue.

Verify the guards themselves:

```bash
scripts/drill/selftest.sh     # 16 checks, including the failure paths
```

## Credentials

**Nothing here reads, writes, or stores a credential.** Callers pass secrets
through the environment (`RAFT_TEST_EMAIL`, `RAFT_TEST_PASSWORD`, …), take them
from a DM at the moment of use, and hand them back for rotation when done.
Never commit a credential, and never accept a version string as a substitute
for verifying what is actually installed.