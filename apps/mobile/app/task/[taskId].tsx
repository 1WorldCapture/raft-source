import { useEffect, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ApiError, StaleRequestError } from "../../src/api/client";
import { useT } from "../../src/i18n/provider";
import { isRecord } from "../../src/model/messages";
import { MessagePane } from "../../src/screens/MessagePane";
import { resolveHour12, resolveTimeZone } from "../../src/screens/messageTime";
import { useSession } from "../../src/state/session";
import { useServerRole } from "../../src/home/serverRole";
import { TaskDetailView } from "../../src/tasks/TaskDetail";
import { assigneePeople, parseTaskHistory, visibleTaskHistory, type AssigneePerson, type TaskHistoryEvent } from "../../src/tasks/history";
import { useTaskStore } from "../../src/tasks/store";
import type { TaskAssignee, TaskStatus } from "../../src/tasks/model";
import { LoadingScreen, ScreenMessage } from "../../src/ui/screen";
import { color } from "../../src/ui/tokens";

function firstParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ?? "";
}

export default function TaskScreen() {
  const params = useLocalSearchParams<{ taskId: string }>();
  const taskId = firstParam(params.taskId);
  const router = useRouter();
  const session = useSession();
  const role = useServerRole();
  const t = useT();
  const task = useTaskStore((state) => state.tasks.find((item) => item.id === taskId));
  const loaded = useTaskStore((state) => state.loaded);
  const notice = useTaskStore((state) => state.error);
  const [history, setHistory] = useState<TaskHistoryEvent[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [people, setPeople] = useState<AssigneePerson[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadReady, setThreadReady] = useState(false);
  const seen = useRef(false);
  const alerted = useRef(false);
  const lastTitle = useRef("");
  if (task) {
    seen.current = true;
    lastTitle.current = task.title;
  }

  useEffect(() => {
    if (!useTaskStore.getState().loaded) void useTaskStore.getState().load(session.client);
  }, [session.client, session.serverId]);

  useEffect(() => {
    if (!seen.current || task || !loaded || alerted.current) return;
    alerted.current = true;
    Alert.alert(lastTitle.current, t("task.modal.close"), [
      { text: "OK", onPress: () => router.back() },
    ]);
  }, [loaded, router, t, task]);

  useEffect(() => {
    if (!task) return;
    let cancelled = false;
    setHistoryError(false);
    void session.client.get<unknown>(`/tasks/${encodeURIComponent(task.id)}/history`).then((data) => {
      if (!cancelled) setHistory(visibleTaskHistory(parseTaskHistory(data)));
    }).catch((caught) => {
      if (cancelled || caught instanceof StaleRequestError) return;
      if (caught instanceof ApiError && caught.status === 409) {
        setHistory([]);
        return;
      }
      setHistoryError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [session.client, task]);

  useEffect(() => {
    if (!task) return;
    let cancelled = false;
    void session.client.get<unknown>(`/channels/${encodeURIComponent(task.channelId)}/members`).then((data) => {
      if (!cancelled) setPeople(assigneePeople(data));
    }).catch(() => {
      if (!cancelled) setPeople([]);
    });
    return () => {
      cancelled = true;
    };
  }, [session.client, task]);

  useEffect(() => {
    if (!task || task.isLegacy) return;
    let cancelled = false;
    setThreadReady(false);
    void session.client.get<unknown>(`/channels/${encodeURIComponent(task.channelId)}/threads/${encodeURIComponent(task.messageId)}`).then((data) => {
      if (cancelled) return;
      setThreadId(isRecord(data) && typeof data.threadChannelId === "string" ? data.threadChannelId : null);
      setThreadReady(true);
    }).catch((caught) => {
      if (cancelled || caught instanceof StaleRequestError) return;
      if (caught instanceof ApiError && caught.status === 404) setThreadId(null);
      setThreadReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [session.client, task]);

  if (!task && !loaded) return <LoadingScreen />;
  if (!task) return <ScreenMessage title={t("task.modal.close")} />;

  const changeStatus = (status: TaskStatus) => {
    void useTaskStore.getState().setStatus(session.client, task.id, status);
  };
  const changeAssignee = (assignee: TaskAssignee | null) => {
    void useTaskStore.getState().setAssignee(session.client, task.id, assignee);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ backgroundColor: color.page, flex: 1 }}>
      <TaskDetailView
        fill={task.isLegacy}
        history={history}
        historyError={historyError}
        hour12={resolveHour12(session.user?.preferredTimeFormat)}
        notice={notice}
        onAssignee={changeAssignee}
        onBack={() => router.back()}
        onStatus={changeStatus}
        people={people}
        role={role}
        task={task}
        timeZone={resolveTimeZone(session.user?.preferredTimezone)}
      />
      {task.isLegacy || !threadReady ? null : (
        <View style={{ flex: 1 }}>
          <MessagePane
            channelId={threadId ?? "pending-thread"}
            embedded
            parentChannelId={task.channelId}
            parentMessageId={task.messageId}
            thread
            title={task.title}
          />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
