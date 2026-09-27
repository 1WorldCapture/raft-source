import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from "react-native";
import type { AttachmentPreviewResponse } from "@botiverse/raft-shared/src/attachmentPreview.ts";
import { attachmentDownloadUrl } from "../api/attachmentUrl";
import { StaleRequestError } from "../api/client";
import { attachmentPreviewCache } from "../attachments/previewSession";
import { useT } from "../i18n/provider";
import type { MessageAttachment } from "../model/messages";
import { downloadAndShareAttachment } from "./attachmentFile";
import { MarkdownPreview } from "./MarkdownPreview";
import { TextPreview } from "./TextPreview";
import { AppText } from "../ui/text";
import { HeaderIconButton, PanelHeader } from "../ui/PanelHeader";
import { HardShadow } from "../ui/shadow";
import { border, color, shadowOffset } from "../ui/tokens";

type Phase = "loading" | "error" | "unsupported" | "ready";

function formatAttachmentSize(bytes?: number): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

function isPreview(data: unknown): data is AttachmentPreviewResponse {
  if (!data || typeof data !== "object") return false;
  const status = (data as { status?: unknown }).status;
  return status === "ok" || status === "unsupported";
}

/**
 * Full-screen modal instead of a route: the viewer is opened from the message
 * that is already on screen, and it needs that screen's session client to
 * download and share. A route would have to rebuild both.
 */
export function AttachmentViewer({
  attachment,
  origin,
  getAccessToken,
  getHeaders,
  refreshTokens,
  loadPreview,
  onClose,
}: {
  attachment: MessageAttachment;
  origin: string | null;
  getAccessToken: () => string | null;
  getHeaders: () => Record<string, string>;
  refreshTokens: () => Promise<void>;
  loadPreview: (id: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("loading");
  const [attempt, setAttempt] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(false);
  const [preview, setPreview] = useState<AttachmentPreviewResponse | null>(null);
  const id = attachment.id;
  const loadPreviewRef = useRef(loadPreview);
  loadPreviewRef.current = loadPreview;

  useEffect(() => {
    if (!id) {
      setPhase("error");
      return;
    }
    let cancelled = false;
    setPhase("loading");
    setPreview(null);
    void attachmentPreviewCache.load(id, async (attachmentId) => {
      const data = await loadPreviewRef.current(attachmentId);
      if (!isPreview(data)) throw new Error("preview payload");
      return data;
    }).then((loaded) => {
      if (cancelled) return;
      if (loaded.status !== "ok" || (loaded.data.kind === "text" && loaded.data.text.length === 0)
        || (loaded.data.kind === "markdown" && loaded.data.markdown.length === 0)) {
        setPhase("unsupported");
        return;
      }
      setPreview(loaded);
      setPhase("ready");
    }).catch((error: unknown) => {
      if (cancelled || error instanceof StaleRequestError) return;
      setPhase("error");
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, id]);

  async function share() {
    if (!id || !origin || sharing) return;
    setSharing(true);
    setShareError(false);
    try {
      await downloadAndShareAttachment({
        url: attachmentDownloadUrl(origin, id),
        getAccessToken,
        getHeaders,
        refreshTokens,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
      });
    } catch (error) {
      if (!(error instanceof StaleRequestError)) setShareError(true);
    } finally {
      setSharing(false);
    }
  }

  const textPreview = preview?.status === "ok" && preview.data.kind === "text"
    ? { text: preview.data.text, truncated: preview.truncated === true }
    : null;

  const markdownPreview = preview?.status === "ok" && preview.data.kind === "markdown"
    ? { markdown: preview.data.markdown, truncated: preview.truncated === true }
    : null;

  const shareButton = (
    <HeaderIconButton accessibilityLabel={t("mobile.preview.share")} onPress={() => void share()} wide>
      <AppText style={styles.shareLabel}>{sharing ? t("mobile.attachments.downloading") : t("mobile.preview.share")}</AppText>
    </HeaderIconButton>
  );

  return (
    <Modal animationType="slide" onRequestClose={onClose} visible>
      <View style={styles.screen}>
        <PanelHeader
          actions={shareButton}
          onBack={onClose}
          subtitle={formatAttachmentSize(attachment.sizeBytes)}
          title={attachment.filename}
        />
        <View style={[styles.body, textPreview || markdownPreview ? styles.bodyText : null]}>
          {shareError ? <AppText style={styles.shareError}>{t("mobile.attachments.failed")}</AppText> : null}
          {phase === "loading" ? (
            <View style={styles.center}>
              <ActivityIndicator color={color.ink} />
              <AppText style={styles.note}>{t("mobile.preview.loading")}</AppText>
            </View>
          ) : null}
          {phase === "error" ? (
            <View style={styles.center}>
              <AppText style={styles.reason}>{t("mobile.preview.failed")}</AppText>
              <Pressable onPress={() => setAttempt((current) => current + 1)}>
                <HardShadow offset={shadowOffset.sm}>
                  <View style={styles.retry}>
                    <AppText style={styles.retryLabel}>{t("mobile.preview.retry")}</AppText>
                  </View>
                </HardShadow>
              </Pressable>
              {shareButton}
            </View>
          ) : null}
          {phase === "unsupported" ? (
            <View style={styles.center}>
              <AppText style={styles.reason}>{t("mobile.preview.unsupported")}</AppText>
              {shareButton}
            </View>
          ) : null}
          {phase === "ready" && textPreview ? (
            <TextPreview text={textPreview.text} truncated={textPreview.truncated} />
          ) : null}
          {phase === "ready" && markdownPreview ? (
            <MarkdownPreview markdown={markdownPreview.markdown} truncated={markdownPreview.truncated} />
          ) : null}
          {phase === "ready" && !textPreview && !markdownPreview ? (
            <View style={styles.placeholder}>
              <AppText style={styles.note}>{t("mobile.preview.placeholder")}</AppText>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: color.page, flex: 1 },
  body: { flex: 1, padding: 16 },
  bodyText: { padding: 0 },
  center: { alignItems: "center", flex: 1, gap: 12, justifyContent: "center" },
  note: { color: color.mutedStrong, fontSize: 14 },
  reason: { color: color.ink, fontSize: 16, fontWeight: "700", textAlign: "center" },
  shareError: { color: color.ink, fontSize: 14, fontWeight: "700", textAlign: "center" },
  retry: {
    backgroundColor: color.page,
    borderColor: color.border,
    borderWidth: border.strong,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  retryLabel: { color: color.ink, fontWeight: "700" },
  shareLabel: { color: color.ink, fontSize: 12, fontWeight: "700" },
  placeholder: {
    backgroundColor: color.white,
    borderColor: color.border,
    borderWidth: 2,
    flex: 1,
    justifyContent: "center",
    padding: 16,
  },
});
