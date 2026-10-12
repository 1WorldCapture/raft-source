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