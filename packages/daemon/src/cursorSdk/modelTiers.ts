// Cursor SDK model tiers: map the SDK's per-model `parameters`/`variants`
// (@cursor/sdk ModelListItem) onto Raft's existing runtime-config controls.
//
//   - Reasoning strength -> the shared "reasoning effort" dropdown. The effort
//     axis is the first of effort / reasoning_effort / reasoning present on the
//     model that has at least one value Raft can represent.
//   - Fast -> the shared fast-mode switch (`mode.kind === "fast"`), for models
//     that declare a `fast` parameter.
//   - Everything else (context, thinking, cyber, ...) is never sent, so the SDK
//     keeps the model's own defaults.
//
// Raft's persisted effort vocabulary is the closed shared catalog
// (low/medium/high/xhigh/max/ultra). SDK values outside it are either aliased
// (`extra-high` -> `xhigh`) or not offered (`none`, `minimal`). A selection is
// ALWAYS translated back to the model's own original value before it is sent
// (the user picks `xhigh`, the SDK gets that model's `extra-high`).

/** Minimal structural view of a @cursor/sdk `ModelListItem`. */
export interface SdkModelListItem {
  id: string;
  parameters?: ReadonlyArray<{ id: string; values?: ReadonlyArray<{ value: string }> }>;
  variants?: ReadonlyArray<{ params?: ReadonlyArray<{ id: string; value: string }>; isDefault?: boolean }>;
}

export interface SdkModelParam {
  id: string;
  value: string;
}

export interface ModelTiers {
  /** SDK parameter id carrying the reasoning strength (absent: no picker). */
  effortAxis?: string;
  /** Offered efforts: Raft catalog id plus the model's original SDK value. */
  efforts: ReadonlyArray<{ effort: string; sdkValue: string }>;
  /** Catalog id of the default variant's effort, when it is offered. */
  defaultEffort?: string;
  /** The model declares a boolean `fast` parameter. */
  hasFast: boolean;
}

/** Effort-like parameter ids, in priority order. `thinking` is boolean only. */
export const EFFORT_AXIS_IDS = ["effort", "reasoning_effort", "reasoning"] as const;
const FAST_PARAM_ID = "fast";
/** SDK value -> Raft catalog id, for values that differ only by spelling. */
const SDK_EFFORT_ALIASES: Readonly<Record<string, string>> = { "extra-high": "xhigh" };
const CATALOG_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

/** Raft catalog id for an SDK effort value, or null when it is not offered. */
export function catalogEffortForSdkValue(value: string): string | null {
  const mapped = SDK_EFFORT_ALIASES[value] ?? value;
  return CATALOG_EFFORTS.has(mapped) ? mapped : null;
}

export function deriveModelTiers(item: SdkModelListItem): ModelTiers {
  const parameters = item.parameters ?? [];
  const byId = new Map(parameters.map((parameter) => [parameter.id, parameter]));

  let effortAxis: string | undefined;
  const efforts: Array<{ effort: string; sdkValue: string }> = [];
  for (const axisId of EFFORT_AXIS_IDS) {
    const axis = byId.get(axisId);
    if (!axis) continue;
    const seen = new Set<string>();
    const offered: Array<{ effort: string; sdkValue: string }> = [];
    for (const entry of axis.values ?? []) {
      const effort = typeof entry?.value === "string" ? catalogEffortForSdkValue(entry.value) : null;
      if (effort && !seen.has(effort)) {
        seen.add(effort);
        offered.push({ effort, sdkValue: entry.value });
      }
    }
    if (offered.length > 0) {
      effortAxis = axisId;
      efforts.push(...offered);
      break;
    }
  }

  let defaultEffort: string | undefined;
  if (effortAxis) {
    const defaultVariant = (item.variants ?? []).find((variant) => variant.isDefault === true);
    const raw = defaultVariant?.params?.find((param) => param.id === effortAxis)?.value;
    const mapped = typeof raw === "string" ? catalogEffortForSdkValue(raw) : null;
    if (mapped && efforts.some((entry) => entry.effort === mapped)) defaultEffort = mapped;
  }

  const fast = byId.get(FAST_PARAM_ID);
  const fastValues = new Set((fast?.values ?? []).map((entry) => entry?.value));
  const hasFast = fastValues.has("true") && fastValues.has("false");

  return {
    ...(effortAxis ? { effortAxis } : {}),
    efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
    hasFast,
  };
}

/** Fields for Raft's per-model live metadata (RuntimeModelInfo). */
export function modelInfoEffortFields(tiers: ModelTiers): {
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
} {
  if (tiers.efforts.length === 0) return {};
  return {
    supportedReasoningEfforts: tiers.efforts.map((entry) => entry.effort),
    ...(tiers.defaultEffort ? { defaultReasoningEffort: tiers.defaultEffort } : {}),
  };
}

export interface ModelSelection {
  id: string;
  params?: SdkModelParam[];
}

export interface ModelSelectionInput {
  /** Raft catalog effort chosen in the agent config (null/undefined: none). */
  reasoningEffort?: string | null;
  /** The fast-mode switch (`mode.kind === "fast"`). */
  fast?: boolean;
}

/**
 * The ONE place a ModelSelection is built (create, send, resume). With no
 * tier information, or nothing applicable, this is exactly `{ id }` — the
 * behavior before tiers existed. `warn` explains every dropped request.
 */
export function buildModelSelection(
  modelId: string,
  tiers: ModelTiers | null | undefined,
  input: ModelSelectionInput = {},
  warn?: (message: string) => void,
): ModelSelection {
  const params: SdkModelParam[] = [];
  const wantsEffort = typeof input.reasoningEffort === "string" && input.reasoningEffort.length > 0;
  if (wantsEffort) {
    const entry = tiers?.effortAxis
      ? tiers.efforts.find((candidate) => candidate.effort === input.reasoningEffort)
      : undefined;
    if (tiers?.effortAxis && entry) {
      params.push({ id: tiers.effortAxis, value: entry.sdkValue });
    } else {
      warn?.(`cursor-sdk: model "${modelId}" has no reasoning effort "${input.reasoningEffort}" (or tiers are unknown); sending the model without it`);
    }
  }
  if (tiers?.hasFast) {
    // Explicit both ways so the UI switch and the actual run always agree.
    params.push({ id: FAST_PARAM_ID, value: input.fast === true ? "true" : "false" });
  } else if (input.fast === true) {
    warn?.(`cursor-sdk: model "${modelId}" has no fast parameter (or tiers are unknown); ignoring fast mode`);
  }
  return params.length > 0 ? { id: modelId, params } : { id: modelId };
}
