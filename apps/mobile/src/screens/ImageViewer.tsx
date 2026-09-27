import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { ArrowLeft, Download } from "lucide-react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { StaleRequestError } from "../api/client";
import { attachmentDownloadUrl, rewriteAttachmentUrl } from "../api/attachmentUrl";
import {
  clampOffset,
  clampZoom,
  isDismissSwipe,
  nextDoubleTapZoom,
} from "../attachments/imageViewerMath";
import type { MessageAttachment } from "../model/messages";
import { downloadAndShareAttachment } from "./attachmentFile";
import { useT } from "../i18n/provider";
import { AppText } from "../ui/text";
import { color } from "../ui/tokens";

export interface ImageViewerEntry {
  attachment: MessageAttachment;
  /** Pre-resolved inline URL (already rewritten); the viewer refreshes once on error. */
  url: string | null;
}

/** Full-screen black image viewer: expo-image pages with pinch/double-tap zoom,
 *  drag-when-zoomed, swipe-down to dismiss at 1x, and horizontal pagination
 *  across every image of the message. */
export function ImageViewer({
  images,
  index,
  origin,
  getAccessToken,
  getHeaders,
  refreshTokens,
  resolve,
  onClose,
}: {
  images: MessageAttachment[];
  index: number;
  origin: string | null;
  getAccessToken: () => string | null;
  getHeaders: () => Record<string, string>;
  refreshTokens: () => Promise<void>;
  resolve: (attachment: MessageAttachment, options?: { refresh?: boolean }) => Promise<string | null>;
  onClose: () => void;
}) {
  const t = useT();
  const [current, setCurrent] = useState(index);
  const [zoomed, setZoomed] = useState(false);
  const [sharing, setSharing] = useState(false);
  const listRef = useRef<Animated.FlatList<ViewerPageData> | null>(null);
  const pages = useMemo<ViewerPageData[]>(() => images.map((attachment) => ({ attachment })), [images]);

  useEffect(() => {
    setZoomed(false);
  }, [current]);

  const share = useCallback(async () => {
    const attachment = images[current];
    if (!attachment.id || !origin || sharing) return;
    setSharing(true);
    try {
      await downloadAndShareAttachment({
        url: attachmentDownloadUrl(origin, attachment.id),
        getAccessToken,
        getHeaders,
        refreshTokens,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
      });
    } catch (error) {
      if (!(error instanceof StaleRequestError)) {
        // The share sheet failing is non-fatal inside the viewer; keep it open.
      }
    } finally {
      setSharing(false);
    }
  }, [current, getAccessToken, getHeaders, images, origin, refreshTokens, sharing]);

  return (
    <Modal animationType="fade" onRequestClose={onClose} statusBarTranslucent visible>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="Back" hitSlop={8} onPress={onClose} style={styles.headerButton}>
            <ArrowLeft color={color.white} size={22} strokeWidth={2.5} />
          </Pressable>
          <AppText numberOfLines={1} style={styles.headerTitle}>
            {images[current]?.filename ?? ""}
          </AppText>
          <Pressable accessibilityLabel={t("mobile.preview.share")} hitSlop={8} onPress={() => void share()} style={styles.headerButton}>
            <Download color={sharing ? color.muted : color.white} size={20} strokeWidth={2.5} />
          </Pressable>
        </View>
        <View style={styles.pagerHost}>
          <Animated.FlatList
            ref={listRef}
            data={pages}
            horizontal
            initialNumToRender={Math.min(pages.length, index + 2)}
            keyExtractor={(item, i) => item.attachment.id ?? `${i}-${item.attachment.filename}`}
            onMomentumScrollEnd={(event) => {
              const next = Math.round(event.nativeEvent.contentOffset.x / event.nativeEvent.layoutMeasurement.width);
              if (next !== current) setCurrent(next);
            }}
            pagingEnabled
            renderItem={({ item, index: i }) => (
              <ViewerPage
                active={i === current}
                onZoomChange={setZoomed}
                origin={origin}
                resolve={resolve}
                onClose={onClose}
                attachment={item.attachment}
              />
            )}
            scrollEnabled={!zoomed}
            showsHorizontalScrollIndicator={false}
            style={styles.pager}
            windowSize={3}
          />
          {pages.length > 1 ? (
            <View pointerEvents="none" style={styles.indicator}>
              <AppText style={styles.indicatorText}>
                {current + 1}/{pages.length}
              </AppText>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

interface ViewerPageData {
  attachment: MessageAttachment;
}

function ViewerPage({
  attachment,
  active,
  origin,
  resolve,
  onZoomChange,
  onClose,
}: {
  attachment: MessageAttachment;
  active: boolean;
  origin: string | null;
  resolve: (attachment: MessageAttachment, options?: { refresh?: boolean }) => Promise<string | null>;
  onZoomChange: (zoomed: boolean) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const [uri, setUri] = useState<string | null>(initialUri(attachment, origin));
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomedLocal] = useState(false);

  const scale = useSharedValue(1);
  const baseScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const dragY = useSharedValue(0);
  const backdrop = useSharedValue(1);

  const setZoomed = useCallback(
    (value: boolean) => {
      setZoomedLocal(value);
      onZoomChange(value);
    },
    [onZoomChange],
  );

  useEffect(() => {
    if (active) return;
    // A background page always resets so returning to it starts clean.
    scale.value = withTiming(1);
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    dragY.value = withTiming(0);
    backdrop.value = withTiming(1);
    if (zoomed) setZoomed(false);
  }, [active, backdrop, scale, translateX, translateY, dragY, zoomed, setZoomed]);

  useEffect(() => {
    if (attempt === 0 && uri) return;
    let cancelled = false;
    void resolve(attachment, { refresh: attempt > 0 })
      .then((url) => {
        if (!cancelled) setUri(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // Re-resolve on retry; initial resolve covers entries without a pre-resolved URL.
  }, [attempt, attachment, resolve, uri]);

  const pinch = Gesture.Pinch()
    .onStart(() => {
      "worklet";
      baseScale.value = scale.value;
    })
    .onUpdate((event) => {
      "worklet";
      scale.value = clampZoom(baseScale.value * event.scale);
      if (scale.value <= 1.01) {
        translateX.value = 0;
        translateY.value = 0;
      }
    })
    .onEnd(() => {
      "worklet";
      if (scale.value <= 1.01) {
        runOnJS(setZoomed)(false);
      } else {
        runOnJS(setZoomed)(true);
      }
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((_event, success) => {
      "worklet";
      if (!success) return;
      const target = nextDoubleTapZoom(scale.value);
      scale.value = withTiming(target);
      translateX.value = withTiming(0);
      translateY.value = withTiming(0);
      runOnJS(setZoomed)(target > 1);
    });

  // Drag while zoomed: pan the over-scroll rectangle, clamped to the edges.
  const prevX = useSharedValue(0);
  const prevY = useSharedValue(0);
  const zoomPan = Gesture.Pan()
    .enabled(zoomed)
    .onStart(() => {
      "worklet";
      prevX.value = 0;
      prevY.value = 0;
    })
    .onUpdate((event) => {
      "worklet";
      translateX.value = clampOffset(
        translateX.value + (event.translationX - prevX.value) / scale.value,
        scale.value,
        viewportWidth,
      );
      translateY.value = clampOffset(
        translateY.value + (event.translationY - prevY.value) / scale.value,
        scale.value,
        viewportHeight,
      );
      prevX.value = event.translationX;
      prevY.value = event.translationY;
    })
    .onEnd(() => {
      "worklet";
      translateX.value = withTiming(clampOffset(translateX.value, scale.value, viewportWidth));
      translateY.value = withTiming(clampOffset(translateY.value, scale.value, viewportHeight));
    });

  // Swipe-down to dismiss at 1x; vertical-dominant only so pagination keeps horizontal drags.
  const dismissPan = Gesture.Pan()
    .activeOffsetY([-12, 12])
    .failOffsetX([-24, 24])
    .enabled(!zoomed)
    .onUpdate((event) => {
      "worklet";
      dragY.value = Math.max(0, event.translationY);
      backdrop.value = Math.max(0.35, 1 - dragY.value / 500);
    })
    .onEnd((event) => {
      "worklet";
      if (isDismissSwipe(event.translationX, event.translationY)) {
        backdrop.value = withTiming(0);
        runOnJS(onClose)();
        return;
      }
      dragY.value = withTiming(0);
      backdrop.value = withTiming(1);
    });

  const gesture = Gesture.Simultaneous(Gesture.Simultaneous(pinch, doubleTap), zoomPan, dismissPan);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value + dragY.value },
      { scale: scale.value },
    ],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdrop.value,
  }));

  return (
    <View style={styles.page}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]} />
      <GestureDetector gesture={gesture}>
        <Animated.View style={styles.pageContent}>
          {uri && !failed ? (
            <Animated.View style={[styles.imageHost, imageStyle]}>
              <Image
                allowDownscaling
                contentFit="contain"
                cachePolicy="memory-disk"
                onError={() => {
                  if (attempt >= 1) {
                    setFailed(true);
                    return;
                  }
                  setAttempt(1);
                }}
                source={{ uri }}
                style={styles.image}
                transition={120}
              />
            </Animated.View>
          ) : null}
          {!uri && !failed ? (
            <View pointerEvents="none" style={styles.centerNote}>
              <ActivityIndicator color={color.white} />
              <AppText style={styles.note}>{t("mobile.preview.loading")}</AppText>
            </View>
          ) : null}
          {failed ? (
            <View style={styles.centerNote}>
              <AppText style={styles.note}>{t("mobile.preview.failed")}</AppText>
              <Pressable
                onPress={() => {
                  setFailed(false);
                  setAttempt((current) => current + 1);
                }}
                style={styles.retry}
              >
                <AppText style={styles.retryText}>{t("mobile.preview.retry")}</AppText>
              </Pressable>
            </View>
          ) : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/** SVG pages need the server's raster preview; other images resolve inline. */
function initialUri(attachment: MessageAttachment, origin: string | null): string | null {
  const raster = attachment.rasterPreviewUrl;
  if (raster) return rewriteAttachmentUrl(raster, origin);
  return null;
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#000000", flex: 1 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
  },
  headerButton: { padding: 8 },
  headerTitle: {
    color: color.white,
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
  },
  pagerHost: { flex: 1 },
  pager: { flex: 1 },
  page: { flex: 1 },
  backdrop: { backgroundColor: "#000000" },
  pageContent: { flex: 1 },
  imageHost: { flex: 1 },
  image: { flex: 1 },
  centerNote: {
    alignItems: "center",
    bottom: 0,
    gap: 12,
    justifyContent: "center",
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  note: { color: color.muted, fontSize: 14 },
  retry: {
    borderColor: color.white,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  retryText: { color: color.white, fontSize: 14, fontWeight: "700" },
  indicator: {
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 12,
    bottom: 24,
    paddingHorizontal: 10,
    paddingVertical: 4,
    position: "absolute",
  },
  indicatorText: { color: color.white, fontSize: 12 },
});
