// #desktop-data-cache S1 (#12) and S3 (#14): server support for client caches.
// - sync:resume honours the plan history window, like GET /messages/sync.
// - GET /servers exposes each server's messageHistoryDays / historyCutoff.
import assert from "node:assert/strict";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { createApiTest } from "../test/integration/apiTest.js";
import { signAccessToken } from "../middleware/auth.js";
import { messages, servers } from "../db/schema.js";

const test = createApiTest({ onboardingOpenerFlagDefaultEnabled: false });

function waitPacket(ws: WebSocket, packets: string[], predicate: (p: string) => boolean, label: string) {
  if (packets.some(predicate)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error(`No packet: ${label}`)); }, 8000);
    function clean() { clearTimeout(timer); ws.off("message", onMessage); ws.off("close", onClose); }
    function onMessage(data: WebSocket.RawData) { if (predicate(data.toString())) { clean(); resolve(); } }
    function onClose() { clean(); reject(new Error(`Socket closed before: ${label}`)); }
    ws.on("message", onMessage);
    ws.on("close", onClose);
  });
}

function rawSocket(base: string, auth: Record<string, unknown>) {
  const ws = new WebSocket(`${base.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`);
  const packets: string[] = [];
  ws.on("message", (data) => {
    const p = data.toString();
    packets.push(p);
    if (p.startsWith("0")) ws.send(`40${JSON.stringify(auth)}`);
  });
  return { ws, packets };
}

async function closeSocket(ws: WebSocket) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, "close");
  ws.close();
  await closed;
}

async function resumeContents(baseUrl: string, userId: string, serverId: string, lastSeq: number) {
  const { ws, packets } = rawSocket(baseUrl, { token: signAccessToken(userId), serverId });
  try {
    await waitPacket(ws, packets, (p) => p.includes('"rooms:joined"'), "rooms:joined");
    ws.send(`42${JSON.stringify(["sync:resume", { lastSeq }])}`);
    await waitPacket(ws, packets, (p) => p.includes('"sync:resume:response"'), "resume response");
    const response = packets.find((p) => p.includes('"sync:resume:response"'))!;
    return (JSON.parse(response.slice(2))[1].messages as Array<{ content: string }>).map((m) => m.content);
  } finally {
    await closeSocket(ws);
  }
}

test("sync:resume applies the plan history window: free plans never replay messages older than 30 days", async ({ app, seed, db }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const sentinel = await seed.message({ channel, author: owner, content: "sentinel" });
  const old = await seed.message({ channel, author: owner, content: "OLD-BEYOND-WINDOW" });
  await seed.message({ channel, author: owner, content: "FRESH-IN-WINDOW" });
  // Age one message past the free plan's 30-day window.
  await db.update(messages).set({ createdAt: new Date(Date.now() - 40 * 86_400_000) }).where(eq(messages.id, old.id));

  const freeContents = await resumeContents(app.baseUrl, owner.id, server.id, sentinel.seq);
  assert.ok(freeContents.includes("FRESH-IN-WINDOW"), `fresh message missing: ${JSON.stringify(freeContents)}`);
  assert.equal(freeContents.includes("OLD-BEYOND-WINDOW"), false, "free plan must not replay messages beyond the history window");

  await db.update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  const proContents = await resumeContents(app.baseUrl, owner.id, server.id, sentinel.seq);
  assert.ok(proContents.includes("OLD-BEYOND-WINDOW"), "unlimited plans replay everything after the cursor");
});

test("GET /servers exposes each server's messageHistoryDays and historyCutoff", async ({ app, seed, db, http }) => {
  const owner = await seed.human();
  const free = await seed.server({ owner });
  const pro = await seed.server({ owner });
  await db.update(servers).set({ plan: "pro" }).where(eq(servers.id, pro.id));

  const res = await http.as(owner, free).request("/api/servers", { method: "GET" });
  assert.equal(res.status, 200, await res.clone().text());
  const rows = await res.json() as Array<{ id: string; messageHistoryDays: number; historyCutoff: string | null }>;
  const freeRow = rows.find((row) => row.id === free.id)!;
  const proRow = rows.find((row) => row.id === pro.id)!;
  assert.equal(freeRow.messageHistoryDays, 30);
  assert.ok(freeRow.historyCutoff, "free plan has a cutoff");
  const ageDays = (Date.now() - Date.parse(freeRow.historyCutoff!)) / 86_400_000;
  assert.ok(ageDays > 29.9 && ageDays < 30.1, `cutoff about 30 days ago, got ${ageDays}`);
  assert.equal(proRow.messageHistoryDays, -1);
  assert.equal(proRow.historyCutoff, null);
});
