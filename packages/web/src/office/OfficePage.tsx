import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { getSocket } from "../api/socket";
import { useAppNavigate } from "../hooks/useAppNavigate";
import { useServerStore } from "../store/serverStore";
import { EditorState } from "../officePixel/office/editor/editorState.js";
import { OfficeState } from "../officePixel/office/engine/officeState.js";
import { OfficeCanvas } from "../officePixel/office/components/OfficeCanvas.js";
import {
  applyActivityEvent,
  applyLifecycleEvent,
  applyMachineStatusEvent,
} from "./applyOverviewEvents";
import type { ActivityEvent, LifecycleEvent, MachineStatusEvent } from "./applyOverviewEvents";
import type { AgentOverview } from "./agentOverview";
import { calibratedNow } from "./durationTier";
import { USE_FAKE_AGENT_OVERVIEW, loadAgentOverview } from "./loadAgentOverview";
import { loadOfficeAssets } from "./loadOfficeAssets";
import { paintOffice, raftAgentId } from "./officeScene";
import { buildOfficeScene } from "./roomLayout";
import type { OfficeBoss } from "./roomLayout";

export default function OfficePage() {
  const { formatMessage } = useIntl();
  const navigate = useAppNavigate();
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const [overview, setOverview] = useState<AgentOverview | null>(null);
  const [assetsReady, setAssetsReady] = useState(false);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const [zoom, setZoom] = useState(3);
  const [query, setQuery] = useState("");
  const members = useServerStore((s) => s.members);
  const officeRef = useRef<OfficeState | null>(null);
  const structureRef = useRef<string | null>(null);
  const editorState = useRef(new EditorState());
  const panRef = useRef({ x: 0, y: 0 });
  const receivedAtRef = useRef(Date.now());
  const serverTimeRef = useRef<number | null>(null);

  const noteServerTime = useCallback((serverTime: number) => {
    if (serverTimeRef.current === serverTime) return;
    serverTimeRef.current = serverTime;
    receivedAtRef.current = Date.now();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadOfficeAssets()
      .then(() => {
        if (!cancelled) setAssetsReady(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    void loadAgentOverview(serverId)
      .then((next) => {
        if (cancelled) return;
        noteServerTime(next.serverTime);
        setOverview(next);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [noteServerTime, serverId]);

  useEffect(() => {
    const socket = getSocket();
    const update = (recipe: (prev: AgentOverview) => AgentOverview) => {
      setOverview((prev) => (prev ? recipe(prev) : prev));
    };
    const onActivity = (data: ActivityEvent & { timestamp?: number }) => {
      const observedAtMs = data.observedAtMs ?? data.timestamp;
      const offset = (serverTimeRef.current ?? 0) - receivedAtRef.current;
      update((prev) => applyActivityEvent(prev, { ...data, observedAtMs }, offset));
    };
    const onLifecycle = (data: LifecycleEvent) => {
      noteServerTime(data.serverTime);
      update((prev) => applyLifecycleEvent(prev, data));
    };
    const onMachine = (data: MachineStatusEvent) => update((prev) => applyMachineStatusEvent(prev, data));
    socket.on("agent:activity", onActivity);
    socket.on("agent:lifecycle", onLifecycle);
    socket.on("machine:status", onMachine);
    return () => {
      socket.off("agent:activity", onActivity);
      socket.off("agent:lifecycle", onLifecycle);
      socket.off("machine:status", onMachine);
    };
  }, [noteServerTime]);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  const bosses = useMemo<OfficeBoss[]>(() => {
    const people = members.map((member) => ({
      id: member.userId,
      name: member.displayName || member.name,
    }));
    if (people.length > 0 || !USE_FAKE_AGENT_OVERVIEW) return people;
    return [{ id: "fixture-boss", name: "老板" }];
  }, [members]);
  const scene = useMemo(() => {
    if (!overview) return null;
    return buildOfficeScene(
      overview,
      calibratedNow(overview.serverTime, receivedAtRef.current + tick - tick),
      bosses,
      query,
    );
  }, [bosses, overview, query, tick]);

  if (assetsReady && scene) {
    if (!officeRef.current) officeRef.current = new OfficeState(scene.layout);
    structureRef.current = paintOffice(officeRef.current, scene, structureRef.current);
  }

  const openCharacter = useCallback((numericId: number) => {
    const id = raftAgentId(numericId);
    const placement = scene?.placements.find((item) => item.agentId === id);
    if (!id || !placement || id === "fixture-boss") return;
    if (placement.presence !== "boss" && USE_FAKE_AGENT_OVERVIEW) return;
    if (placement.presence === "boss") navigate.toHuman(id);
    else navigate.toAgent(id);
  }, [navigate, scene]);

  const officeState = assetsReady && scene ? officeRef.current : null;

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-black" data-testid="office-page">
      <label className="flex items-center gap-2 px-3 py-1 text-xs text-white/80">
        <span>{formatMessage({ id: "office.search" })}</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 border border-white/30 bg-black px-2 py-0.5 text-white"
          data-testid="office-search"
        />
      </label>
      {USE_FAKE_AGENT_OVERVIEW ? (
        <p className="px-3 py-1 text-xs text-white/80" data-testid="office-preview-notice">
          {formatMessage({ id: "office.previewNotice" })}
        </p>
      ) : null}
      {error ? (
        <p className="p-4 text-sm text-white" data-testid="office-error">{formatMessage({ id: "office.loadFailed" })}</p>
      ) : null}
      {!error && !officeState ? (
        <p className="p-4 text-sm text-white" data-testid="office-loading">{formatMessage({ id: "office.loading" })}</p>
      ) : null}
      {officeState && scene ? (
        <div className="relative min-h-0 flex-1">
          <OfficeCanvas
            officeState={officeState}
            onClick={openCharacter}
            isEditMode={false}
            editorState={editorState.current}
            onEditorTileAction={() => undefined}
            onEditorEraseAction={() => undefined}
            onEditorSelectionChange={() => undefined}
            onDeleteSelected={() => undefined}
            onRotateSelected={() => undefined}
            onDragMove={() => undefined}
            editorTick={0}
            zoom={zoom}
            onZoomChange={setZoom}
            panRef={panRef}
            showAreas
            activeAreaLabel={null}
          />
          <ul className="sr-only" data-testid="office-roster">
            {scene.placements.map((placement) => (
              <li key={placement.agentId} data-presence={placement.presence} data-tier={placement.tier}>
                {placement.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
