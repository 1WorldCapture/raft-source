import { useLocalSearchParams } from "expo-router";
import { useT } from "../../src/i18n/provider";
import { MessagePane } from "../../src/screens/MessagePane";

function firstParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw || undefined;
}

export default function MessageScreen() {
  const { channelId, name, targetMessageId, bubbles } = useLocalSearchParams<{ channelId: string; name?: string; targetMessageId?: string; bubbles?: string }>();
  const t = useT();
  if (!channelId) return null;
  return <MessagePane channelId={channelId} direct={firstParam(bubbles) === "1"} targetMessageId={firstParam(targetMessageId)} title={name || t("mobile.messages.title")} />;
}
