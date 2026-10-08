import { Tabs } from "expo-router";
import { HomeTabBar } from "../../src/home/TabBar";

export default function TabLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <HomeTabBar state={props.state} navigation={props.navigation} />}>
      <Tabs.Screen name="pm" />
      <Tabs.Screen name="dms" />
      <Tabs.Screen name="channels" />
    </Tabs>
  );
}
