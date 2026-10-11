import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CAS_WAKE_CRASH_LOOP_LUA,
  decodeWakeCrashLoopState,
  encodeWakeCrashLoopState,
  wakeCrashLoopKey,
} from "../replicaRouter.js";
import {
  freshWakeCrashLoopEpisode,
  type WakeCrashLoopEpisodeState,
} from "./wakeCrashLoopBreaker.js";

/** The Redis carrier half of the upstream 1.21.2 wake crash-loop port. */

test("wakeCrashLoopKey namespaces per agent", () => {
  assert.equal(wakeCrashLoopKey("agent-1"), "slock:agent:agent-1:wake_crash_loop");
  assert.notEqual(wakeCrashLoopKey("agent-1"), wakeCrashLoopKey("agent-2"));
});

test("encode/decode round-trips a whole episode", () => {
  const state: WakeCrashLoopEpisodeState = {
    ...freshWakeCrashLoopEpisode(4),
    earlyExitCount: 2,
    blocked: true,
    blockedAtMs: 123,
    lastStartAtMs: 100,
    lastStartLaunchId: "launch-9",
    lastStartCounted: true,
    firstExitAtMs: 110,
    lastExitAtMs: 120,
    lastExitKind: "agent_process_exited",
    lastSignal: "SIGTERM",
    lastLaunchId: "launch-9",
    needsActionReason: "model unavailable",
    catchupOwed: true,
    catchupCarriedLaunchId: "launch-9",
  };
  const decoded = decodeWakeCrashLoopState(encodeWakeCrashLoopState(state));
  assert.ok(decoded);
  assert.deepEqual(decoded.state, state);
  assert.deepEqual(decoded.repaired, []);
});

test("decode repairs missing optional fields and names them, and honours a damaged blocked record", () => {
  // A record from before the optional fields existed: absent is legal.
  const legacy = {
    episode: 2,
    earlyExitCount: 1,
    blocked: true,
    blockedAtMs: 50,
    lastStartAtMs: 10,
    lastStartLaunchId: "l1",
    lastStartCounted: true,
    firstExitAtMs: 20,
    lastExitAtMs: 30,
    lastExitKind: "agent_process_exited",
    lastSignal: "SIGKILL",
    lastLaunchId: "l1",
  };
  const decodedLegacy = decodeWakeCrashLoopState(JSON.stringify(legacy));
  assert.ok(decodedLegacy);
  assert.equal(decodedLegacy.state.blocked, true, "blocked is always honoured");
  assert.equal(decodedLegacy.state.needsActionReason, null);
  assert.equal(decodedLegacy.state.catchupOwed, false);

  // Wrong-typed fields are repaired to neutral, and the damage is named.
  const damaged = { ...legacy, lastSignal: 42, blockedAtMs: "soon" };
  const decodedDamaged = decodeWakeCrashLoopState(JSON.stringify(damaged));
  assert.ok(decodedDamaged);
  assert.equal(decodedDamaged.state.blocked, true);
  assert.equal(decodedDamaged.state.lastSignal, null);
  assert.equal(decodedDamaged.state.blockedAtMs, null);
  assert.ok(decodedDamaged.repaired.includes("lastSignal"));
  assert.ok(decodedDamaged.repaired.includes("blockedAtMs"));

  // An UNBLOCKED record with broken counters carries nothing: null.
  assert.equal(decodeWakeCrashLoopState(JSON.stringify({ blocked: false, episode: "x" })), null);
  // Non-JSON / non-string: null.
  assert.equal(decodeWakeCrashLoopState("not json"), null);
  assert.equal(decodeWakeCrashLoopState(42), null);
});

test("the CAS Lua only writes when the stored version matches", () => {
  assert.match(CAS_WAKE_CRASH_LOOP_LUA, /HGET.*version/);
  assert.match(CAS_WAKE_CRASH_LOOP_LUA, /if current ~= ARGV\[1\] then return 0 end/);
  assert.match(CAS_WAKE_CRASH_LOOP_LUA, /EXPIRE/);
  assert.match(CAS_WAKE_CRASH_LOOP_LUA, /PERSIST/);
});
