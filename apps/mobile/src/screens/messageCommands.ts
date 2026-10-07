import type { ApiClient } from "../api/client";

export function setMessageReaction(client: ApiClient, messageId: string, emoji: string, active: boolean) {
  if (active) return client.post(`/messages/${messageId}/reactions`, { emoji });
  return client.delete(`/messages/${messageId}/reactions`, { emoji });
}

export function setMessageSaved(client: ApiClient, messageId: string, saved: boolean) {
  if (saved) return client.post("/channels/saved", { messageId });
  return client.delete(`/channels/saved/${messageId}`);
}

export function setThreadFollow(client: ApiClient, parentMessageId: string, threadChannelId: string | undefined, follow: boolean) {
  if (follow) return client.post("/channels/threads/follow", { parentMessageId });
  return client.post("/channels/threads/unfollow", { threadChannelId });
}

export function convertMessageToTask(client: ApiClient, messageId: string) {
  return client.post("/tasks/convert-message", { messageId });
}

export function setTaskStatus(client: ApiClient, taskId: string, status: "done" | "todo") {
  return client.patch(`/tasks/${taskId}/status`, { status });
}

export function setActivityMuted(client: ApiClient, channelId: string, activityMuted: boolean) {
  return client.patch(`/channels/${channelId}/notification-settings`, { activityMuted });
}

export function setCollapseLongMessages(client: ApiClient, channelId: string, collapseLongMessages: boolean) {
  return client.patch(`/channels/${channelId}/message-display-settings`, { collapseLongMessages });
}

export function leaveChannel(client: ApiClient, channelId: string) {
  return client.post(`/channels/${channelId}/leave`, {});
}

export function openDirectMessage(client: ApiClient, sender: { id: string; type?: string }) {
  const body = sender.type === "agent" ? { agentId: sender.id } : { userId: sender.id };
  return client.post<unknown>("/channels/dm", body);
}
