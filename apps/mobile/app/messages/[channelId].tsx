import { useLocalSearchParams } from "expo-router";
import { useT } from "../../src/i18n/provider";
import { MessagePane } from "../../src/screens/MessagePane";

export default function MessageScreen() {
  const { channelId, name } = useLocalSearchParams<{ channelId: string; name?: string }>();
  const t = useT();
  if (!channelId) return null;
  return <MessagePane channelId={channelId} title={name || t("mobile.messages.title")} />;
}
