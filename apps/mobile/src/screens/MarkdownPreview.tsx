import { useMemo, type ReactNode } from "react";
import { StyleSheet, View, type ImageStyle, type TextStyle } from "react-native";
import Markdown, { Renderer } from "react-native-marked";
import type { MarkedStyles } from "react-native-marked";
import { isHttpUrl } from "../attachments/markdownUrl";
import { HardShadow } from "../ui/shadow";
import { border, color, shadowOffset } from "../ui/tokens";
import { TruncationBanner } from "./TruncationBanner";

/** Reads like the web document pane: Space Grotesk body on a white brutal
 *  card, mono code, hairline tables. Headings scale h1-h4 and flatten below. */
const markedStyles: MarkedStyles = {
  text: { color: color.ink, fontFamily: "SpaceGrotesk-400", fontSize: 16, lineHeight: 24 },
  paragraph: { marginBottom: 10 },
  strong: { fontFamily: "SpaceGrotesk-700" },
  em: { fontStyle: "italic" },
  strikethrough: { textDecorationLine: "line-through" },
  link: {
    color: color.link,
    fontFamily: "SpaceGrotesk-400",
    fontStyle: "normal",
    textDecorationLine: "underline",
  },
  h1: { color: color.ink, fontFamily: "SpaceGrotesk-700", fontSize: 28, lineHeight: 34, marginBottom: 8, marginTop: 24 },
  h2: { color: color.ink, fontFamily: "SpaceGrotesk-700", fontSize: 24, lineHeight: 30, marginBottom: 8, marginTop: 20 },
  h3: { color: color.ink, fontFamily: "SpaceGrotesk-700", fontSize: 20, lineHeight: 26, marginBottom: 6, marginTop: 16 },
  h4: { color: color.ink, fontFamily: "SpaceGrotesk-700", fontSize: 17, lineHeight: 24, marginBottom: 6, marginTop: 14 },
  h5: { color: color.ink, fontFamily: "SpaceGrotesk-700", fontSize: 15, lineHeight: 22, marginBottom: 4, marginTop: 12 },
  h6: { color: color.inkSoft, fontFamily: "SpaceGrotesk-700", fontSize: 14, lineHeight: 20, marginBottom: 4, marginTop: 12 },
  blockquote: { borderLeftColor: color.quoteBorder, borderLeftWidth: 4, marginBottom: 10, paddingLeft: 12 },
  codespan: {
    backgroundColor: color.inlineCode,
    color: color.ink,
    fontFamily: "SpaceMono-400",
    fontSize: 14,
    fontStyle: "normal",
  },
  code: {
    backgroundColor: color.mutedFill,
    borderColor: color.border,
    borderWidth: border.strong,
    padding: 12,
  },
  codeText: {
    color: color.ink,
    fontFamily: "SpaceMono-400",
    fontSize: 13,
    fontStyle: "normal",
    lineHeight: 20,
  },
  hr: {
    borderBottomColor: color.border,
    borderBottomWidth: border.strong,
    marginBottom: 16,
    marginTop: 16,
  },
  list: { marginBottom: 10 },
  li: { color: color.ink, fontFamily: "SpaceGrotesk-400", fontSize: 16, lineHeight: 24 },
  table: { borderColor: color.border, borderWidth: border.strong, marginBottom: 10 },
  tableRow: { borderBottomColor: color.border, borderBottomWidth: 1 },
  tableCell: { padding: 6 },
};

/** Same rules as the web attachment pane: follow only absolute http(s) links,
 *  load only absolute http(s) images (alt text otherwise), and render raw
 *  HTML as inert text. Mermaid fences degrade to ordinary code blocks. */
class AttachmentMarkdownRenderer extends Renderer {
  override link(children: string | ReactNode[], href: string, styles?: TextStyle, title?: string) {
    if (!isHttpUrl(href)) return this.text(children, markedStyles.text);
    return super.link(children, href, styles, title);
  }

  override image(uri: string, alt?: string, style?: ImageStyle, title?: string) {
    if (!isHttpUrl(uri)) {
      return this.text(alt || title || "", { color: color.mutedStrong, fontStyle: "italic" });
    }
    return super.image(uri, alt, style, title);
  }

  override html(text: string | ReactNode[], styles?: TextStyle) {
    return this.text(text, { ...styles, color: color.mutedStrong });
  }
}

export function MarkdownPreview({ markdown, truncated }: { markdown: string; truncated: boolean }) {
  const renderer = useMemo(() => new AttachmentMarkdownRenderer({ selectable: true }), []);
  return (
    <View style={styles.canvas}>
      {truncated ? <TruncationBanner /> : null}
      <HardShadow offset={shadowOffset.sm} style={styles.shadow}>
        <View style={styles.sheet}>
          <Markdown
            value={markdown}
            renderer={renderer}
            styles={markedStyles}
            flatListProps={{ contentContainerStyle: styles.sheetContent }}
          />
        </View>
      </HardShadow>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { backgroundColor: color.previewCream, flex: 1, padding: 16 },
  shadow: { flex: 1 },
  sheet: {
    backgroundColor: color.white,
    borderColor: color.border,
    borderWidth: border.strong,
    flex: 1,
  },
  sheetContent: { padding: 16 },
});
