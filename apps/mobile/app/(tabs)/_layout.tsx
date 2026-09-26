import { Tabs } from "expo-router";
import { HomeTabBar } from "../../src/home/TabBar";

export default function TabLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <HomeTabBar state={props.state} navigation={props.navigation} />}>
      <Tabs.Screen name="home" />
      <Tabs.Screen name="tasks" />
      <Tabs.Screen name="members" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}
