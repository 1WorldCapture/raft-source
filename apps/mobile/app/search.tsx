import { View } from "react-native";
import { useRouter } from "expo-router";
import { useT } from "../src/i18n/provider";
import { PanelHeader } from "../src/ui/PanelHeader";
import { ScreenMessage } from "../src/ui/screen";
import { color } from "../src/ui/tokens";

export default function SearchScreen() {
  const router = useRouter();
  const t = useT();
  return (
    <View style={{ backgroundColor: color.page, flex: 1 }}>
      <PanelHeader title={t("layout.sidebar.search")} onBack={() => router.back()} />
      <ScreenMessage title={t("search.emptyTitle")} body={t("search.emptyBody")} />
    </View>
  );
}
