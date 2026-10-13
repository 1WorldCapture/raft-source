import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle2, KeyRound, Pencil, Plus, Power, RefreshCw, Send, Trash2, XCircle } from "lucide-react";
import { useIntl } from "react-intl";
import {
  PI_BUILTIN_PROVIDER_DEFAULT_MODELS,
  PI_BUILTIN_PROVIDER_MODELS,
  providerProbeRequestDigest,
} from "@botiverse/raft-shared";
import type {
  ProviderConnectionLatestVerified,
  ProviderConnectionProviderId,
  ProviderConnectionProviderOption,
  ProviderConnectionSummary,
  ProviderProbeCategory,
  ProviderProbeCreatedView,
} from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";
import {
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "raft-ui";
import api from "../../api/client";
import { useProviderConnections } from "../../hooks/useProviderConnections";
import { useMachineStore } from "../../store/machineStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import Button from "../ui/Button";
import Checkbox from "../ui/Checkbox";
import DialogCard from "../ui/DialogCard";
import FormField from "../ui/FormField";
import SectionHeader from "../ui/SectionHeader";
import Spinner from "../ui/Spinner";

const CUSTOM_MODEL_SELECT_VALUE = "__custom__";

function probeCategoryMessageId(category: ProviderProbeCategory): MessageId {
  switch (category) {
    case "auth": return "settings.providers.probeCategory.auth";
    case "model": return "settings.providers.probeCategory.model";
    case "network": return "settings.providers.probeCategory.network";
    case "dns_tls": return "settings.providers.probeCategory.dns_tls";
    case "rate_quota": return "settings.providers.probeCategory.rate_quota";
    case "invalid_response": return "settings.providers.probeCategory.invalid_response";
    case "carrier_offline": return "settings.providers.probeCategory.carrier_offline";
    case "carrier_timeout": return "settings.providers.probeCategory.carrier_timeout";
    case "unsupported_carrier": return "settings.providers.probeCategory.unsupported_carrier";
    case "provider_timeout": return "settings.providers.probeCategory.provider_timeout";
    case "stale_authority": return "settings.providers.probeCategory.stale_authority";
    case "intent_expired": return "settings.providers.probeCategory.intent_expired";
    case "invalid_carrier_result": return "settings.providers.probeCategory.invalid_carrier_result";
  }
}

function labelForProviderId(
  providerId: ProviderConnectionProviderId,
  providerOptions: ProviderConnectionProviderOption[],
): string {
  return providerOptions.find((entry) => entry.id === providerId)?.label ?? providerId;
}

function isGatewayProviderId(
  providerId: ProviderConnectionProviderId,
  providerOptions: ProviderConnectionProviderOption[],
): boolean {
  return providerOptions.find((entry) => entry.id === providerId)?.providerKind === "gateway";
}

function presetTestModels(providerId: ProviderConnectionProviderId): string[] {
  const prefix = `${providerId}/`;
  return (PI_BUILTIN_PROVIDER_MODELS[providerId] ?? []).map((model) => (
    model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id
  ));
}

function defaultTestModel(providerId: ProviderConnectionProviderId): string {
  const value = (PI_BUILTIN_PROVIDER_DEFAULT_MODELS as Partial<Record<ProviderConnectionProviderId, string>>)[providerId];
  const prefix = `${providerId}/`;
  return value?.startsWith(prefix) ? value.slice(prefix.length) : value ?? "";
}

export default function ProviderConnectionsSettings() {
  const { formatMessage } = useIntl();
  const { capabilities } = useServerPermissions();
  const { connections, providerOptions, loading, error, refresh, featureEnabled } = useProviderConnections();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ connection: ProviderConnectionSummary; action: "rename" | "rotate" } | null>(null);
  const [testing, setTesting] = useState<ProviderConnectionSummary | null>(null);
  const [verifying, setVerifying] = useState<ProviderConnectionSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  if (!featureEnabled) return null;

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setActionError("");
    try {
      await action();
      await refresh();
    } catch {
      setActionError(formatMessage({ id: "settings.providers.actionError" }));
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="provider-connections-settings">
      <div className="flex items-center justify-between gap-3">
        <SectionHeader label={formatMessage({ id: "settings.providers.sectionTitle" })} icon={<KeyRound size={16} />} />
        {capabilities.manageExternalAuth && (
          <Button type="button" size="sm" disabled={providerOptions.length === 0} onClick={() => setCreating(true)}>
            <Plus size={16} />
            {formatMessage({ id: "settings.providers.add" })}
          </Button>
        )}
      </div>
      <p className="text-sm text-foreground-muted theme-brutal:text-black/60">{formatMessage({ id: "settings.providers.description" })}</p>

      {(error || actionError) && (
        <div className="border theme-brutal:border-2 border-line-strong theme-brutal:border-black bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
          {actionError || formatMessage({ id: "settings.providers.loadError" })}
        </div>
      )}

      {loading ? (
        <div className="flex min-h-32 items-center justify-center"><Spinner size="md" /></div>
      ) : connections.length === 0 ? (
        <div className="border theme-brutal:border-2 border-dashed border-line-muted theme-brutal:border-black/25 px-5 py-10 text-center text-sm text-foreground-muted theme-brutal:text-black/55">
          {formatMessage({ id: "settings.providers.empty" })}
        </div>
      ) : (
        <div className="divide-y-2 divide-line-muted theme-brutal:divide-black border theme-brutal:border-2 border-line-strong theme-brutal:border-black bg-layer-panel theme-brutal:bg-white shadow-raft-xs theme-brutal:shadow-brutal-sm">
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              providerOptions={providerOptions}
              canManage={capabilities.manageExternalAuth}
              busy={busyId === connection.id}
              onTest={() => setTesting(connection)}
              onVerify={() => setVerifying(connection)}
              onRename={() => setEditing({ connection, action: "rename" })}
              onRotate={() => setEditing({ connection, action: "rotate" })}
              onToggle={() => void run(connection.id, () => api.patch(`/provider-connections/${connection.id}`, { enabled: !connection.enabled }))}
              onDelete={() => {
                if (window.confirm(formatMessage({ id: "settings.providers.deleteConfirm" }, { name: connection.name }))) {
                  void run(connection.id, () => api.delete(`/provider-connections/${connection.id}`));
                }
              }}
            />
          ))}
        </div>
      )}

      {creating && (
        <CreateProviderConnectionModal
          providerOptions={providerOptions}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
      {editing && (
        <ProviderConnectionActionModal
          key={`${editing.connection.id}:${editing.action}`}
          connection={editing.connection}
          providerOptions={providerOptions}
          action={editing.action}
          onClose={() => setEditing(null)}
          onCompleted={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
      {testing && (
        <ProviderConnectionTestModal
          key={testing.id}
          connection={testing}
          onClose={() => setTesting(null)}
          onCompleted={async () => {
            setTesting(null);
            await refresh();
          }}
        />
      )}
      {verifying && (
        <VerifyProviderConnectionModal
          key={verifying.id}
          connection={verifying}
          onClose={() => {
            setVerifying(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function ConnectionRow({
  connection,
  providerOptions,
  canManage,
  busy,
  onTest,
  onVerify,
  onRename,
  onRotate,
  onToggle,
  onDelete,
}: {
  connection: ProviderConnectionSummary;
  providerOptions: ProviderConnectionProviderOption[];
  canManage: boolean;
  busy: boolean;
  onTest: () => void;
  onVerify: () => void;
  onRename: () => void;
  onRotate: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { formatMessage } = useIntl();
  const ready = connection.enabled && connection.status === "ready";
  const deleteDisabledReason = connection.assignedAgentCount > 0
    ? formatMessage(
      { id: "settings.providers.deleteAssignedHint" },
      { count: connection.assignedAgentCount },
    )
    : "";
  return (
    <div className="flex flex-col gap-3 p-4" data-testid={`provider-connection-${connection.id}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className={`mt-0.5 flex size-8 shrink-0 items-center justify-center border theme-brutal:border-2 border-line-strong theme-brutal:border-black ${ready ? "bg-green-100" : "bg-fill-muted theme-brutal:bg-black/5"}`}>
          {ready ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">{connection.name}</div>
          <div className="mt-0.5 text-xs text-foreground-muted theme-brutal:text-black/55">
            {labelForProviderId(connection.providerId, providerOptions)}
            {" · "}
            {formatMessage({ id: `settings.providers.status.${connection.status}` })}
            {" · "}
            {connection.assignedAgentCount === 1
              ? formatMessage({ id: "settings.providers.agentCountOne" })
              : formatMessage({ id: "settings.providers.agentCount" }, { count: connection.assignedAgentCount })}
          </div>
        </div>
      </div>
      {canManage && (
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" shape="icon" title={formatMessage({ id: "settings.providers.test" })} disabled={busy} onClick={onTest}><Send size={15} /></Button>
          <Button type="button" size="sm" shape="icon" title={formatMessage({ id: "settings.providers.verify" })} aria-label={formatMessage({ id: "settings.providers.verify" })} disabled={busy} onClick={onVerify}><Send size={15} /></Button>
          <Button type="button" size="sm" shape="icon" title={formatMessage({ id: "settings.providers.rename" })} disabled={busy} onClick={onRename}><Pencil size={15} /></Button>
          <Button type="button" size="sm" shape="icon" title={formatMessage({ id: "settings.providers.rotate" })} disabled={busy} onClick={onRotate}><KeyRound size={15} /></Button>
          <Button type="button" size="sm" shape="icon" title={connection.enabled ? formatMessage({ id: "settings.providers.disable" }) : formatMessage({ id: "settings.providers.enable" })} disabled={busy} onClick={onToggle}><Power size={15} /></Button>
          <Button
            type="button"
            size="sm"
            shape="icon"
            title={deleteDisabledReason || formatMessage({ id: "settings.providers.delete" })}
            aria-label={formatMessage({ id: "settings.providers.delete" })}
            aria-description={deleteDisabledReason || undefined}
            aria-disabled={deleteDisabledReason ? true : undefined}
            className={deleteDisabledReason ? "cursor-not-allowed opacity-50" : ""}
            disabled={busy}
            onClick={deleteDisabledReason ? undefined : onDelete}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      )}
      </div>
      {connection.latestVerified && <VerifiedOnChip latestVerified={connection.latestVerified} />}
    </div>
  );
}

function ProviderConnectionTestModal({
  connection,
  onClose,
  onCompleted,
}: {
  connection: ProviderConnectionSummary;
  onClose: () => void;
  onCompleted: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [model, setModel] = useState(defaultTestModel(connection.providerId));
  const [message, setMessage] = useState(() => formatMessage({ id: "settings.providers.testMessageDefault" }));
  const [models, setModels] = useState(() => presetTestModels(connection.providerId));
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const modelListId = `provider-connection-${connection.id}-models`;
  const modelInputId = `provider-connection-${connection.id}-test-model`;
  const messageInputId = `provider-connection-${connection.id}-test-message`;

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setModelError("");
    try {
      const response = await api.get<{ models: string[] }>(`/provider-connections/${connection.id}/models`);
      const nextModels = [...new Set([...presetTestModels(connection.providerId), ...response.data.models])];
      setModels(nextModels);
      setModel((current) => current.trim() ? current : nextModels[0] ?? "");
    } catch {
      setModelError(formatMessage({ id: "settings.providers.modelsLoadError" }));
    } finally {
      setLoadingModels(false);
    }
  }, [connection.id, connection.providerId, formatMessage]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api.post(`/provider-connections/${connection.id}/test`, { model, message });
      await onCompleted();
    } catch {
      setError(formatMessage({ id: "settings.providers.testError" }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogCard
      onClose={onClose}
      title={formatMessage({ id: "settings.providers.testTitle" }, { name: connection.name })}
      testId="provider-connection-test-dialog"
    >
      <form onSubmit={submit} className="space-y-4" data-testid="provider-connection-test-form">
        <FormField
          label={formatMessage({ id: "settings.providers.testModel" })}
          htmlFor={modelInputId}
        >
          <input
            id={modelInputId}
            className="input-brutal w-full"
            list={modelListId}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            maxLength={200}
            required
            autoFocus
          />
          <datalist id={modelListId}>
            {models.map((candidate) => <option key={candidate} value={candidate} />)}
          </datalist>
        </FormField>
        <div className="flex items-center justify-between gap-3">
          <p className={`text-xs ${modelError ? "text-red-700" : "text-foreground-muted theme-brutal:text-black/55"}`}>
            {modelError || formatMessage({ id: "settings.providers.testModelHint" })}
          </p>
          <Button type="button" size="sm" disabled={loadingModels || submitting} onClick={() => void loadModels()}>
            <RefreshCw size={15} className={loadingModels ? "animate-spin" : ""} />
            {formatMessage({ id: "settings.providers.refreshModels" })}
          </Button>
        </div>
        <FormField
          label={formatMessage({ id: "settings.providers.testMessage" })}
          htmlFor={messageInputId}
        >
          <textarea
            id={messageInputId}
            className="input-brutal min-h-28 w-full resize-y"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={2000}
            required
          />
        </FormField>
        {error && <div className="text-sm font-medium text-red-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{formatMessage({ id: "settings.common.cancel" })}</Button>
          <Button type="submit" disabled={submitting || !model.trim() || !message.trim()}>
            {submitting ? <Spinner size="sm" /> : <Send size={16} />}
            {formatMessage({ id: "settings.providers.sendTest" })}
          </Button>
        </div>
      </form>
    </DialogCard>
  );
}

function ProviderConnectionActionModal({
  connection,
  providerOptions,
  action,
  onClose,
  onCompleted,
}: {
  connection: ProviderConnectionSummary;
  providerOptions: ProviderConnectionProviderOption[];
  action: "rename" | "rotate";
  onClose: () => void;
  onCompleted: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the keyed modal snapshots the selected row when it opens; catalog refreshes must not overwrite in-progress input.
  const [name, setName] = useState(connection.name);
  const [apiKey, setApiKey] = useState("");
  // oxlint-disable-next-line react-doctor/no-derived-useState -- same keyed modal snapshot contract as the name field above.
  const [endpointUrl, setEndpointUrl] = useState(connection.endpointUrl ?? "");
  // oxlint-disable-next-line react-doctor/no-derived-useState -- same keyed modal snapshot contract as the name field above.
  const [supportsImageInput, setSupportsImageInput] = useState(connection.supportsImageInput);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const gateway = isGatewayProviderId(connection.providerId, providerOptions);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      if (action === "rename") {
        await api.patch(`/provider-connections/${connection.id}`, { name });
      } else {
        await api.post(`/provider-connections/${connection.id}/credentials/rotate`, {
          apiKey,
          ...(gateway ? { endpointUrl, supportsImageInput } : {}),
        });
      }
      await onCompleted();
    } catch {
      setError(formatMessage({ id: "settings.providers.actionError" }));
    } finally {
      setSubmitting(false);
    }
  };

  const titleId = action === "rename" ? "settings.providers.renameTitle" : "settings.providers.rotateTitle";
  const submitId = action === "rename" ? "settings.providers.saveName" : "settings.providers.rotateCredential";
  return (
    <DialogCard onClose={onClose} title={formatMessage({ id: titleId }, { name: connection.name })} testId={`provider-connection-${action}-dialog`}>
      <form onSubmit={submit} className="space-y-4">
        {action === "rename" ? (
          <FormField label={formatMessage({ id: "settings.providers.name" })}>
            <input className="input-brutal w-full" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required autoFocus />
          </FormField>
        ) : (
          <>
            <p className="text-sm text-foreground-muted theme-brutal:text-black/60">{formatMessage({ id: "settings.providers.rotateHint" })}</p>
            {gateway && (
              <FormField label={formatMessage({ id: "settings.providers.endpoint" })}>
                <input className="input-brutal w-full" type="url" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} required />
              </FormField>
            )}
            <FormField label={formatMessage({ id: "settings.providers.apiKey" })} hint={formatMessage({ id: "settings.providers.apiKeyHint" })}>
              <input className="input-brutal w-full" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required autoFocus={!gateway} />
            </FormField>
            {gateway && (
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox checked={supportsImageInput} onChange={(event) => setSupportsImageInput(event.target.checked)} />
                {formatMessage({ id: "settings.providers.imageInput" })}
              </label>
            )}
          </>
        )}
        {error && <div className="text-sm font-medium text-red-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{formatMessage({ id: "settings.common.cancel" })}</Button>
          <Button type="submit" disabled={submitting || (action === "rename" ? !name.trim() : !apiKey.trim() || (gateway && !endpointUrl.trim()))}>
            {submitting ? <Spinner size="sm" /> : action === "rename" ? <Pencil size={16} /> : <KeyRound size={16} />}
            {formatMessage({ id: submitId })}
          </Button>
        </div>
      </form>
    </DialogCard>
  );
}

function CreateProviderConnectionModal({
  providerOptions,
  onClose,
  onCreated,
}: {
  providerOptions: ProviderConnectionProviderOption[];
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [name, setName] = useState("");
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the modal snapshots the schema catalog default when it opens.
  const [providerId, setProviderId] = useState<ProviderConnectionProviderId>(providerOptions[0]?.id ?? "deepseek");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [supportsImageInput, setSupportsImageInput] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const idempotencyKey = useRef(crypto.randomUUID());
  const gateway = isGatewayProviderId(providerId, providerOptions);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await api.post("/provider-connections", {
        name,
        providerId,
        ...(gateway ? { endpointUrl, supportsImageInput } : {}),
        apiKey,
        idempotencyKey: idempotencyKey.current,
      });
      await onCreated();
    } catch {
      setError(formatMessage({ id: "settings.providers.createError" }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogCard onClose={onClose} title={formatMessage({ id: "settings.providers.createTitle" })} testId="provider-connection-create-dialog">
      <form onSubmit={submit} className="space-y-4" data-testid="provider-connection-create-form">
        <FormField label={formatMessage({ id: "settings.providers.name" })}>
          <input className="input-brutal w-full" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
        </FormField>
        <FormField label={formatMessage({ id: "settings.providers.provider" })}>
          <Select
            value={providerId}
            onValueChange={(value) => {
              if (value != null) setProviderId(value as ProviderConnectionProviderId);
            }}
            items={providerOptions.map((provider) => ({
              value: provider.id,
              label: provider.label,
            }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {providerOptions.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    <SelectItemText>{provider.label}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
        </FormField>
        {gateway && (
          <FormField label={formatMessage({ id: "settings.providers.endpoint" })}>
            <input className="input-brutal w-full" type="url" value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} placeholder="https://gateway.example.com/v1" required />
          </FormField>
        )}
        <FormField label={formatMessage({ id: "settings.providers.apiKey" })} hint={formatMessage({ id: "settings.providers.apiKeyHint" })}>
          <input className="input-brutal w-full" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required />
        </FormField>
        {gateway && (
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox checked={supportsImageInput} onChange={(event) => setSupportsImageInput(event.target.checked)} />
            {formatMessage({ id: "settings.providers.imageInput" })}
          </label>
        )}
        {error && <div className="text-sm font-medium text-red-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{formatMessage({ id: "settings.common.cancel" })}</Button>
          <Button type="submit" disabled={submitting || !name.trim() || !apiKey.trim() || (gateway && !endpointUrl.trim())}>
            {submitting ? <Spinner size="sm" /> : <Plus size={16} />}
            {formatMessage({ id: "settings.providers.create" })}
          </Button>
        </div>
      </form>
    </DialogCard>
  );
}

function VerifiedOnChip({ latestVerified }: { latestVerified: ProviderConnectionLatestVerified }) {
  const { formatMessage } = useIntl();
  return (
    <div data-testid="provider-connection-verified-on">
      <span
        className="border theme-brutal:border-2 border-line-muted theme-brutal:border-black/30 bg-green-50 px-2 py-0.5 text-xs font-bold text-foreground-muted theme-brutal:text-black/70"
        title={formatMessage(
          { id: "settings.providers.verifiedOnDetail" },
          {
            runtime: latestVerified.runtime,
            model: latestVerified.model,
            verifiedAt: latestVerified.verifiedAt,
          },
        )}
      >
        {formatMessage(
          { id: "settings.providers.verifySuccess" },
          { computer: latestVerified.computerName ?? latestVerified.computerId },
        )}
      </span>
    </div>
  );
}

function VerifyProviderConnectionModal({
  connection,
  onClose,
}: {
  connection: ProviderConnectionSummary;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const machines = useMachineStore((state) => state.machines);
  const candidates = machines.filter((machine) => machine.status === "online" && machine.runtimes.includes("builtin"));
  const [computerId, setComputerId] = useState(candidates[0]?.id ?? "");
  const [model, setModel] = useState(() => defaultTestModel(connection.providerId));
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [result, setResult] = useState<ProviderProbeCreatedView | null>(null);
  const [failure, setFailure] = useState("");
  const computerName = machines.find((machine) => machine.id === computerId)?.name ?? computerId;
  const presetModels = presetTestModels(connection.providerId);
  const [customModelMode, setCustomModelMode] = useState(() => {
    const initial = defaultTestModel(connection.providerId);
    return presetModels.length === 0 || (initial.trim().length > 0 && !presetModels.includes(initial));
  });
  const isCustom = customModelMode || (model.trim().length > 0 && !presetModels.includes(model));
  const verifyModelInputId = `provider-connection-${connection.id}-verify-model`;
  const verifyModelSelectId = `provider-connection-${connection.id}-verify-model-select`;
  const verifyModelOptions = [
    ...presetModels.map((candidate) => ({ value: candidate, label: candidate })),
    { value: CUSTOM_MODEL_SELECT_VALUE, label: formatMessage({ id: "agent.runtimeConfig.custom" }) },
  ];

  const start = async () => {
    setPhase("running");
    setFailure("");
    setResult(null);
    try {
      const payload = {
        computerId,
        runtime: "builtin" as const,
        model: model.trim() || defaultTestModel(connection.providerId),
        probeKind: "canary" as const,
      };
      const requestDigest = await providerProbeRequestDigest({ connectionId: connection.id, ...payload });
      const { data } = await api.post<ProviderProbeCreatedView>(`/provider-connections/${connection.id}/probes`, {
        probeRequestId: globalThis.crypto.randomUUID(),
        requestDigest,
        ...payload,
      });
      setResult(data);
      setPhase("done");
    } catch {
      setFailure(formatMessage({ id: "settings.providers.verifyError" }));
      setPhase("done");
    }
  };

  const outcome = result?.probe.outcome ?? null;
  const category = result?.probe.category ?? null;
  return (
    <DialogCard
      onClose={onClose}
      title={formatMessage({ id: "settings.providers.verifyTitle" }, { name: connection.name })}
      testId="provider-connection-verify-dialog"
    >
      <div className="space-y-4" data-testid="provider-connection-verify-body">
        <FormField label={formatMessage({ id: "settings.providers.verifyComputer" })}>
          <Select
            value={computerId}
            disabled={phase === "running" || candidates.length === 0}
            onValueChange={(value) => {
              if (value != null) setComputerId(value);
            }}
            items={candidates.map((machine) => ({
              value: machine.id,
              label: machine.name,
            }))}
          >
            <SelectTrigger
              className="w-full"
              aria-label={formatMessage({ id: "settings.providers.verifyComputer" })}
              disabled={phase === "running" || candidates.length === 0}
            >
              <SelectValue placeholder={formatMessage({ id: "settings.providers.verifyComputer" })} />
              <SelectIcon />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {candidates.map((machine) => (
                  <SelectItem key={machine.id} value={machine.id}>
                    <SelectItemText>{machine.name}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
        </FormField>
        {candidates.length === 0 && (
          <p className="text-sm text-foreground-muted theme-brutal:text-black/55">{formatMessage({ id: "settings.providers.verifyNoComputers" })}</p>
        )}
        <FormField
          label={formatMessage({ id: "settings.providers.verifyModel" })}
          htmlFor={isCustom || presetModels.length === 0 ? verifyModelInputId : verifyModelSelectId}
        >
          {presetModels.length > 0 ? (
            <Select
              value={isCustom ? CUSTOM_MODEL_SELECT_VALUE : model}
              disabled={phase === "running"}
              onValueChange={(nextValue) => {
                if (nextValue === CUSTOM_MODEL_SELECT_VALUE) {
                  setCustomModelMode(true);
                  if (presetModels.includes(model)) setModel("");
                  return;
                }
                if (nextValue != null) {
                  setCustomModelMode(false);
                  setModel(nextValue);
                }
              }}
              items={verifyModelOptions}
            >
              <SelectTrigger
                id={verifyModelSelectId}
                className="w-full"
                aria-label={formatMessage({ id: "settings.providers.verifyModel" })}
                disabled={phase === "running"}
              >
                <SelectValue placeholder={formatMessage({ id: "settings.providers.verifyModel" })} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  {verifyModelOptions.map((candidate) => (
                    <SelectItem key={candidate.value} value={candidate.value}>
                      <SelectItemText>{candidate.label}</SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                  ))}
                </SelectList>
              </SelectContent>
            </Select>
          ) : null}
          {(isCustom || presetModels.length === 0) && (
            <input
              id={verifyModelInputId}
              className={`input-brutal w-full ${presetModels.length > 0 ? "mt-2" : ""}`}
              value={model}
              disabled={phase === "running"}
              onChange={(event) => setModel(event.target.value)}
              placeholder={formatMessage({ id: "agent.runtimeConfig.customModelId" })}
              maxLength={200}
              required
              autoFocus={isCustom}
            />
          )}
        </FormField>
        {phase === "running" && (
          <p className="text-sm text-foreground-muted theme-brutal:text-black/55" data-testid="provider-connection-verify-running">
            {formatMessage({ id: "settings.providers.verifyRunning" }, { computer: computerName })}
          </p>
        )}
        {phase === "done" && result && outcome === "success" && (
          <div className="space-y-2" data-testid="provider-connection-verify-success">
            <p className="text-sm font-bold text-green-800">
              {formatMessage({ id: "settings.providers.verifySuccess" }, { computer: computerName })}
              {" · "}
              {formatMessage({ id: "settings.providers.verifyLatency" }, { ms: result.probe.latencyMs ?? 0 })}
              {" · "}
              {result.probe.verifiedAt ?? ""}
            </p>
            <div>
              <div className="text-xs font-black uppercase tracking-wide text-foreground-muted theme-brutal:text-black/55">
                {formatMessage({ id: "settings.providers.verifyReply" })}
              </div>
              {result.reply ? (
                <pre className="input-brutal mt-1 w-full whitespace-pre-wrap" data-testid="provider-connection-verify-reply">
                  {result.reply}
                </pre>
              ) : (
                <p className="mt-1 text-xs text-foreground-muted theme-brutal:text-black/55">{formatMessage({ id: "settings.providers.verifyReplyMissing" })}</p>
              )}
            </div>
          </div>
        )}
        {phase === "done" && (outcome === "failure" || failure) && (
          <div className="space-y-1" data-testid="provider-connection-verify-failure">
            <p className="text-sm font-bold text-red-700">
              {failure || formatMessage({ id: "settings.providers.verifyFailure" }, {
                category: category ? formatMessage({ id: probeCategoryMessageId(category) }) : "",
              })}
            </p>
            <p className="text-xs text-foreground-muted theme-brutal:text-black/55">{formatMessage({ id: "settings.providers.verifyFailureHint" })}</p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>{formatMessage({ id: "settings.common.close" })}</Button>
          <Button
            type="button"
            disabled={phase === "running" || candidates.length === 0}
            onClick={() => void start()}
          >
            {phase === "done"
              ? formatMessage({ id: "settings.providers.verifyAgain" })
              : formatMessage({ id: "settings.providers.verifyStart" })}
          </Button>
        </div>
      </div>
    </DialogCard>
  );
}

export const __testInternals = {
  ConnectionRow,
  CreateProviderConnectionModal,
  ProviderConnectionTestModal,
  VerifyProviderConnectionModal,
  VerifiedOnChip,
};
