import { Redirect } from "expo-router";
import { useSession } from "../src/state/session";
import { LoadingScreen } from "../src/ui/screen";

export default function Index() {
  const session = useSession();
  if (!session.ready) return <LoadingScreen />;
  if (!session.origin) return <Redirect href="/server" />;
  if (!session.signedIn) return <Redirect href="/login" />;
  return <Redirect href="/servers" />;
}
