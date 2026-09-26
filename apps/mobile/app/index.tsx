import { Redirect } from "expo-router";
import { useSession } from "../src/state/session";
import { LoadingScreen, ScreenMessage } from "../src/ui/screen";

export default function Index() {
  const session = useSession();
  if (!session.ready) return <LoadingScreen />;
  if (!session.origin) {
    return <ScreenMessage title="服务器地址未配置" body="构建时必须设置 EXPO_PUBLIC_RAFT_SERVER_URL，并且地址要能通过校验。" />;
  }
  if (!session.signedIn) return <Redirect href="/login" />;
  return <Redirect href="/servers" />;
}
