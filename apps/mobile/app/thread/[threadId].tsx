import { useEffect, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { ApiError, StaleRequestError } from "../../src/api/client";
import { useT } from "../../src/i18n/provider";
import { isRecord } from "../../src/model/messages";
import { MessagePane } from "../../src/screens/MessagePane";
import { useSession } from "../../src/state/session";
import { useRaftStore } from "../../src/state/store";
import { LoadingScreen, ScreenMessage } from "../../src/ui/screen";

export default function ThreadScreen() {
  const params = useLocalSearchParams<{
    threadId: string;
    parentChannelId?: string;
    parentMessageId?: string;
    title?: string;
  }>();
  const session = useSession();
  const t = useT();
  const createdThreadId = useRaftStore((state) => (
    params.parentMessageId ? state.threadSummaries[params.parentMessageId]?.threadChannelId : undefined
  ));
  const [threadChannelId, setThreadChannelId] = useState<string | null>(
    params.threadId && params.threadId !== "pending-thread" ? params.threadId : null,
  );
  const [missing, setMissing] = useState(params.threadId === "pending-thread");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.parentChannelId || !params.parentMessageId) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await session.client.get<unknown>(`/channels/${params.parentChannelId}/threads/${params.parentMessageId}`);
        if (cancelled) return;
        if (isRecord(data) && typeof data.threadChannelId === "string") {
          setThreadChannelId(data.threadChannelId);
          setMissing(false);
        }
      } catch (caught) {
        if (cancelled || caught instanceof StaleRequestError) return;
        if (caught instanceof ApiError && caught.status === 404) {
          setMissing(true);
          setThreadChannelId(null);
          return;
        }
        setError(caught instanceof Error ? caught.message : t("mobile.thread.openFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.parentChannelId, params.parentMessageId, session]);

  if (error) return <ScreenMessage title={t("mobile.thread.openFailed")} body={error} />;
  const resolvedThreadId = threadChannelId ?? createdThreadId ?? null;
  if (!resolvedThreadId && !missing) return <LoadingScreen />;
  return (
    <MessagePane
      channelId={resolvedThreadId ?? "pending-thread"}
      parentChannelId={params.parentChannelId}
      parentMessageId={params.parentMessageId}
      thread
      title={params.title || t("message.threadPanel.thread")}
    />
  );
}
