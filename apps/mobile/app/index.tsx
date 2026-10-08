import { Redirect } from "expo-router";
import { useT } from "../src/i18n/provider";
import { useSession } from "../src/state/session";
import { LoadingScreen, ScreenMessage } from "../src/ui/screen";

export default function Index() {
  const session = useSession();
  const t = useT();
  if (!session.ready) return <LoadingScreen />;
  if (!session.origin) {
    return <ScreenMessage title={t("mobile.config.missingTitle")} body={t("mobile.config.missingBody")} />;
  }
  if (!session.signedIn) return <Redirect href="/login" />;
  return <Redirect href="/pm" />;
}
