import { useLocalSearchParams } from "expo-router";
import { MessagePane } from "../../src/screens/MessagePane";

export default function MessageScreen() {
  const { channelId, name } = useLocalSearchParams<{ channelId: string; name?: string }>();
  if (!channelId) return null;
  return <MessagePane channelId={channelId} title={name || "Messages"} />;
}
