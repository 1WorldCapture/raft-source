import { en } from "../../../../packages/web/src/i18n/messages/en";
import { zhCn } from "../../../../packages/web/src/i18n/messages/zh-cn";

/** Mobile-only copy. Web ids are imported, not copied. */
export const mobileEn = {
  "mobile.config.missingTitle": "Server address is not configured",
  "mobile.config.missingBody": "Set EXPO_PUBLIC_RAFT_SERVER_URL to a valid address when building the app.",
  "mobile.network.offline": "The network is unreachable. Check the connection and try again.",
  "mobile.network.retry": "The network is unreachable. Pull to refresh after it returns.",
  "mobile.network.later": "The network is unreachable. Try again in a moment.",
  "mobile.auth.tooMany": "Too many attempts. Try again in a moment.",
  "mobile.auth.failed": "Could not sign in",
  "mobile.servers.title": "Servers",
  "mobile.servers.empty": "No servers on this account.",
  "mobile.servers.loadFailed": "Couldn't load servers",
  "mobile.channels.title": "Channels",
  "mobile.channels.direct": "Direct messages",
  "mobile.channels.empty": "No channels yet.",
  "mobile.channels.loadFailed": "Couldn't load channels",
  "mobile.channels.wrongServer": "Open this server from the server list so requests use the right server.",
  "mobile.messages.title": "Messages",
  "mobile.messages.empty": "No messages yet.",
  "mobile.messages.placeholder": "Message",
  "mobile.messages.replyPlaceholder": "Reply",
  "mobile.messages.send": "Send",
  "mobile.messages.sending": "Sending",
  "mobile.messages.resend": "Resend",
  "mobile.messages.delete": "Delete",
  "mobile.messages.sendFailed": "Could not send",
  "mobile.messages.tooLong": "This message is longer than 32000 characters",
  "mobile.messages.forbidden": "You don't have permission, or this channel is read-only",
  "mobile.messages.archived": "This channel is archived",
  "mobile.messages.conflict": "This message does not match the previous attempt. Change it and try again.",
  "mobile.messages.historyLimited": "Older messages are hidden by the plan",
  "mobile.messages.viewThread": "View thread",
  "mobile.messages.replies": "{count} replies",
  "mobile.thread.openFailed": "Couldn't open the thread",
  "mobile.thread.missing": "Thread was not created",
  "mobile.account.profile": "Finish profile setup on the web, then come back to the app.",
  "mobile.account.verify": "Verify your email on the web.",
  "mobile.account.resend": "Resend verification email",
  "mobile.account.sending": "Sending…",
  "mobile.account.signedIn": "Signed in",
  "mobile.design.title": "Design",
  "mobile.health.offline": "The network cannot reach this server",
  "mobile.health.notRaft": "This address did not return a Raft health check",
} as const;

export const mobileZh: Record<keyof typeof mobileEn, string> = {
  "mobile.config.missingTitle": "服务器地址未配置",
  "mobile.config.missingBody": "构建时必须设置 EXPO_PUBLIC_RAFT_SERVER_URL，并且地址要能通过校验。",
  "mobile.network.offline": "网络不通，请检查连接后再试",
  "mobile.network.retry": "网络不通。恢复后下拉刷新。",
  "mobile.network.later": "网络不通，请稍后再试",
  "mobile.auth.tooMany": "尝试太频繁，请稍后再试",
  "mobile.auth.failed": "登录失败",
  "mobile.servers.title": "服务器",
  "mobile.servers.empty": "这个账号还没有服务器。",
  "mobile.servers.loadFailed": "无法加载服务器",
  "mobile.channels.title": "频道",
  "mobile.channels.direct": "私信",
  "mobile.channels.empty": "还没有频道。",
  "mobile.channels.loadFailed": "无法加载频道",
  "mobile.channels.wrongServer": "请从服务器列表打开，这样请求才会带上正确的服务器。",
  "mobile.messages.title": "消息",
  "mobile.messages.empty": "还没有消息。",
  "mobile.messages.placeholder": "消息",
  "mobile.messages.replyPlaceholder": "回复",
  "mobile.messages.send": "发送",
  "mobile.messages.sending": "发送中",
  "mobile.messages.resend": "重发",
  "mobile.messages.delete": "删除",
  "mobile.messages.sendFailed": "发送失败",
  "mobile.messages.tooLong": "消息超过 32000 个字符",
  "mobile.messages.forbidden": "没有权限，或这个频道是只读的",
  "mobile.messages.archived": "频道已归档",
  "mobile.messages.conflict": "这条消息的内容和上次不一致，请改一下再发",
  "mobile.messages.historyLimited": "更早的消息受套餐限制不可见",
  "mobile.messages.viewThread": "查看线程",
  "mobile.messages.replies": "{count} 条回复",
  "mobile.thread.openFailed": "无法打开线程",
  "mobile.thread.missing": "线程没有创建成功",
  "mobile.account.profile": "请先在 Web 端完成资料设置，然后再回到 App。",
  "mobile.account.verify": "请先在 Web 端完成邮箱验证。",
  "mobile.account.resend": "重新发送验证邮件",
  "mobile.account.sending": "发送中…",
  "mobile.account.signedIn": "已登录",
  "mobile.design.title": "设计",
  "mobile.health.offline": "网络不通，确认手机能访问这台服务器",
  "mobile.health.notRaft": "这个地址没有返回 Raft 的健康检查，确认它是 Raft 服务",
};

export type MobileId = keyof typeof mobileEn;
export type AppMessageId = keyof typeof en | MobileId;

export function messagesFor(locale: "en" | "zh-cn"): Record<string, string> {
  return locale === "zh-cn" ? { ...zhCn, ...mobileZh } : { ...en, ...mobileEn };
}

export function resolveLocale(preferred: string | null | undefined, systemLocale: string | null | undefined): "en" | "zh-cn" {
  const value = (preferred || systemLocale || "en").toLowerCase();
  return value.startsWith("zh") ? "zh-cn" : "en";
}
