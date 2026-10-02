import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { wakePayloadSchema } from "@botiverse/raft-shared";
import type { z } from "zod";
import { getDb, type Database } from "../db/index.js";
import { externalAgentConnections as connections } from "../db/schema.js";
import { ExternalAgentDelegationService } from "./externalAgentDelegationService.js";
import { DISPATCH_DEADLINE_MS, type DispatchResult } from "./externalAgentDispatchPolicy.js";

export type WakePayload = z.infer<typeof wakePayloadSchema>;
export interface WakeAdapter {
  // Phase A has no production transport registration or secret access.
  readonly mode: "fake";
  deliver(payload: WakePayload, signal: AbortSignal): Promise<DispatchResult>;
}
export type WorkerResult = { agentId: string; kind: "attempted" | "idle" | "unsupported" | "unavailable"; attemptId?: string };

export class ExternalAgentDelegationWorker {
  private readonly service: ExternalAgentDelegationService;
  private readonly owner = `delegation-${randomUUID()}`;
  private cursor: string | undefined;
  private running: Promise<WorkerResult[]> | undefined;
  private loop: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private cleanupFailed = false;
  private readonly adapters: ReadonlyMap<string, WakeAdapter>;

  constructor(private readonly db: Database = getDb(), adapters: ReadonlyMap<string, WakeAdapter> = new Map(),
    private readonly options: { serverId?: string; pageSize?: number; concurrency?: number; deadlineMs?: number; jitter?: () => number; onTick?: (results: readonly WorkerResult[]) => void } = {}) {
    this.adapters = new Map(adapters);
    for (const adapter of this.adapters.values()) if (adapter.mode !== "fake") throw new Error("production adapter not supported in Phase A");
    if (options.concurrency !== undefined && (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16)) throw new Error("invalid concurrency");
    if (options.pageSize !== undefined && (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 200)) throw new Error("invalid page size");
    if (options.deadlineMs !== undefined && (!Number.isInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > DISPATCH_DEADLINE_MS)) throw new Error("invalid deadline");
    this.service = new ExternalAgentDelegationService(db);
  }

  // One bounded page; concurrent local ticks share the same execution.
  runOnce(signal = new AbortController().signal): Promise<WorkerResult[]> {
    if (this.cleanupFailed) return Promise.reject(new Error("adapter cleanup incomplete"));
    if (this.running) return this.running;
    this.running = this.page(signal).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async page(signal: AbortSignal): Promise<WorkerResult[]> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      return tx.select({ id: connections.id, agentId: connections.agentId, serverId: connections.serverId, activation: connections.activation })
      .from(connections).where(and(eq(connections.consumptionMode, "delegated"), this.options.serverId ? eq(connections.serverId, this.options.serverId) : undefined, this.cursor ? gt(connections.id, this.cursor) : undefined))
      .orderBy(asc(connections.id)).limit(this.options.pageSize ?? 50);
    });
    if (!rows.length) { this.cursor = undefined; return []; }
    const results: WorkerResult[] = [];
    let position = 0;
    await Promise.all(Array.from({ length: Math.min(this.options.concurrency ?? 4, rows.length) }, async () => {
      while (position < rows.length && !signal.aborted && !this.cleanupFailed) {
        const row = rows[position++];
        this.cursor = row.id;
        try {
          await this.service.reconcileConnection(row.serverId, row.agentId);
          const adapter = row.activation.strategy === "proxy_delegation" ? this.adapters.get(row.activation.delivery.adapter) : undefined;
          if (!adapter) { results.push({ agentId: row.agentId, kind: "unsupported" }); continue; }
          if (signal.aborted) break;
          const reservation = await this.service.reserveDispatch(row.serverId, row.agentId, this.owner);
          if (!reservation) { results.push({ agentId: row.agentId, kind: "idle" }); continue; }
          const delivery = await this.dispatch(adapter, reservation.payload, signal);
          if (delivery.cleanupFailed) this.cleanupFailed = true;
          await this.service.completeDispatch(row.serverId, row.agentId, reservation, delivery.result, this.options.jitter?.() ?? Math.random());
          if (delivery.cleanupFailed) throw new Error("adapter cleanup incomplete");
          results.push({ agentId: row.agentId, kind: "attempted", attemptId: reservation.attemptId });
        } catch {
          // All sibling tasks still join before a lifecycle failure is reported.
          // Exception text may contain private configuration; return only a category.
          // Already reserved attempts remain recoverable by lease expiry.
          results.push({ agentId: row.agentId, kind: "unavailable" });
        }
      }
    }));
    if (this.cleanupFailed) throw new Error("adapter cleanup incomplete");
    return results;
  }

  private async dispatch(adapter: WakeAdapter, payload: WakePayload, outer: AbortSignal): Promise<{ result: DispatchResult; cleanupFailed: boolean }> {
    const controller = new AbortController();
    let finishAbort!: (result: DispatchResult) => void;
    const aborted = new Promise<DispatchResult>((resolve) => { finishAbort = resolve; });
    const cancel = (reason: "worker_cancelled" | "deadline_exceeded") => {
      finishAbort({ kind: "unknown", reason });
      controller.abort();
    };
    const onAbort = () => cancel("worker_cancelled");
    outer.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => cancel("deadline_exceeded"), this.options.deadlineMs ?? DISPATCH_DEADLINE_MS);
    try {
      if (outer.aborted) { onAbort(); return { result: await aborted, cleanupFailed: false }; }
      // Observe rejection even when timeout wins; late results cannot touch DB.
      const delivered = Promise.resolve().then(() => adapter.deliver(wakePayloadSchema.parse(payload), controller.signal))
        .catch((): DispatchResult => ({ kind: "unknown", reason: "adapter_failure" }));
      const result = await Promise.race([delivered, aborted]);
      if (!controller.signal.aborted) return { result, cleanupFailed: false };
      // A cancellation signal is not proof that a callback's work has ended.
      // Audit unknown first, and fail the lifecycle if cooperative cleanup stalls.
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const clean = await Promise.race([delivered.then(() => true), new Promise<boolean>((resolve) => {
          cleanupTimer = setTimeout(() => resolve(false), 1000);
        })]);
        return { result, cleanupFailed: !clean };
      } finally { clearTimeout(cleanupTimer); }
    } finally { clearTimeout(timer); outer.removeEventListener("abort", onAbort); }
  }

  start(intervalMs = 1000): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 60000) throw new Error("invalid worker interval");
    if (this.loop) return;
    const controller = this.controller = new AbortController();
    this.loop = (async () => {
      while (!controller.signal.aborted) {
        const results = await this.runOnce(controller.signal);
        this.options.onTick?.(results);
        try { await delay(intervalMs, undefined, { signal: controller.signal }); }
        catch { if (!controller.signal.aborted) throw new Error("worker timer failed"); }
      }
    })();
    // Capture failure immediately; stop still reports it to the lifecycle owner.
    void this.loop.catch(() => {});
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    try { await this.loop; await this.running; if (this.cleanupFailed) throw new Error("adapter cleanup incomplete"); }
    finally { this.loop = undefined; this.controller = undefined; }
  }
}
