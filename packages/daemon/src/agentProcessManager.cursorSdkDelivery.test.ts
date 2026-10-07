import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type {
  AgentConfig,
  AgentMessage,
  MachineToServerMessage,
} from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager.js";
import { installDaemonFetchMockForTests } from "./daemonFetch.js";
import { buildCliSystemPrompt } from "./drivers/systemPrompt.js";
import type {
  ParsedEvent,
  RuntimeDriver,
  RuntimeExitInfo,
  RuntimeSendResult,
  RuntimeSession,
  SpawnContext,
} from "./drivers/index.js";

/**
 * Focused APM delivery-outcome integration tests (cursor-sdk attempt
 * protocol). A fake SDK runtime session records every send input — including
 * the optional `attemptId` — and lets the test emit `delivery_outcome`,
 * `turn_end`, `text` and `session_init` events exactly like the cursor-sdk
 * adapter will. These tests pin the APM side of the contract:
 *
 * - synchronous `accepted` remains queue-only; the APM owns attempt
 *   watermarks and attaches ids only for protocol drivers;
 * - `deferred_to_idle` (native revert) restores ONLY the still-unread debt of
 *   that attempt — no wholesale contribution wipe, no re-notify of previously
 *   delivered messages, no runtime-error UI, no compaction interrupt;
 * - busy steering is held after a revert until a true idle turn boundary;
 * - `unknown` is retained safely until the terminal boundary;
 * - stale / duplicate / rolled-over outcomes are discarded;
 * - non-protocol drivers are byte-for-byte unchanged (no attemptId input).
 */

type RecordedSend = {
  phase: "start" | "send";
  mode?: "idle" | "busy";
  text: string;
  sessionId?: string | null;
  attemptId?: string;
};

class FakeCursorSdkRuntimeSession implements RuntimeSession {
  readonly descriptor: RuntimeSession["descriptor"] = {
    transport: "child_process",
    lifecycle: "sdk_session",
    stdout: { channel: "structured_protocol" },
    input: { initial: "request", idle: "sdk_prompt", busy: "sdk_steer" },
    readiness: "sdk_ready",
    turnBoundary: "sdk_event",
    startPolicy: "immediate",
    inFlightWake: "steer",
    busyDelivery: "direct",
    postTurn: "keep_alive",
  };
  readonly pid = undefined;
  readonly currentSessionId: string | null = null;
  readonly currentRuntimeHomeDir: string | null = null;
  readonly exitCode: number | null = null;
  readonly signalCode: NodeJS.Signals | null = null;
  readonly closed = false;
  readonly sends: RecordedSend[] = [];
  private readonly events = new EventEmitter();

  isAlive(): boolean | undefined {
    return undefined;
  }

  on(event: "runtime_event", cb: (event: ParsedEvent) => void): void;
  on(event: "stdout", cb: (text: string) => void): void;
  on(event: "stderr", cb: (text: string) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
  on(event: "exit" | "close", cb: (info: RuntimeExitInfo) => void): void;
  on(
    event: "runtime_event" | "stdout" | "stderr" | "error" | "exit" | "close",
    cb: ((event: ParsedEvent) => void) | ((text: string) => void) | ((error: Error) => void) | ((info: RuntimeExitInfo) => void),
  ): void {
    this.events.on(event, cb as (...args: unknown[]) => void);
  }

  async start(input: { text: string; sessionId?: string | null }): Promise<RuntimeSendResult> {
    this.sends.push({ phase: "start", text: input.text, sessionId: input.sessionId ?? null });
    return { ok: true, acceptedAs: "prompt" };
  }

  send(input: {
    mode: "idle" | "busy";
    text: string;
    sessionId?: string | null;
    attemptId?: string;
  }): RuntimeSendResult {
    this.sends.push({
      phase: "send",
      mode: input.mode,
      text: input.text,
      sessionId: input.sessionId ?? null,
      attemptId: input.attemptId,
    });
    return { ok: true, acceptedAs: input.mode === "busy" ? "steer" : "prompt" };
  }

  async stop(): Promise<void> {}

  /** Test seam: emit a parsed runtime event through the APM subscription. */
  emitParsed(event: ParsedEvent): void {
    this.events.emit("runtime_event", event);
  }
}

class FakeCursorSdkDriver implements RuntimeDriver {
  readonly id = "cursor-sdk";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = { detectedModelsVerifiedAs: "suggestion_only" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly deliveryOutcomeAttempts: boolean;
  readonly sessions: FakeCursorSdkRuntimeSession[] = [];

  constructor(opts: { deliveryOutcomeAttempts?: boolean } = {}) {
    this.deliveryOutcomeAttempts = opts.deliveryOutcomeAttempts ?? true;
  }

  createSession(_ctx: SpawnContext): RuntimeSession {
    const session = new FakeCursorSdkRuntimeSession();
    this.sessions.push(session);
    return session;
  }

  spawn(): never {
    throw new Error("cursor-sdk fake driver must be driven through createSession");
  }

  parseLine(): ParsedEvent[] {
    return [];
  }

  encodeStdinMessage(): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig): ReturnType<RuntimeDriver["buildSystemPrompt"]> {
    return buildCliSystemPrompt(config, {
      extraCriticalRules: ["- Do NOT bypass the `raft` CLI with shell commands or custom scripts."],
    });
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "cursor-sdk-agent",
    displayName: "Cursor SDK Agent",
    description: "test agent",
    model: "default",
    runtime: "cursor-sdk",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "sk_machine_test",
    ...overrides,
  };
}

function makeMessage(content: string, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "richard",
    sender_type: "human",
    content,
    timestamp: "2026-10-05T10:00:00.000Z",
    ...overrides,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function withCursorSdkManager(
  fn: (ctx: {
    driver: FakeCursorSdkDriver;
    session: FakeCursorSdkRuntimeSession;
    manager: AgentProcessManager;
    sent: MachineToServerMessage[];
  }) => Promise<void>,
  options: { deliveryOutcomeAttempts?: boolean } = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-cursor-sdk-apm-test-"));
  const sent: MachineToServerMessage[] = [];
  const driver = new FakeCursorSdkDriver({ deliveryOutcomeAttempts: options.deliveryOutcomeAttempts });
  let credentialSeq = 0;
  const restoreFetch = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      credentialSeq += 1;
      return new Response(JSON.stringify({
        apiKey: `sk_agent_test_${credentialSeq}`,
        credentialId: `cred-test-${credentialSeq}`,
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch);
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    {
      dataDir,
      serverUrl: "https://daemon.example.com",
      slockHome: dataDir,
      driverResolver: () => driver,
      stdinNotificationRetryMs: 60_000,
    },
  );
  try {
    await manager.startAgent("agent-1", makeConfig({ sessionId: "session-1" }));
    const session = driver.sessions[0]!;
    await fn({ driver, session, manager, sent });
  } finally {
    for (const ap of (manager as any).agents?.values?.() ?? []) {
      ap.notifications.clearTimer();
      if (ap.sessionReadyDeliveryRetry?.kind === "scheduled") ap.sessionReadyDeliveryRetry.scheduler.clearTimer();
      if (ap.pendingTrajectory?.timer) clearTimeout(ap.pendingTrajectory.timer);
      if (ap.startup?.kind === "waiting" && ap.startup.timer) clearTimeout(ap.startup.timer);
      if (ap.compaction?.kind === "active" && ap.compaction.watchdog) clearTimeout(ap.compaction.watchdog);
    }
    (manager as any).agents?.clear?.();
    restoreFetch();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function agentProcess(manager: AgentProcessManager): any {
  return (manager as any).agents.get("agent-1");
}

function busySends(session: FakeCursorSdkRuntimeSession): RecordedSend[] {
  return session.sends.filter((send) => send.phase === "send" && send.mode === "busy");
}

function idleSends(session: FakeCursorSdkRuntimeSession): RecordedSend[] {
  return session.sends.filter((send) => send.phase === "send" && send.mode === "idle");
}

function errorActivities(sent: MachineToServerMessage[]): MachineToServerMessage[] {
  return sent.filter((msg) =>
    msg.type === "agent:activity" && (msg as any).activityKind === "error",
  );
}

test("deferred revert restores only still-unread attempt debt and holds busy steering until true idle", async () => {
  await withCursorSdkManager(async ({ session, manager, sent }) => {
    const ap = agentProcess(manager);
    assert.ok(ap);
    assert.equal(ap.driver.deliveryOutcomeAttempts, true);

    // The spawn/start path never carries an attemptId (start success path normal).
    assert.equal(session.sends[0]?.phase, "start");
    assert.equal(session.sends[0]?.attemptId, undefined);

    // Establish a busy turn with runtime progress.
    session.emitParsed({ kind: "text", text: "working on the first turn" });
    await flush();

    // An earlier notice that WAS delivered stays contributed forever.
    const deliveredMessage = makeMessage("previously delivered message", { message_id: "msg-delivered", seq: 101 });
    manager.deliverMessage("agent-1", deliveredMessage);
    (manager as any).sendStdinNotification("agent-1");
    const deliveredNotice = busySends(session).at(-1)!;
    assert.ok(deliveredNotice.attemptId, "busy notice for a protocol driver carries an attemptId");
    const deliveredAttemptId = deliveredNotice.attemptId!;
    assert.equal(ap.notifications.hasContributedMessage(deliveredMessage, "session-1"), true);

    session.emitParsed({
      kind: "delivery_outcome",
      source: "cursor_sdk",
      attemptId: deliveredAttemptId,
      outcome: "delivered",
    });
    await flush();
    assert.equal(ap.notifications.hasContributedMessage(deliveredMessage, "session-1"), true);
    assert.equal(ap.notifications.pendingCount, 0);

    // A later attempt covers two messages; one of them is consumed before revert.
    const messageA = makeMessage("still unread at revert", { message_id: "msg-a", seq: 102 });
    const messageB = makeMessage("consumed before revert", { message_id: "msg-b", seq: 103 });
    manager.deliverMessage("agent-1", messageA);
    manager.deliverMessage("agent-1", messageB);
    const sendsBeforeDeferredAttempt = busySends(session).length;
    (manager as any).sendStdinNotification("agent-1");
    const deferredNotice = busySends(session).at(-1)!;
    assert.equal(busySends(session).length, sendsBeforeDeferredAttempt + 1);
    const deferredAttemptId = deferredNotice.attemptId!;
    assert.notEqual(deferredAttemptId, deliveredAttemptId);
    assert.equal(ap.notifications.hasContributedMessage(messageA, "session-1"), true);
    assert.equal(ap.notifications.hasContributedMessage(messageB, "session-1"), true);

    // The runtime visibly consumes message B (echoed into the conversation).
    (manager as any).consumeVisibleMessages("agent-1", {
      messages: [messageB],
      source: "agent_api_events_local",
    });
    assert.equal(ap.inbox.some((m: AgentMessage) => m.message_id === "msg-b"), false);

    // Native revert: deferred_to_idle. NOT a runtime error.
    session.emitParsed({
      kind: "delivery_outcome",
      source: "cursor_sdk",
      attemptId: deferredAttemptId,
      outcome: "deferred_to_idle",
    });
    await flush();

    // Only the still-unread attempt member (A) is restored as debt.
    assert.equal(ap.notifications.pendingCount, 1, "exactly one restored debt for the still-unread member");
    assert.equal(ap.notifications.hasContributedMessage(messageA, "session-1"), false, "reverted member is re-deliverable");
    assert.equal(
      ap.notifications.hasContributedMessage(deliveredMessage, "session-1"),
      true,
      "previously delivered message must NOT be re-notified",
    );
    // No error UI, no idle claim, busy hold armed.
    assert.equal(errorActivities(sent).length, 0, "normal revert must not be surfaced as a runtime error");
    assert.equal(ap.gatedSteering.isIdle, false);
    assert.equal(ap.deliveryAttempts.shouldSuppressBusyDelivery(), true);

    // New work while held: queues, no busy steer.
    const messageD = makeMessage("arrives while steering is held", { message_id: "msg-d", seq: 104 });
    manager.deliverMessage("agent-1", messageD);
    const sendCountBeforeHold = session.sends.length;
    session.emitParsed({ kind: "text", text: "still working" });
    (manager as any).sendStdinNotification("agent-1");
    await flush();
    assert.equal(session.sends.length, sendCountBeforeHold, "busy steering stays held after revert");
    assert.equal(ap.notifications.pendingCount, 2);

    // True idle boundary releases the hold and re-delivers only A and D.
    session.emitParsed({ kind: "turn_end", sessionId: "session-1" });
    await flush();

    assert.equal(ap.deliveryAttempts.shouldSuppressBusyDelivery(), false);
    const idleDeliveries = idleSends(session);
    assert.equal(idleDeliveries.length, 1, "exactly one idle delivery at the turn boundary");
    const idleDelivery = idleDeliveries[0]!;
    assert.ok(idleDelivery.attemptId, "idle re-delivery carries a fresh attemptId");
    assert.match(idleDelivery.text, /\[Raft inbox notice:/);
    assert.match(idleDelivery.text, /msg=msg-a/, "still-unread reverted member is re-notified by identity");
    assert.match(idleDelivery.text, /msg=msg-d/, "message held during the revert window is delivered");
    assert.doesNotMatch(idleDelivery.text, /msg-delivered/, "previously delivered message is not re-notified");
    assert.doesNotMatch(idleDelivery.text, /msg-b/, "consumed member is not re-notified");
    assert.equal(
      ap.inbox.some((m: AgentMessage) => m.message_id === "msg-delivered"),
      true,
      "previously delivered notice row stays pending until the model reads it",
    );
  });
});

test("delivered settles the watermark; duplicate, unallocated and rolled-over outcomes are discarded", async () => {
  await withCursorSdkManager(async ({ session, manager }) => {
    const ap = agentProcess(manager);
    session.emitParsed({ kind: "text", text: "busy turn" });
    await flush();

    const messageA = makeMessage("settled as delivered", { message_id: "msg-a2", seq: 201 });
    manager.deliverMessage("agent-1", messageA);
    (manager as any).sendStdinNotification("agent-1");
    const attemptOne = busySends(session).at(-1)!.attemptId!;

    session.emitParsed({ kind: "delivery_outcome", source: "cursor_sdk", attemptId: attemptOne, outcome: "delivered" });
    await flush();
    assert.equal(ap.notifications.pendingCount, 0);
    assert.equal(ap.notifications.hasContributedMessage(messageA, "session-1"), true);

    // Duplicate outcome for the same attempt: discarded, state unchanged.
    session.emitParsed({ kind: "delivery_outcome", source: "cursor_sdk", attemptId: attemptOne, outcome: "deferred_to_idle" });
    await flush();
    assert.equal(ap.notifications.pendingCount, 0, "duplicate must not restore debt");
    assert.equal(ap.notifications.hasContributedMessage(messageA, "session-1"), true);
    assert.equal(ap.deliveryAttempts.shouldSuppressBusyDelivery(), false, "duplicate must not arm the busy hold");

    // Never-allocated attempt id: discarded.
    session.emitParsed({ kind: "delivery_outcome", source: "cursor_sdk", attemptId: "999", outcome: "unknown" });
    await flush();
    assert.equal(ap.deliveryAttempts.retainedUnknownCount, 0);
    assert.equal(ap.notifications.pendingCount, 0);

    // Rolled-over session: an attempt recorded under session-1 settles as stale
    // under session-2 — no restore, no busy hold in the new session.
    const messageB = makeMessage("rolled over attempt", { message_id: "msg-b2", seq: 202 });
    manager.deliverMessage("agent-1", messageB);
    (manager as any).sendStdinNotification("agent-1");
    const rolledAttemptId = busySends(session).at(-1)!.attemptId!;
    assert.equal(ap.notifications.hasContributedMessage(messageB, "session-1"), true);

    session.emitParsed({ kind: "session_init", sessionId: "session-2" });
    await flush();
    assert.equal(ap.sessionId, "session-2");

    session.emitParsed({ kind: "delivery_outcome", source: "cursor_sdk", attemptId: rolledAttemptId, outcome: "deferred_to_idle" });
    await flush();
    assert.equal(ap.notifications.pendingCount, 0, "rolled-over revert must not restore debt into the new session");
    assert.equal(ap.deliveryAttempts.shouldSuppressBusyDelivery(), false, "rolled-over revert must not hold busy delivery");
    assert.equal(ap.deliveryAttempts.pendingCount, 0);
  });
});

test("unknown outcome is retained safely and resolved at the terminal turn boundary", async () => {
  await withCursorSdkManager(async ({ session, manager, sent }) => {
    const ap = agentProcess(manager);
    session.emitParsed({ kind: "text", text: "busy turn with ack timeout risk" });
    await flush();

    const messageA = makeMessage("unknown until terminal", { message_id: "msg-u", seq: 301 });
    manager.deliverMessage("agent-1", messageA);
    (manager as any).sendStdinNotification("agent-1");
    const unknownAttemptId = busySends(session).at(-1)!.attemptId!;
    assert.equal(ap.notifications.hasContributedMessage(messageA, "session-1"), true);

    // ACK timeout: unknown. Retained — contribution kept, no debt restored yet.
    session.emitParsed({ kind: "delivery_outcome", source: "cursor_sdk", attemptId: unknownAttemptId, outcome: "unknown" });
    await flush();
    assert.equal(ap.deliveryAttempts.retainedUnknownCount, 1);
    assert.equal(ap.notifications.pendingCount, 0, "unknown must not restore debt immediately");
    assert.equal(ap.notifications.hasContributedMessage(messageA, "session-1"), true, "unknown keeps the contribution memo");
    assert.equal(errorActivities(sent).length, 0);

    // Progress must not double-flush the retained attempt.
    const sendsBeforeTerminal = session.sends.length;
    session.emitParsed({ kind: "text", text: "more progress" });
    await flush();
    assert.equal(session.sends.length, sendsBeforeTerminal);

    // Terminal boundary: retained unknown resolves toward re-delivery.
    session.emitParsed({ kind: "turn_end", sessionId: "session-1" });
    await flush();
    assert.equal(ap.deliveryAttempts.retainedUnknownCount, 0);
    const idleDeliveries = idleSends(session);
    assert.equal(idleDeliveries.length, 1);
    assert.match(idleDeliveries[0]!.text, /\[Raft inbox notice:/);
    assert.match(idleDeliveries[0]!.text, /msg=msg-u/, "retained-unknown member is re-notified by identity");
    assert.ok(idleDeliveries[0]!.attemptId);
    assert.equal(ap.deliveryAttempts.pendingCount, 1, "the re-delivery attempt awaits its own outcome");
  });
});

test("ack-pending idle delivery keeps the APM busy: no second send until a terminal boundary", async () => {
  await withCursorSdkManager(async ({ session, manager }) => {
    const ap = agentProcess(manager);
    session.emitParsed({ kind: "turn_end", sessionId: "session-1" });
    await flush();
    assert.equal(ap.gatedSteering.isIdle, true);

    const messageOne = makeMessage("first idle delivery", { message_id: "msg-i1", seq: 401 });
    assert.equal(manager.deliverMessage("agent-1", messageOne), true);
    const idleDeliveries = idleSends(session);
    assert.equal(idleDeliveries.length, 1);
    const ackPendingAttemptId = idleDeliveries[0]!.attemptId!;
    assert.ok(ackPendingAttemptId);
    assert.equal(ap.gatedSteering.isIdle, false, "ACK-pending is not idle");

    // Second message while the first attempt is ACK-pending: queued only.
    const messageTwo = makeMessage("queued behind ack", { message_id: "msg-i2", seq: 402 });
    assert.equal(manager.deliverMessage("agent-1", messageTwo), true);
    await flush();
    assert.equal(idleSends(session).length, 1, "no second send while ACK-pending");
    assert.equal(busySends(session).length, 0);
    assert.equal(ap.inbox.some((m: AgentMessage) => m.message_id === "msg-i2"), true);

    // The APM is the sole follow-up owner: a delivered outcome alone never
    // triggers an automatic follow-up send.
    session.emitParsed({ kind: "delivery_outcome", source: "cursor_sdk", attemptId: ackPendingAttemptId, outcome: "delivered" });
    await flush();
    assert.equal(idleSends(session).length, 1, "delivered outcome must not auto-follow-up");

    session.emitParsed({ kind: "turn_end", sessionId: "session-1" });
    await flush();
    assert.equal(idleSends(session).length, 2);
    assert.match(idleSends(session)[1]!.text, /msg=msg-i2/, "queued message is delivered after the terminal boundary");
    assert.ok(idleSends(session)[1]!.attemptId);
  });
});

test("revert during active compaction is not an interrupt and not an error", async () => {
  await withCursorSdkManager(async ({ session, manager, sent }) => {
    const ap = agentProcess(manager);
    session.emitParsed({ kind: "text", text: "busy turn before compaction" });
    await flush();

    const messageA = makeMessage("reverted during compaction", { message_id: "msg-c", seq: 501 });
    manager.deliverMessage("agent-1", messageA);
    (manager as any).sendStdinNotification("agent-1");
    const attemptId = busySends(session).at(-1)!.attemptId!;

    session.emitParsed({ kind: "compaction_started" });
    await flush();
    assert.equal(ap.gatedSteering.compacting, true);
    assert.equal(ap.compaction.kind, "active");

    session.emitParsed({ kind: "delivery_outcome", source: "cursor_sdk", attemptId, outcome: "deferred_to_idle" });
    await flush();

    assert.equal(ap.gatedSteering.compacting, true, "revert must not interrupt compaction");
    assert.equal(ap.compaction.kind, "active");
    assert.equal(ap.notifications.pendingCount, 1, "debt is still restored under compaction");
    assert.equal(errorActivities(sent).length, 0);
    assert.equal(
      sent.some((msg) =>
        msg.type === "agent:activity" &&
        (msg as any).detailKind === "compaction_finished"
      ),
      false,
      "revert must not emit a compaction finish",
    );

    session.emitParsed({ kind: "compaction_finished" });
    session.emitParsed({ kind: "turn_end", sessionId: "session-1" });
    await flush();
    assert.match(idleSends(session).at(-1)!.text, /msg=msg-c/, "reverted debt is delivered after compaction finishes");
  });
});

test("drivers outside the attempt protocol keep identical sends and discard stray outcomes", async () => {
  await withCursorSdkManager(async ({ session, manager, sent }) => {
    const ap = agentProcess(manager);
    assert.equal(ap.driver.deliveryOutcomeAttempts, false);

    session.emitParsed({ kind: "text", text: "busy turn on a non-protocol driver" });
    await flush();

    const messageA = makeMessage("plain notice", { message_id: "msg-n", seq: 601 });
    manager.deliverMessage("agent-1", messageA);
    (manager as any).sendStdinNotification("agent-1");

    const notice = busySends(session).at(-1)!;
    assert.equal(notice.attemptId, undefined, "non-protocol drivers never receive an attemptId");
    assert.equal(ap.notifications.hasContributedMessage(messageA, "session-1"), true);

    // A stray outcome (malformed cross-driver event) is discarded untouched.
    session.emitParsed({ kind: "delivery_outcome", source: "cursor_sdk", attemptId: "1", outcome: "deferred_to_idle" });
    await flush();
    assert.equal(ap.notifications.pendingCount, 0);
    assert.equal(ap.notifications.hasContributedMessage(messageA, "session-1"), true);
    assert.equal(ap.deliveryAttempts.shouldSuppressBusyDelivery(), false);
    assert.equal(errorActivities(sent).length, 0);
  }, { deliveryOutcomeAttempts: false });
});
