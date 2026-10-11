import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import { program, runRestartCommand, type RestartCommandDeps } from "./cli.js";

test("CLI lifecycle contract: ordinary command surface excludes destructive and reversal-only verbs", () => {
  const commands = program.commands.map((cmd) => cmd.name());
  assert.ok(!commands.includes("detach"), "ordinary CLI must not expose detach");
  assert.ok(!commands.includes("revoke"), "ordinary CLI must not expose destructive revoke");
  assert.ok(!commands.includes("delete"), "ordinary CLI must not expose destructive delete");
  assert.ok(!commands.includes("switch"), "ordinary CLI must not expose regret-state switch");
});

test("CLI lifecycle contract: verb table documents the four-axis invariant", async () => {
  const src = await readFile(new URL("./cli.ts", import.meta.url), "utf8");
  assert.match(src, /Lifecycle contract \(task #151 P0\)/);
  assert.match(src, /Axis 1: process actual state/);
  assert.match(src, /Axis 2: local desired policy/);
  assert.match(src, /Axis 3: local credential proof/);
  assert.match(src, /Axis 4: server identity/);
  assert.match(src, /Names are\s+\*\s+display labels only, never identity proof/s);
  assert.match(src, /old user-facing `detach`\s+\*\s+command and implementation are intentionally absent/s);
});

test("CLI lifecycle contract: detach implementation is absent from ordinary package surface", async () => {
  const [serviceSrc, apiSrc, eventSrc, indexSrc] = await Promise.all([
    readFile(new URL("./service.ts", import.meta.url), "utf8"),
    readFile(new URL("./lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("./lib/events.ts", import.meta.url), "utf8"),
    readFile(new URL("./cli.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(serviceSrc, /\brunDetach\b/);
  assert.doesNotMatch(apiSrc, /services\/detach/);
  assert.doesNotMatch(apiSrc, /\bdetach\s*\(/);
  assert.doesNotMatch(eventSrc, /"detach\./);
  assert.doesNotMatch(indexSrc, /\.command\("detach"\)/);
});

test("CLI restart command delegates to runRestartCommand; the agent-hosted path records one restart operation", async () => {
  const src = await readFile(new URL("./cli.ts", import.meta.url), "utf8");
  const restartStart = src.indexOf('.command("restart")');
  const restartEnd = src.indexOf("// --- status", restartStart);
  const restartBlock = src.slice(restartStart, restartEnd);

  assert.match(src, /recordRestartIntent\(plan, runtime\)/);
  assert.match(src, /prepareLifecycle\(plan\.slockHome, "restart", plan\.targets\)/);
  assert.match(restartBlock, /runRestartCommand\(serverSlug, opts, signal\)/);
  assert.doesNotMatch(restartBlock, /\brunStop\(/);
});

const LIVE_SERVICE = {
  pid: 4242,
  pidfilePath: "/tmp/raft-home/computer/run/service.pid",
  firstStalePidfile: null,
  firstStalePid: null,
};

// Upstream task #1202: a user whose service could not resolve DNS after a new
// macOS login session recovered only with `stop` then `start` from the new
// session; `restart`, which had the old service launch its own replacement,
// did not help. From a person's terminal, restart is now exactly that stop
// then start.
test("CLI restart from a person's terminal with a live service stops then starts from the caller", async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async () => {
      calls.push("list");
      return ["server-a", "server-b"];
    },
    prepareLocalLifecycleOperations: async () => {
      throw new Error("stop and start record their own lifecycle steps");
    },
    findLiveServicePidReadOnly: async () => {
      calls.push("find");
      return LIVE_SERVICE;
    },
    callerIsRunnerHosted: () => false,
    runStop: async (stopDeps) => {
      assert.equal(stopDeps?.signal, signal);
      calls.push(`stop:${stopDeps?.hostLifecycleOwner}`);
    },
    runStart: async (opts, runtimeDeps) => {
      assert.ok(opts);
      assert.equal(runtimeDeps?.signal, signal);
      calls.push(`start:${opts.serverId}:${opts.serverLabel}:${opts.foreground}:${opts.recordLifecycleIntent}:${opts.hostLifecycleOwner}`);
    },
    prepareTargetsForServiceHandoff: async () => {
      throw new Error("a terminal restart must not hand off inside the old service");
    },
    requestServiceRestartViaIpc: async () => {
      throw new Error("a terminal restart must not ask the old service to launch its replacement");
    },
    info: (line: string) => {
      calls.push(`info:${line}`);
    },
    fail: (code: string, message: string): never => {
      throw new Error(`fail:${code}:${message}`);
    },
  } satisfies RestartCommandDeps;

  await runRestartCommand(undefined, {}, signal, deps);

  assert.deepEqual(calls, [
    "list",
    "find",
    "info:Restarting from this terminal: stopping the service (pid 4242), then starting it again.",
    "stop:cli",
    "start:null:null:undefined:undefined:cli",
  ]);
});

test("CLI restart from a terminal starts nothing when the stop does not finish", async () => {
  let started = false;
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async () => ["server-a"],
    findLiveServicePidReadOnly: async () => LIVE_SERVICE,
    callerIsRunnerHosted: () => false,
    runStop: async () => {
      throw new Error("STOP_TIMEOUT: service did not exit");
    },
    runStart: async () => {
      started = true;
    },
    info: () => {},
  } satisfies RestartCommandDeps;

  await assert.rejects(
    runRestartCommand(undefined, {}, new AbortController().signal, deps),
    /STOP_TIMEOUT/,
  );
  assert.equal(started, false, "a failed stop must never be followed by a second service");
});

test("CLI restart --foreground from a terminal stops then starts in the foreground, on every platform", async () => {
  const calls: string[] = [];
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async () => ["server-a"],
    findLiveServicePidReadOnly: async () => LIVE_SERVICE,
    callerIsRunnerHosted: () => false,
    runStop: async () => {
      calls.push("stop");
    },
    runStart: async (opts) => {
      calls.push(`start:${opts?.foreground}`);
    },
    info: () => {},
    fail: (code: string, message: string): never => {
      throw new Error(`${code}:${message}`);
    },
  } satisfies RestartCommandDeps;

  await runRestartCommand(undefined, { foreground: true }, new AbortController().signal, deps);
  assert.deepEqual(calls, ["stop", "start:true"]);
});

test("CLI restart from inside an agent process requests the IPC handoff and never stops or starts from the caller", async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async (slockHome: string) => {
      calls.push(`list:${slockHome}`);
      return ["server-a", "server-b"];
    },
    prepareLocalLifecycleOperations: async (
      slockHome: string,
      action: "start" | "stop" | "restart" | "upgrade",
      targets: string[],
    ) => {
      calls.push(`intent:${slockHome}:${action}:${targets.join(",")}`);
      return [];
    },
    findLiveServicePidReadOnly: async (slockHome: string) => {
      calls.push(`find:${slockHome}`);
      return LIVE_SERVICE;
    },
    prepareTargetsForServiceHandoff: async (
      slockHome: string,
      targets: string[],
      actualSignal: AbortSignal,
    ) => {
      assert.equal(actualSignal, signal);
      calls.push(`prepare:${slockHome}:${targets.join(",")}`);
    },
    requestServiceRestartViaIpc: async (slockHome: string) => {
      calls.push(`ipc:${slockHome}`);
      return { status: "accepted" as const };
    },
    runStop: async () => {
      calls.push("forbidden-stop");
    },
    runStart: async () => {
      calls.push("forbidden-start");
    },
    callerIsRunnerHosted: () => true,
    info: (line: string) => {
      calls.push(`info:${line}`);
    },
    fail: (code: string, message: string): never => {
      throw new Error(`fail:${code}:${message}`);
    },
  } satisfies RestartCommandDeps;

  await runRestartCommand(undefined, {}, signal, deps);

  assert.deepEqual(calls, [
    "list:/tmp/raft-home",
    "find:/tmp/raft-home",
    "intent:/tmp/raft-home:restart:server-a,server-b",
    "prepare:/tmp/raft-home:server-a,server-b",
    "ipc:/tmp/raft-home",
    "info:Service restart requested (pid 4242); replacement service will take over without relying on this shell.",
    "info:Running inside an agent process: not waiting for runners to reconnect. Check with `raft-computer status`.",
  ]);
});

test("CLI restart cold-boot path remains start-only and preserves scoped target", async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    resolveTargetServerId: async (opts: { server?: string | null }) => {
      assert.equal(typeof opts.server, "string");
      calls.push(`resolve:${opts.server}`);
      return "server-a";
    },
    listAttachedServerIds: async () => {
      throw new Error("must not list attached servers for scoped restart");
    },
    prepareLocalLifecycleOperations: async (
      slockHome: string,
      action: "start" | "stop" | "restart" | "upgrade",
      targets: string[],
    ) => {
      calls.push(`intent:${slockHome}:${action}:${targets.join(",")}`);
      return [];
    },
    findLiveServicePidReadOnly: async (slockHome: string) => {
      calls.push(`find:${slockHome}`);
      return { ...LIVE_SERVICE, pid: null };
    },
    callerIsRunnerHosted: () => false,
    runStop: async () => {
      throw new Error("nothing to stop when no service is live");
    },
    runStart: async (opts, runtimeDeps) => {
      assert.ok(opts);
      assert.equal(runtimeDeps?.signal, signal);
      calls.push(
        `start:${opts.serverId}:${opts.serverLabel}:${opts.foreground}:${opts.recordLifecycleIntent}:${opts.hostLifecycleOwner}`,
      );
    },
    prepareTargetsForServiceHandoff: async () => {
      throw new Error("must not prepare service handoff when no service is live");
    },
    requestServiceRestartViaIpc: async () => {
      throw new Error("must not call IPC when no service is live");
    },
  } satisfies RestartCommandDeps;

  await runRestartCommand("/alpha", { foreground: true }, signal, deps);

  assert.deepEqual(calls, [
    "resolve:/alpha",
    "find:/tmp/raft-home",
    "intent:/tmp/raft-home:restart:server-a",
    "start:server-a:/alpha:true:false:cli",
  ]);
});

test("CLI restart agent-hosted path fails loud when IPC handoff is unavailable", async () => {
  const signal = new AbortController().signal;
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async () => ["server-a"],
    prepareLocalLifecycleOperations: async () => [],
    findLiveServicePidReadOnly: async () => LIVE_SERVICE,
    callerIsRunnerHosted: () => true,
    runStop: async () => {
      throw new Error("forbidden-stop");
    },
    runStart: async () => {
      throw new Error("forbidden-start");
    },
    prepareTargetsForServiceHandoff: async () => undefined,
    requestServiceRestartViaIpc: async () => {
      throw new Error("socket unavailable");
    },
    fail: (code: string, message: string): never => {
      throw new Error(`${code}:${message}`);
    },
  } satisfies RestartCommandDeps;

  await assert.rejects(
    runRestartCommand(undefined, {}, signal, deps),
    /RESTART_SERVICE_UNREACHABLE:Cannot restart the live Computer service via IPC \(socket unavailable\)/,
  );
});
