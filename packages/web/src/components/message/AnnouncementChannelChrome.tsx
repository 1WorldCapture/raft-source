import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import type { Message } from "../../store/messageStore";
import { ANNOUNCEMENT_SENDER_QUERY_PARAM } from "../../utils/announcementChannel";

type FilterAgent = { id: string; name: string; displayName?: string | null };
type FilterHuman = { id: string; name: string; displayName?: string | null };

function memberLabel(member: { name: string; displayName?: string | null }): string {
  return member.displayName?.trim() || member.name;
}

export function AnnouncementMemberFilter({
  agents,
  humans,
  value,
  onChange,
}: {
  agents: FilterAgent[];
  humans: FilterHuman[];
  value: string | null;
  onChange: (senderId: string | null) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b-2 border-black bg-white px-3 py-2"
      data-testid="announcement-member-filter"
    >
      <label htmlFor="announcement-member-filter" className="text-xs font-bold text-black">
        {formatMessage({ id: "message.announcement.filterLabel" })}
      </label>
      <select
        id="announcement-member-filter"
        className="min-w-0 flex-1 border-2 border-black bg-white px-2 py-1 text-xs"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{formatMessage({ id: "message.announcement.filterAll" })}</option>
        {agents.map((agent) => (
          <option key={`agent:${agent.id}`} value={agent.id}>{memberLabel(agent)}</option>
        ))}
        {humans.map((human) => (
          <option key={`human:${human.id}`} value={human.id}>{memberLabel(human)}</option>
        ))}
      </select>
    </div>
  );
}

function senderPage(data: unknown): { messages: Message[]; hasMore: boolean } {
  if (!data || typeof data !== "object") return { messages: [], hasMore: false };
  const record = data as { messages?: unknown; hasMore?: unknown };
  const messages = Array.isArray(record.messages) ? record.messages as Message[] : [];
  return { messages, hasMore: record.hasMore === true };
}

export function AnnouncementSenderTimeline({
  channelId,
  senderId,
  renderMessage,
}: {
  channelId: string;
  senderId: string;
  renderMessage: (message: Message) => ReactNode;
}) {
  const { formatMessage } = useIntl();
  const requestKey = `${channelId}:${senderId}`;
  const [pageState, setPageState] = useState<{
    key: string;
    messages: Message[];
    error: boolean;
    hasOlder: boolean;
  } | null>(null);
  const messages = pageState?.key === requestKey ? pageState.messages : [];
  const error = pageState?.key === requestKey ? pageState.error : false;
  const hasOlder = pageState?.key === requestKey ? pageState.hasOlder : false;
  const loading = pageState?.key !== requestKey;

  const load = useCallback(async (before?: number) => {
    const params = new URLSearchParams({
      limit: "50",
      [ANNOUNCEMENT_SENDER_QUERY_PARAM]: senderId,
    });
    if (before != null) params.set("before", String(before));
    // Separate from the cached channel window. Do not write these rows into the message cache.
    const { data } = await api.get(`/messages/channel/${channelId}/by-sender?${params.toString()}`);
    return senderPage(data);
  }, [channelId, senderId]);

  useEffect(() => {
    let cancelled = false;
    void load().then((page) => {
      if (cancelled) return;
      setPageState({
        key: requestKey,
        messages: page.messages,
        error: false,
        hasOlder: page.hasMore,
      });
    }).catch(() => {
      if (cancelled) return;
      setPageState({ key: requestKey, messages: [], error: true, hasOlder: false });
    });
    return () => {
      cancelled = true;
    };
  }, [load, requestKey]);

  const loadOlder = async () => {
    const oldest = messages.reduce<number | null>((min, message) => {
      if (typeof message.seq !== "number") return min;
      return min == null ? message.seq : Math.min(min, message.seq);
    }, null);
    if (oldest == null) return;
    const page = await load(oldest);
    setPageState((current) => {
      const existing = current?.key === requestKey ? current.messages : messages;
      const seen = new Set(existing.map((message) => message.id));
      return {
        key: requestKey,
        messages: [...page.messages.filter((message) => !seen.has(message.id)), ...existing],
        error: false,
        hasOlder: page.hasMore,
      };
    });
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-black/40" data-testid="announcement-sender-loading">
        {formatMessage({ id: "message.chatPanel.loading" })}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-sm text-black/60" data-testid="announcement-sender-error">
        {formatMessage({ id: "message.announcement.filterFailed" })}
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto" data-testid="announcement-sender-timeline">
      {hasOlder && (
        <button
          type="button"
          className="btn-brutal-sm mx-auto my-2 block bg-white px-3 py-1 text-xs"
          onClick={() => void loadOlder()}
        >
          {formatMessage({ id: "message.announcement.loadOlder" })}
        </button>
      )}
      {messages.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-black/40">
          {formatMessage({ id: "message.announcement.filterEmpty" })}
        </div>
      ) : messages.map((message) => (
        <div key={message.id} className="px-3">{renderMessage(message)}</div>
      ))}
    </div>
  );
}
