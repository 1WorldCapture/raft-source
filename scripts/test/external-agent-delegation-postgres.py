"""Run delegation concurrency tests in a cluster owned by this invocation."""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile


def postgres_bin() -> Path:
    configured = os.environ.get("RAFT_A2_PG_BIN")
    if configured:
        return Path(configured)
    found = shutil.which("initdb")
    if found:
        return Path(found).parent
    return Path("/opt/homebrew/opt/postgresql@16/bin")


def main() -> int:
    binary = postgres_bin()
    for tool in ("initdb", "pg_ctl"):
        if not (binary / tool).is_file():
            raise RuntimeError(f"PostgreSQL tool missing: {tool}; set RAFT_A2_PG_BIN")
    command = sys.argv[1:] or [
        "pnpm", "--filter", "@botiverse/raft-server", "exec", "vitest", "run",
        "src/services/externalAgentDelegation.realPg.test.ts", "--maxWorkers", "1", "--minWorkers", "1",
    ]
    # Never accept a default DATABASE_URL or reuse an existing cluster.
    with tempfile.TemporaryDirectory(prefix="raft-a2-tests-") as directory:
        root = Path(directory)
        data = root / "data"
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        subprocess.run([str(binary / "initdb"), "-D", str(data), "-U", "a2_test",
                        "--auth-local=trust", "--auth-host=trust", "--no-locale"], check=True, stdout=subprocess.DEVNULL)
        control = [str(binary / "pg_ctl"), "-D", str(data)]
        options = f"-h 127.0.0.1 -p {port} -k {root}"
        try:
            subprocess.run([*control, "-l", str(root / "postgres.log"), "-o", options, "-w", "start"],
                           check=True, stdout=subprocess.DEVNULL)
            env = os.environ.copy()
            env.update({
                "RAFT_HOME": str(root / "state"), "SLOCK_HOME": str(root / "state"),
                "RAFT_DESKTOP_DISABLE_COMPUTER_HOST": "1", "RAFT_DESKTOP_COMPUTER_READONLY": "1",
                "RAFT_A2_REAL_PG_URL": f"postgresql://a2_test@127.0.0.1:{port}/postgres",
                "RAFT_A2_REAL_PG_REQUIRED": "1",
            })
            return subprocess.run(command, env=env, cwd=Path(__file__).resolve().parents[2]).returncode
        finally:
            # Also clean a partly started instance; never send machine-global signals.
            if (data / "postmaster.pid").exists():
                subprocess.run([*control, "-m", "immediate", "-w", "stop"],
                               check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    sys.exit(main())
