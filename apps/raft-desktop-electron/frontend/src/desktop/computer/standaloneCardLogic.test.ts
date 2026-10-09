import assert from "node:assert/strict";
import test from "node:test";
import { deriveStandaloneCard, friendlyStandaloneError, type StandaloneState } from "./standaloneCardLogic.ts";

const base: StandaloneState = { phase: "running", error: null, upgradeAvailable: false, bundledAvailable: true, status: { agentCount: 3, servers: [{ daemonState: "online" }, { daemonState: "offline" }], service: { version: "1.0.29" } } };
const ids = (state: StandaloneState | null) => deriveStandaloneCard(state).actions.map((a) => a.id);

test("loading: no actions yet", () => {
  assert.deepEqual(deriveStandaloneCard(null).actions, []);
});

test("not installed: offers the bundled install, or nothing when the app carries no Computer", () => {
  assert.deepEqual(ids({ ...base, phase: "not_installed", status: null }), ["install"]);
  assert.equal(deriveStandaloneCard({ ...base, phase: "not_installed", status: null }).title, "Not installed", "short: the narrow sidebar truncates long titles");
  assert.deepEqual(ids({ ...base, phase: "not_installed", status: null, bundledAvailable: false }), []);
  assert.match(deriveStandaloneCard({ ...base, phase: "not_installed", status: null, bundledAvailable: false }).detail ?? "", /raft-computer/);
});

test("a deliberate Stop reads as stopped (idle), not as an error; an unexpected stop is a warning with the reason", () => {
  const byUser = deriveStandaloneCard({ ...base, phase: "stopped_by_user" });
  assert.deepEqual([byUser.tone, byUser.title, byUser.actions.map((a) => a.id)], ["idle", "Stopped", ["start"]]);
  assert.match(byUser.detail ?? "", /until you start it/);
  const crashed = deriveStandaloneCard({ ...base, phase: "stopped", error: "killed" });
  assert.deepEqual([crashed.tone, crashed.detail], ["warn", "killed"]);
});

test("running: counts agents and connected servers; Stop asks first and says quitting the app does not stop agents", () => {
  const running = deriveStandaloneCard(base);
  assert.deepEqual([running.tone, running.detail, running.version], ["ok", "3 agents · 1/2 servers connected", "1.0.29"]);
  const stop = running.actions.find((a) => a.id === "stop");
  assert.match(stop?.confirm ?? "", /Closing this app does not stop them/);
  assert.equal(deriveStandaloneCard({ ...base, status: { agentCount: 1, servers: [{ daemonState: "online" }], service: { version: null } } }).detail, "1 agent · 1/1 server connected");
});

test("an available upgrade is offered when running or stopped, with a confirmation; never while starting", () => {
  const running = deriveStandaloneCard({ ...base, upgradeAvailable: true });
  assert.deepEqual(running.actions.map((a) => a.id), ["upgrade", "stop"]);
  assert.ok(running.actions[0]?.primary && running.actions[0].confirm);
  assert.deepEqual(ids({ ...base, phase: "stopped_by_user", upgradeAvailable: true }), ["start", "upgrade"]);
  assert.deepEqual(ids({ ...base, phase: "starting", upgradeAvailable: true }), []);
});

test("failed and unreachable offer a retry; error text is passed through", () => {
  const failed = deriveStandaloneCard({ ...base, phase: "failed", error: "port busy" });
  assert.deepEqual([failed.tone, failed.detail, failed.actions[0]?.label], ["error", "port busy", "Try again"]);
  assert.deepEqual(ids({ ...base, phase: "unreachable", error: "boom" }), ["refresh"]);
});

test("error messages are shortened for humans", () => {
  assert.match(friendlyStandaloneError("spawn /x ENOENT"), /isn't installed/);
  assert.match(friendlyStandaloneError("Command timed out"), /too long/);
  assert.match(friendlyStandaloneError("weird"), /Couldn't complete/);
});
