/** Web permalink. A thread reply uses the parent channel for both the path and `thread=`. */
export function messagePermalink(
  origin: string,
  serverSlug: string,
  channelId: string,
  messageId: string,
  options: { dm?: boolean; threadParentMessageId?: string | null } = {},
): string {
  const kind = options.dm ? "dm" : "channel";
  const params = new URLSearchParams({ msg: messageId });
  if (options.threadParentMessageId) params.set("thread", `${channelId}:${options.threadParentMessageId}`);
  const base = origin.replace(/\/$/, "");
  return `${base}/s/${encodeURIComponent(serverSlug)}/${kind}/${channelId}?${params.toString()}`;
}
