/**
 * Restart-caller classification for `raft-computer restart` (upstream task
 * #829/#1202 final shape).
 *
 * A restart asked for from a person's own terminal is a stop followed by a
 * start from that terminal (runCallerStopThenStart in cli.ts). A caller that
 * runs inside an agent process spawned by a runner must NOT stop the service
 * itself — stopping it tears down the caller's own runner — so for those the
 * restart stays an IPC handoff where the old service launches its own
 * replacement. `callerIsRunnerHosted` detects that caller kind from the env
 * the daemon sets on every agent child.
 */

/** Set by the daemon on every agent child it spawns; see agentProcessManager. */
export const RUNNER_HOSTED_AGENT_ENV_VAR = "SLOCK_AGENT_ID";

export function callerIsRunnerHosted(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[RUNNER_HOSTED_AGENT_ENV_VAR];
  return typeof value === "string" && value.length > 0;
}
