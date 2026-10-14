import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  classifyFeatureFlagRollout,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import {
  featureFlagConfigVersions,
  featureFlagRules,
  featureFlags,
} from "../db/schema.js";
import {
  createFeatureFlagRolloutWriterService,
  type FeatureFlagRolloutActor,
  type FeatureFlagRolloutWriteResult,
} from "./featureFlagRolloutWriterService.js";

const FLAG_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_PLANE_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;

export class FlagRolloutUsageError extends Error {
  readonly code = "FLAG_ROLLOUT_USAGE";

  constructor(message: string) {
    super(message);
    this.name = "FlagRolloutUsageError";
  }
}

export type FlagRolloutCommandName =
  | "show"
  | "server_allowlist_add"
  | "server_allowlist_remove"
  | "kill_switch_set";

export interface FlagRolloutRequest {
  command: FlagRolloutCommandName;
  flagKey: string;
  serverId?: string;
  desiredKillSwitch?: boolean;
  actor?: FeatureFlagRolloutActor;
  reason?: string;
  expectedConfigVersion?: number;
  dryRun: boolean;
  approvedBy?: string;
}

export interface FlagRuleView {
  id: string;
  stage: string;
  priority: number;
  decision: string;
  values: string[];
  percentageBasisPoints: number | null;
  variant: string | null;
}

export interface FlagRolloutShowReport {
  command: "show";
  ok: boolean;
  flagKey: string;
  found: boolean;
  configVersion: number;
  killSwitch: boolean | null;
  defaultEnabled: boolean | null;
  randomizationUnit: string | null;
  rules: FlagRuleView[];
}

export interface FlagRolloutMutationReport {
  command: Exclude<FlagRolloutCommandName, "show">;
  ok: boolean;
  dryRun: boolean;
  wrote: boolean;
  applied: boolean;
  reason: string;
  flagKey: string;
  configVersionBefore: number;
  configVersionAfter: number;
  auditEventId: string | null;
  authorization: "narrowing" | "guardrail_passed" | "operator_approved" | null;
  receiptId: string | null;
  approvedBy: string | null;
  operation: unknown | null;
  requestId: string | null;
  rulesBefore: FlagRuleView[];
  rulesAfter: FlagRuleView[];
}

export type FlagRolloutReport = FlagRolloutShowReport | FlagRolloutMutationReport;

export interface FlagRolloutDependencies {
  controlPlaneId: string;
  requestId?: string;
}

type LoadedFlag = {
  configVersion: number;
  flag: typeof featureFlags.$inferSelect | null;
  rules: FlagRuleView[];
  state: {
    controlPlaneId: string;
    flagKey: string;
    configVersion: number;
    killSwitch: boolean;
    rules: Array<typeof featureFlagRules.$inferSelect>;
  } | null;
};

function usage(message: string): never {
  throw new FlagRolloutUsageError(message);
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) usage(`${flag} requires a value`);
  return value;
}

function requireFlagKey(value: string | undefined): string {
  if (!value || !FLAG_KEY_RE.test(value)) usage("--flag must be a feature flag key");
  return value;
}

function parseExpectedVersion(value: string): number {
  if (!/^\d+$/.test(value)) usage("--expected-version must be a non-negative integer");
  const version = Number(value);
  if (!Number.isSafeInteger(version)) usage("--expected-version is out of range");
  return version;
}

export function parseFlagRolloutArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): FlagRolloutRequest {
  if (!env.DATABASE_URL) usage("DATABASE_URL is required");
  const [command, ...rest] = argv;
  if (
    command !== "show"
    && command !== "server_allowlist_add"
    && command !== "server_allowlist_remove"
    && command !== "kill_switch_set"
  ) {
    usage("command must be show, server_allowlist_add, server_allowlist_remove, or kill_switch_set");
  }

  let flagKey: string | undefined;
  let serverId: string | undefined;
  let desiredKillSwitch: boolean | undefined;
  let actorType: FeatureFlagRolloutActor["type"] | undefined;
  let actorName: string | undefined;
  let reason: string | undefined;
  let expectedConfigVersion: number | undefined;
  let dryRun = false;
  let approvedBy: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    switch (token) {
      case "--flag":
        if (flagKey !== undefined) usage("--flag was provided twice");
        flagKey = requireFlagKey(takeValue(rest, index, token));
        index += 1;
        break;
      case "--server":
        if (serverId !== undefined) usage("pass one --server per invocation");
        serverId = takeValue(rest, index, token);
        if (!UUID_RE.test(serverId)) usage("--server must be a uuid");
        index += 1;
        break;
      case "--desired": {
        const desired = takeValue(rest, index, token);
        if (desired !== "true" && desired !== "false") usage("--desired must be true or false");
        desiredKillSwitch = desired === "true";
        index += 1;
        break;
      }
      case "--actor-type": {
        const actor = takeValue(rest, index, token);
        if (actor !== "human" && actor !== "agent") usage("--actor-type must be human or agent");
        actorType = actor;
        index += 1;
        break;
      }
      case "--actor-name":
        actorName = takeValue(rest, index, token).trim();
        if (actorName.length === 0 || actorName.length > 128) usage("--actor-name must be 1-128 characters");
        index += 1;
        break;
      case "--reason":
        reason = takeValue(rest, index, token).trim();
        if (reason.length === 0) usage("--reason is required");
        index += 1;
        break;
      case "--expected-version":
        if (expectedConfigVersion !== undefined) usage("--expected-version was provided twice");
        expectedConfigVersion = parseExpectedVersion(takeValue(rest, index, token));
        index += 1;
        break;
      case "--receipt-id":
      case "--receipt-file":
        usage("this script does not accept receipts; a widening needs --approved-by");
        break;
      case "--approved-by":
        if (approvedBy !== undefined) usage("--approved-by was provided twice");
        approvedBy = takeValue(rest, index, token).trim();
        if (approvedBy.length === 0 || approvedBy.length > 128) usage("--approved-by must be 1-128 characters");
        index += 1;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        usage(`unknown argument ${token}`);
    }
  }

  flagKey = requireFlagKey(flagKey);
  if (command === "show") {
    if (dryRun || serverId || desiredKillSwitch !== undefined || actorType || actorName || reason || approvedBy || expectedConfigVersion !== undefined) {
      usage("show only accepts --flag");
    }
    return { command, flagKey, dryRun: false };
  }

  if (!actorType || !actorName) usage("--actor-type and --actor-name are required");
  if (!reason) usage("--reason is required");
  if (command === "kill_switch_set") {
    if (desiredKillSwitch === undefined) usage("kill_switch_set requires --desired true or false");
    if (serverId) usage("kill_switch_set does not take --server");
  } else if (!serverId) {
    usage(`${command} requires one --server`);
  } else if (desiredKillSwitch !== undefined) {
    usage(`${command} does not take --desired`);
  }

  return {
    command,
    flagKey,
    serverId,
    desiredKillSwitch,
    actor: { type: actorType, id: actorName },
    reason,
    expectedConfigVersion,
    dryRun,
    approvedBy,
  };
}

function summarizeRule(rule: typeof featureFlagRules.$inferSelect): FlagRuleView {
  return {
    id: rule.id,
    stage: rule.stage,
    priority: rule.priority,
    decision: rule.decision,
    values: Array.isArray(rule.values) ? [...rule.values] : [],
    percentageBasisPoints: rule.percentageBasisPoints,
    variant: rule.variant,
  };
}

async function loadFlagRolloutView(flagKey: string, controlPlaneId: string): Promise<LoadedFlag> {
  const db = getDb();
  const [versionRow] = await db
    .select({ version: featureFlagConfigVersions.version })
    .from(featureFlagConfigVersions)
    .where(eq(featureFlagConfigVersions.scope, "global"));
  const configVersion = versionRow?.version ?? 0;
  const [flag] = await db.select().from(featureFlags).where(eq(featureFlags.key, flagKey)).limit(1);
  if (!flag) return { configVersion, flag: null, rules: [], state: null };
  const rules = await db
    .select()
    .from(featureFlagRules)
    .where(eq(featureFlagRules.flagKey, flagKey))
    .orderBy(asc(featureFlagRules.stage), asc(featureFlagRules.priority), asc(featureFlagRules.id));
  return {
    configVersion,
    flag,
    rules: rules.map(summarizeRule),
    state: {
      controlPlaneId,
      flagKey: flag.key,
      configVersion,
      killSwitch: flag.killSwitch,
      rules,
    },
  };
}

function buildIntent(request: FlagRolloutRequest, configVersion: number): unknown {
  if (request.command === "kill_switch_set") {
    return {
      kind: "kill_switch_set",
      flagKey: request.flagKey,
      expectedConfigVersion: configVersion,
      desired: request.desiredKillSwitch,
    };
  }
  return {
    kind: "server_allowlist_set",
    flagKey: request.flagKey,
    expectedConfigVersion: configVersion,
    serverId: request.serverId,
    desired: request.command === "server_allowlist_add" ? "present" : "absent",
  };
}

function mutationReport(
  request: FlagRolloutRequest,
  fields: {
    ok: boolean;
    wrote: boolean;
    applied: boolean;
    reason: string;
    configVersionBefore: number;
    configVersionAfter: number;
    auditEventId: string | null;
    authorization: FlagRolloutMutationReport["authorization"];
    receiptId: string | null;
    approvedBy: string | null;
    operation: unknown | null;
    requestId: string | null;
    rulesBefore: FlagRuleView[];
    rulesAfter: FlagRuleView[];
  },
): FlagRolloutMutationReport {
  return {
    command: request.command as Exclude<FlagRolloutCommandName, "show">,
    dryRun: request.dryRun,
    flagKey: request.flagKey,
    ...fields,
  };
}

export async function runFlagRollout(
  request: FlagRolloutRequest,
  deps: FlagRolloutDependencies,
): Promise<FlagRolloutReport> {
  if (!CONTROL_PLANE_ID_RE.test(deps.controlPlaneId)) usage("control plane id is invalid");
  const loaded = await loadFlagRolloutView(request.flagKey, deps.controlPlaneId);
  if (request.command === "show") {
    return {
      command: "show",
      ok: loaded.flag !== null,
      flagKey: request.flagKey,
      found: loaded.flag !== null,
      configVersion: loaded.configVersion,
      killSwitch: loaded.flag?.killSwitch ?? null,
      defaultEnabled: loaded.flag?.defaultEnabled ?? null,
      randomizationUnit: loaded.flag?.randomizationUnit ?? null,
      rules: loaded.rules,
    };
  }

  if (!request.actor || !request.reason) usage("a mutation requires an actor and --reason");
  const unchanged = (reason: string, ok: boolean): FlagRolloutMutationReport => mutationReport(request, {
    ok,
    wrote: false,
    applied: false,
    reason,
    configVersionBefore: loaded.configVersion,
    configVersionAfter: loaded.configVersion,
    auditEventId: null,
    authorization: null,
    receiptId: null,
    approvedBy: null,
    operation: null,
    requestId: null,
    rulesBefore: loaded.rules,
    rulesAfter: loaded.rules,
  });

  if (!loaded.flag || !loaded.state) return unchanged("flag_not_found", false);
  if (
    request.expectedConfigVersion !== undefined
    && request.expectedConfigVersion !== loaded.configVersion
  ) {
    return unchanged("config_version_mismatch", false);
  }

  const configVersion = loaded.configVersion;
  const intent = buildIntent(request, configVersion);
  const classification = classifyFeatureFlagRollout(loaded.state, intent);
  const preview = (wrote: false): FlagRolloutMutationReport => {
    if (classification.kind === "blocked") return unchanged(classification.reason, false);
    if (classification.kind === "no_op") return unchanged("no_op", true);
    if (classification.kind === "widening" && !request.approvedBy) {
      return unchanged("operator_approval_required", false);
    }
    const widening = classification.kind === "widening";
    return mutationReport(request, {
      ok: true,
      wrote,
      applied: false,
      reason: widening ? "operator_approved" : "narrowing",
      configVersionBefore: configVersion,
      configVersionAfter: configVersion,
      auditEventId: null,
      authorization: widening ? "operator_approved" : "narrowing",
      receiptId: null,
      approvedBy: widening ? request.approvedBy ?? null : null,
      operation: classification.operation,
      requestId: null,
      rulesBefore: loaded.rules,
      rulesAfter: loaded.rules,
    });
  };
  if (request.dryRun) return preview(false);
  if (classification.kind === "widening" && !request.approvedBy) {
    return unchanged("operator_approval_required", false);
  }

  const requestId = deps.requestId ?? randomUUID();
  const write = createFeatureFlagRolloutWriterService({
    controlPlaneId: deps.controlPlaneId,
    guardrail: {
      loadTrustedReceipt: async () => null,
      nowMs: () => Date.now(),
    },
  });
  const result: FeatureFlagRolloutWriteResult = await write({
    requestId,
    reason: request.reason,
    flagKey: request.flagKey,
    intent,
    operatorApprovedBy: classification.kind === "widening" ? request.approvedBy : undefined,
    actor: request.actor,
  });
  const after = await loadFlagRolloutView(request.flagKey, deps.controlPlaneId);
  if (!result.applied) {
    return mutationReport(request, {
      ok: result.reason === "no_op",
      wrote: false,
      applied: false,
      reason: result.reason,
      configVersionBefore: result.configVersion,
      configVersionAfter: after.configVersion,
      auditEventId: null,
      authorization: null,
      receiptId: null,
      approvedBy: null,
      operation: null,
      requestId,
      rulesBefore: loaded.rules,
      rulesAfter: after.rules,
    });
  }
  return mutationReport(request, {
    ok: true,
    wrote: true,
    applied: true,
    reason: result.reason,
    configVersionBefore: result.configVersionBefore,
    configVersionAfter: result.configVersionAfter,
    auditEventId: result.auditEventId,
    authorization: result.reason,
    receiptId: result.receiptId,
    approvedBy: result.approvedBy,
    operation: result.operation,
    requestId,
    rulesBefore: loaded.rules,
    rulesAfter: after.rules,
  });
}
