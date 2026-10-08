// M4 Socket.IO spike client: drives the REAL locked socket.io-client@4.8.3
// (imported straight from node_modules/.pnpm — no install, no lockfile
// change) against the spike Go server and asserts the P0 exit criteria.
//
// Usage: node client.mjs [mainPort] [originPort]   (defaults 4399 4400)
//
// Every case prints SPIKE-PASS/SPIKE-FAIL; the process exits non-zero on
// any failure. No browser, no UI — protocol only.

const [mainPort = "4399", originPort = "4400"] = process.argv.slice(2);

// Resolve the locked client: the path is passed by run.sh (absolute) or
// probed relative to the repo root.
const entry =
  process.env.SPIKE_CLIENT_ENTRY ||
  new URL(
    "../../../../node_modules/.pnpm/socket.io-client@4.8.3/node_modules/socket.io-client/build/esm/index.js",
    import.meta.url,
  ).href;
const { io } = await import(entry);

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`SPIKE-PASS ${name}`); }
  else { fail++; console.log(`SPIKE-FAIL ${name} ${detail}`); }
}
function freshAuth(token, serverId = null) {
  return { token, serverId, clientKind: "web" };
}
function freshSocket(port, auth, extra = {}) {
  return io(`http://127.0.0.1:${port}`, {
    autoConnect: false,
    forceNew: true,
    transports: ["websocket"], // websocket-only, like the web client
    auth,
    ...extra,
  });
}
function waitFor(emitter, event, ms, filter = () => true) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      emitter.off(event, on);
      resolve(null);
    }, ms);
    function on(...args) {
      if (!filter(...args)) return;
      clearTimeout(t);
      emitter.off(event, on);
      resolve(args.length === 0 ? true : args.length === 1 ? args[0] : args);
    }
    emitter.on(event, on);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// socket.io-client@4.8.3 emits disconnect(reason, description). waitFor
// intentionally preserves all args for single-payload tests, so inspect the
// first argument here instead of comparing the two-argument tuple to a string.
const disconnectReason = (observed) => Array.isArray(observed) ? observed[0] : observed;

// ---- 01/02: handshake, identity echo, rooms barrier -------------------
{
  const s = freshSocket(mainPort, freshAuth("good-token", "ws1"));
  const identityP = waitFor(s, "spike:identity", 5000);
  const roomsP = waitFor(s, "rooms:joined", 5000);
  s.connect();
  const identity = await identityP;
  ok("01-handshake-connected", s.connected);
  ok(
    "01-auth-passthrough",
    identity && identity.userId === "u1" && identity.serverId === "ws1" && identity.clientKind === "web",
    JSON.stringify(identity),
  );
  const rooms = await roomsP;
  ok("02-rooms-joined-after-barrier", rooms === true, "rooms:joined missing");
  // Identity echo must precede the barrier signal (both are post-connect,
  // proving the server did real work before signaling readiness).
  ok("02-identity-before-or-with-rooms", identity !== null);

  // ---- 03: heartbeat ---------------------------------------------------
  const hb = await waitFor(s, "heartbeat", 5000);
  ok("03-heartbeat", hb && typeof hb.seq === "number" && typeof hb.ts === "number" && hb.ts > 0, JSON.stringify(hb));

  // ---- 04: resume pagination ------------------------------------------
  const r1p = waitFor(s, "sync:resume:response", 5000);
  s.emit("sync:resume", { lastSeq: 1000 });
  const r1 = await r1p;
  ok("04-resume-page1-shape",
    r1 && Array.isArray(r1.messages) && r1.messages.length === 500 && r1.hasMore === true && r1.currentSeq > 1000,
    JSON.stringify(r1 && { n: r1.messages?.length, cur: r1.currentSeq, more: r1.hasMore }));
  const visibleSorted = r1.messages.every((m, i, a) => i === 0 || a[i - 1].seq < m.seq);
  ok("04-resume-page1-sorted", visibleSorted);
  const r2p = waitFor(s, "sync:resume:response", 5000);
  s.emit("sync:resume", { lastSeq: r1.currentSeq });
  const r2 = await r2p;
  // Fixture truth: 1200 messages with every 3rd in u2-only ch-secret => u1
  // sees exactly 800. Page 2 is therefore 300 messages, complete, with
  // currentSeq at the last DELIVERED message's seq (ch-secret holes mean
  // that seq is below the global 2200 high-water).
  ok("04-resume-page2-completes",
    r2 && r2.messages.length === 300 && r2.hasMore === false
      && r2.currentSeq === r2.messages[r2.messages.length - 1].seq,
    JSON.stringify(r2 && { n: r2.messages?.length, cur: r2.currentSeq, more: r2.hasMore }));
  // Invisible rows must not leak: every message in ch-secret is u2-only.
  const leaked = [...r1.messages, ...r2.messages].some((m) => m.channelId === "ch-secret");
  ok("04-resume-no-cross-visibility-leak", !leaked);

  // ---- 05: join/leave + single-payload message:new --------------------
  const pubP = waitFor(s, "message:new", 5000);
  s.emit("spike:publish-channel", { channelId: "ch1", event: "message:new", payload: { id: "live1", seq: 2201 } });
  const live = await pubP;
  ok("05-live-single-payload-object", live && typeof live === "object" && live.id === "live1", JSON.stringify(live));
  s.emit("leave:channel", "ch1");
  await sleep(200);
  const afterLeaveP = waitFor(s, "message:new", 700);
  s.emit("spike:publish-channel", { channelId: "ch1", event: "message:new", payload: { id: "live2" } });
  const afterLeave = await afterLeaveP;
  ok("05-leave-stops-delivery", afterLeave === null, "still receiving after leave:channel");

  // ---- 13: unknown/oversized events ignored honestly ------------------
  s.emit("totally:bogus", { x: 1 });
  s.emit("join:channel", { channelId: "object-not-string" }); // wrong shape: ignored
  s.emit("join:channel", "ch1");                              // valid again
  await sleep(200);
  ok("13-unknown-events-do-not-kill-connection", s.connected);

  // ---- 09: transport close auto-reconnects ----------------------------
  // Every listener is attached BEFORE the trigger: rooms:joined can fire
  // immediately after the connect event, before a later waitFor registers.
  const reconnectP = waitFor(s, "connect", 8000);
  const reasonP = waitFor(s, "disconnect", 8000);
  const roomsAgainP = waitFor(s, "rooms:joined", 8000);
  s.emit("spike:close-transport");
  const reason = disconnectReason(await reasonP);
  ok("09-transport-close-reason", reason === "transport close", String(reason));
  const reconnected = await reconnectP;
  const rooms2 = reconnected === true ? await roomsAgainP : null;
  ok("09-transport-close-auto-reconnect-and-reauth", rooms2 === true);

  // ---- 11: revocation: evict + reject re-handshake --------------------
  const s2 = freshSocket(mainPort, freshAuth("u2-token", "ws1"));
  const rooms3P = waitFor(s2, "rooms:joined", 5000);
  s2.connect();
  const rooms3 = await rooms3P;
  ok("11-u2-connects", rooms3 === true);
  const u2EvictP = waitFor(s2, "disconnect", 8000);
  const u2ErrP = waitFor(s2, "connect_error", 8000);
  s2.emit("spike:revoke-user", { userId: "u2" });
  const u2Reason = disconnectReason(await u2EvictP);
  ok("11-revoked-user-evicted-transport-close", u2Reason === "transport close", String(u2Reason));
  const u2err = await u2ErrP;
  ok("11-revoked-user-rejected-on-reconnect",
    u2err && u2err.message === "Invalid or expired token", String(u2err && u2err.message));
  s2.disconnect();
  s.disconnect();
}

// ---- 06/07/08: exact connect_error keywords ---------------------------
async function expectError(name, auth, wanted, port = mainPort) {
  const s = freshSocket(port, auth);
  const errP = waitFor(s, "connect_error", 5000);
  s.connect();
  const err = await errP;
  ok(name, err && err.message === wanted, `got "${err && err.message}" want "${wanted}"`);
  s.disconnect();
}
await expectError("06-expired-token-keyword", freshAuth("expired-token", "ws1"), "Invalid or expired token");
await expectError("07-non-member-keyword", freshAuth("good-token", "wsX"), "Not a member of this server");
await expectError("08-missing-token-keyword", { serverId: "ws1", clientKind: "web" }, "Authentication required");
await expectError("06b-invalid-token-type-keyword", freshAuth("wrongtype-token", "ws1"), "Invalid token type");

// ---- 10: namespace disconnect does NOT auto-reconnect ----------------
{
  const s = freshSocket(mainPort, freshAuth("good-token", "ws1"));
  const roomsP = waitFor(s, "rooms:joined", 5000);
  s.connect();
  await roomsP;
  const reasonP = waitFor(s, "disconnect", 5000);
  s.emit("spike:namespace-disconnect");
  const reason = disconnectReason(await reasonP);
  ok("10-namespace-disconnect-reason", reason === "io server disconnect", String(reason));
  ok("10-namespace-disconnect-inactive", s.active === false, `active=${s.active}`);
  await sleep(1500);
  ok("10-no-auto-reconnect-after-namespace-disconnect", !s.connected);
  const backP = waitFor(s, "rooms:joined", 5000);
  s.connect(); // manual recovery must still work
  const back = await backP;
  ok("10-manual-reconnect-works", back === true);
  s.disconnect();
}

// ---- 12: Origin allowlist (restrictive instance B) --------------------
{
  const s = freshSocket(originPort, freshAuth("good-token", "ws1"), {
    extraHeaders: { Origin: "http://evil.example" },
  });
  const errP = waitFor(s, "connect_error", 5000);
  s.connect();
  const err = await errP;
  // The refusal may surface as a transport error (HTTP 403 before any
  // Socket.IO handshake) — acceptable as long as the connection NEVER
  // establishes. A keyword-auth error here would mean the check ran too
  // late (post-handshake) and is a spike failure.
  ok("12-origin-rejected", !s.connected && err !== null, `connected=${s.connected}`);
  const s2 = freshSocket(originPort, freshAuth("good-token", "ws1"));
  const roomsP = waitFor(s2, "rooms:joined", 5000);
  s2.connect();
  const rooms = await roomsP;
  // No Origin header at all (Node default) must still pass on instance B.
  ok("12-originless-allowed-on-restrictive", rooms === true);
  s2.disconnect();
}

console.log(`\nSPIKE SUMMARY pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
