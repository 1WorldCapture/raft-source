import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowUp, CheckCircle2, MessageSquareText } from "lucide-react-native";
import { ActivityCard, ActivitySkeleton } from "../src/activity/ActivityCard";
import { ActivityMenu } from "../src/activity/ActivityMenu";
import {
  activityEmptyCopy,
  activityMenuActions,
  activityTargetMessageId,
  nextNewUpdateCount,
  nextUnreadKey,
  showMarkAllRead,
  type ActivityMenuAction,
} from "../src/activity/card";
import { activityKey, activityScopeId, type ActivityFilter, type ActivityItem } from "../src/activity/model";
import { useActivityStore } from "../src/activity/store";
import { useT } from "../src/i18n/provider";
import { loadDraft } from "../src/screens/composerDraft";
import { collectSenderNames } from "../src/screens/senderAvatars";
import { useSession } from "../src/state/session";
import { ScreenMessage } from "../src/ui/screen";
import { HardShadow } from "../src/ui/shadow";
import { PanelHeader } from "../src/ui/PanelHeader";
import { AppText } from "../src/ui/text";
import { border, color, shadowOffset } from "../src/ui/tokens";

const FILTERS: ActivityFilter[] = ["all", "unread", "mentions", "done"];
const LOAD_MORE_DISTANCE = 240;

const FILTER_LABEL = {
  all: "thread.filter.all",
  unread: "thread.filter.unread",
  mentions: "thread.filter.mentions",
  done: "activity.current.done",
} as const;

function firstParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw ?? "";
}

export default function ActivityScreen() {
  const session = useSession();
  const router = useRouter();
  const params = useLocalSearchParams<{ focus?: string }>();
  const focusFirstUnread = firstParam(params.focus) === "first-unread";
  const t = useT();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<ActivityItem>>(null);
  const items = useActivityStore((state) => state.items);
  const filter = useActivityStore((state) => state.filter);
  const loading = useActivityStore((state) => state.loading);
  const loadingMore = useActivityStore((state) => state.loadingMore);
  const loaded = useActivityStore((state) => state.loaded);
  const error = useActivityStore((state) => state.error);
  const totalCount = useActivityStore((state) => state.totalCount);
  const totalUnreadCount = useActivityStore((state) => state.totalUnreadCount);
  const [names, setNames] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [newUpdates, setNewUpdates] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ item: ActivityItem; x: number; y: number; openedAt: number } | null>(null);
  const nearTop = useRef(true);
  const previousTop = useRef<string | null>(null);
  const lastTitleTap = useRef(0);
  const consumedFocus = useRef(false);

  useFocusEffect(useCallback(() => {
    const state = useActivityStore.getState();
    if (state.loaded) void state.refresh(session.client);
    else void state.load(session.client, state.filter);
  }, [session.client]));

  useEffect(() => {
    const serverId = session.serverId;
    if (!serverId) return;
    let cancelled = false;
    void Promise.all([
      session.client.get<unknown>("/agents").catch(() => null),
      session.client.get<unknown>(`/servers/${serverId}/members`).catch(() => null),
    ]).then(([agents, members]) => {
      if (!cancelled) setNames(collectSenderNames(agents, members));
    });
    return () => {
      cancelled = true;
    };
  }, [session.client, session.serverId]);

  useEffect(() => {
    let cancelled = false;
    const ids = items.map(activityScopeId);
    void Promise.all(ids.map(async (id) => ((await loadDraft(id)).trim() ? id : null))).then((found) => {
      if (cancelled) return;
      setDrafts(new Set(found.filter((id): id is string => id !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [items]);

  useEffect(() => {
    nearTop.current = true;
    previousTop.current = null;
    setNewUpdates(0);
  }, [filter]);

  useEffect(() => {
    const top = items[0] ? activityKey(items[0]) : null;
    // Snapshot first. The setState updater runs on the next render, after this ref moves.
    const previous = previousTop.current;
    const atTop = nearTop.current;
    previousTop.current = top;
    setNewUpdates((count) => nextNewUpdateCount(previous, top, atTop, count));
  }, [items]);

  const reveal = useCallback((key: string) => {
    const index = useActivityStore.getState().items.findIndex((item) => activityKey(item) === key);
    setFocusKey(key);
    if (index < 0) return;
    requestAnimationFrame(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 }));
  }, []);

  useEffect(() => {
    if (!focusFirstUnread || consumedFocus.current || items.length === 0) return;
    const key = nextUnreadKey(items, null);
    if (!key) return;
    consumedFocus.current = true;
    reveal(key);
    router.setParams({ focus: "" });
  }, [focusFirstUnread, items, reveal, router]);

  useEffect(() => {
    if (!focusKey) return;
    const timer = setTimeout(() => setFocusKey((current) => (current === focusKey ? null : current)), 3000);
    return () => clearTimeout(timer);
  }, [focusKey]);

  const selectFilter = (next: ActivityFilter) => {
    if (next === filter && !loading) return;
    void useActivityStore.getState().load(session.client, next);
  };

  const refresh = async () => {
    setRefreshing(true);
    const state = useActivityStore.getState();
    if (state.loaded) await state.refresh(session.client);
    else await state.load(session.client, state.filter);
    setRefreshing(false);
  };

  const open = (item: ActivityItem) => {
    if (item.unreadCount > 0) void useActivityStore.getState().markRead(session.client, item);
    const targetMessageId = activityTargetMessageId(item);
    const target = targetMessageId ? { targetMessageId } : {};
    if (item.kind === "thread") {
      router.push({
        pathname: "/thread/[threadId]",
        params: {
          threadId: item.threadChannelId,
          parentChannelId: item.parentChannelId,
          parentMessageId: item.parentMessageId,
          title: t("message.threadPanel.thread"),
          ...target,
        },
      });
      return;
    }
    router.push({
      pathname: "/messages/[channelId]",
      params: { channelId: item.channelId, name: item.channelName, ...target },
    });
  };

  const runMenu = (item: ActivityItem, action: ActivityMenuAction) => {
    setMenu(null);
    const state = useActivityStore.getState();
    if (action === "read") void state.markRead(session.client, item);
    else if (action === "unread") void state.markUnread(session.client, item);
    else if (action === "done") void state.markDone(session.client, item);
    else if (action === "follow") void state.setFollowing(session.client, item, true);
    else void state.setFollowing(session.client, item, false);
  };

  const focusNextUnread = () => {
    const key = nextUnreadKey(useActivityStore.getState().items, focusKey);
    if (key) reveal(key);
  };

  const onTitlePress = () => {
    const now = Date.now();
    if (now - lastTitleTap.current < 350) {
      lastTitleTap.current = 0;
      focusNextUnread();
      return;
    }
    lastTitleTap.current = now;
  };

  const finish = (item: ActivityItem) => {
    const state = useActivityStore.getState();
    if (filter === "done") void state.markUndone(session.client, item);
    else void state.markDone(session.client, item);
  };

  const maybeLoadMore = (distance: number) => {
    if (distance <= LOAD_MORE_DISTANCE) void useActivityStore.getState().loadMore(session.client);
  };

  const showSkeleton = loading && items.length === 0;
  const showFailure = !loading && !loaded && error && items.length === 0;
  const empty = activityEmptyCopy(filter);

  return (
    <View style={styles.page}>
      <PanelHeader
        onBack={() => router.back()}
        onTitlePress={onTitlePress}
        subtitle={t("thread.header.subtitle", { activeCount: totalCount, unreadCount: totalUnreadCount })}
        title={t("thread.header.title")}
      />
      <View style={styles.toolbar}>
        <ScrollView
          horizontal
          contentContainerStyle={styles.filters}
          showsHorizontalScrollIndicator={false}
          style={styles.filterScroll}
        >
          {FILTERS.map((value) => (
            <FilterChip key={value} label={t(FILTER_LABEL[value])} onPress={() => selectFilter(value)} selected={filter === value} />
          ))}
        </ScrollView>
        {showMarkAllRead(filter, totalUnreadCount) ? (
          <Pressable
            accessibilityLabel={t("thread.markAllRead.title")}
            accessibilityRole="button"
            onPress={() => void useActivityStore.getState().markAllRead(session.client)}
            style={styles.markAll}
          >
            <HardShadow offset={shadowOffset.sm}>
              <View style={styles.markAllFace}>
                <AppText style={styles.chipText}>{t("thread.markAllRead.label")}</AppText>
              </View>
            </HardShadow>
          </Pressable>
        ) : null}
      </View>
      {error && items.length > 0 ? <AppText style={styles.error}>{error}</AppText> : null}
      {showSkeleton ? (
        <View style={styles.list}>
          {Array.from({ length: 6 }, (_, index) => <ActivitySkeleton key={index} />)}
        </View>
      ) : showFailure ? (
        <ScreenMessage body={error} title={t("mobile.channels.loadFailed")} />
      ) : (
        <View style={styles.timeline}>
          {newUpdates > 0 ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setNewUpdates(0);
                nearTop.current = true;
                listRef.current?.scrollToOffset({ offset: 0, animated: true });
              }}
              style={styles.updates}
            >
              <HardShadow offset={shadowOffset.sm}>
                <View style={styles.updatesFace}>
                  <ArrowUp color={color.ink} size={14} strokeWidth={2.5} />
                  <AppText style={styles.chipText}>{t("thread.newUpdates", { count: newUpdates })}</AppText>
                </View>
              </HardShadow>
            </Pressable>
          ) : null}
          <FlatList
            ref={listRef}
            contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 16 }, items.length === 0 ? styles.listEmpty : null]}
            data={items}
            extraData={focusKey}
            keyExtractor={(item) => activityKey(item)}
            ListEmptyComponent={
              <View style={styles.empty}>
                {filter === "done"
                  ? <CheckCircle2 color={color.ink} size={36} strokeWidth={2.25} />
                  : <MessageSquareText color={color.ink} size={36} strokeWidth={2.25} />}
                <AppText style={styles.emptyTitle}>{t(empty.title)}</AppText>
                <AppText style={styles.emptyBody}>{t(empty.description)}</AppText>
              </View>
            }
            ListFooterComponent={loadingMore ? <AppText style={styles.more}>{t("thread.loadingMore")}</AppText> : null}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              nearTop.current = contentOffset.y < 50;
              if (nearTop.current) setNewUpdates((count) => (count === 0 ? count : 0));
              maybeLoadMore(contentSize.height - layoutMeasurement.height - contentOffset.y);
            }}
            onScrollToIndexFailed={(info) => {
              listRef.current?.scrollToOffset({ offset: Math.max(0, info.averageItemLength * info.index), animated: false });
              setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0 }), 50);
            }}
            refreshControl={<RefreshControl colors={[color.ink]} onRefresh={() => void refresh()} refreshing={refreshing} tintColor={color.ink} />}
            renderItem={({ item }) => (
              <ActivityCard
                filter={filter}
                focused={focusKey === activityKey(item)}
                hasDraft={drafts.has(activityScopeId(item))}
                item={item}
                names={names}
                onDone={() => finish(item)}
                onLongPress={(x, y) => setMenu({ item, x, y, openedAt: Date.now() })}
                onOpen={() => open(item)}
              />
            )}
            scrollEventThrottle={32}
          />
        </View>
      )}
      {menu ? (
        <ActivityMenu
          actions={activityMenuActions(menu.item)}
          labels={{
            read: t("thread.contextMenu.markAsRead"),
            unread: t("thread.contextMenu.markAsUnread"),
            done: t("thread.contextMenu.done"),
            follow: t("thread.contextMenu.follow"),
            unfollow: t("thread.contextMenu.unfollow"),
          }}
          onAction={(action) => runMenu(menu.item, action)}
          onClose={() => setMenu(null)}
          openedAt={menu.openedAt}
          x={menu.x}
          y={menu.y}
        />
      ) : null}
    </View>
  );
}

function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const face = (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.chip, selected ? styles.chipOn : styles.chipOff]}>
      <AppText style={styles.chipText}>{label}</AppText>
    </Pressable>
  );
  if (!selected) return face;
  return <HardShadow offset={shadowOffset.sm}>{face}</HardShadow>;
}

const styles = StyleSheet.create({
  page: { backgroundColor: color.page, flex: 1 },
  toolbar: {
    alignItems: "center",
    borderBottomColor: color.border,
    borderBottomWidth: border.strong,
    flexDirection: "row",
    height: 54,
    paddingHorizontal: 16,
  },
  filterScroll: { flex: 1 },
  filters: { alignItems: "center", gap: 8, paddingRight: 8 },
  chip: {
    alignItems: "center",
    borderWidth: border.strong,
    height: 32,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  chipOn: { backgroundColor: color.yellow, borderColor: color.border },
  chipOff: { backgroundColor: color.page, borderColor: color.border },
  chipText: { color: color.ink, fontSize: 12, fontWeight: "700", lineHeight: 16 },
  markAll: { marginLeft: 8 },
  markAllFace: {
    alignItems: "center",
    backgroundColor: color.page,
    borderColor: color.border,
    borderWidth: border.strong,
    height: 32,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  error: { color: color.red, fontSize: 12, lineHeight: 16, paddingHorizontal: 16, paddingTop: 8 },
  timeline: { flex: 1 },
  updates: { alignSelf: "center", position: "absolute", top: 8, zIndex: 2 },
  updatesFace: {
    alignItems: "center",
    backgroundColor: color.page,
    borderColor: color.border,
    borderWidth: border.strong,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  list: { gap: 8, padding: 16 },
  listEmpty: { flexGrow: 1 },
  more: { color: color.muted, fontSize: 12, lineHeight: 16, textAlign: "center" },
  empty: { alignItems: "center", flex: 1, justifyContent: "center", paddingHorizontal: 24 },
  emptyTitle: { color: color.ink, fontSize: 18, fontWeight: "600", lineHeight: 24, marginTop: 12, textAlign: "center" },
  emptyBody: { color: color.muted, fontSize: 14, lineHeight: 20, marginTop: 4, textAlign: "center" },
});
