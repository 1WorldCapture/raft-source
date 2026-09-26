import { Linking, ScrollView, Text, View } from "react-native";
import { inlineTokens, type InlineToken } from "../model/inlineTokens";
import { markdownPieces, type MarkdownPiece } from "../model/markdown";
import type { MessageMention } from "../model/messages";
import { latinFamily } from "./fonts";
import { AppText } from "./text";
import { color } from "./tokens";

type Block =
  | { kind: "paragraph"; pieces: MarkdownPiece[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; text: string }
  | { kind: "codeBlock"; text: string };

export function RichText({
  content,
  mentions,
  currentUserId,
  fontSize = 16,
  lineHeight = 22,
  agentRead,
}: {
  content: string;
  mentions?: MessageMention[];
  currentUserId?: string;
  fontSize?: number;
  lineHeight?: number;
  agentRead?: (agentId: string) => boolean | null;
}) {
  const blocks = blockPieces(markdownPieces(content));
  return (
    <View>
      {blocks.map((block, index) => {
        if (block.kind === "codeBlock") {
          return (
            <ScrollView horizontal key={index} style={codeBlock}>
              <AppText style={{ color: color.codeForeground, fontFamily: "mono", fontSize }}>{block.text}</AppText>
            </ScrollView>
          );
        }
        if (block.kind === "heading") {
          const scale = block.level === 1 ? 1.286 : block.level === 2 ? 1.15 : 1.08;
          return (
            <AppText key={index} style={{ color: color.ink, fontSize: fontSize * scale, fontWeight: "700", lineHeight: lineHeight * scale, marginBottom: 2, marginTop: 4 }}>
              {tokens(block.text, mentions, currentUserId, agentRead, fontSize)}
            </AppText>
          );
        }
        if (block.kind === "quote") {
          return (
            <View key={index} style={{ borderLeftColor: color.quoteBorder, borderLeftWidth: 2, marginVertical: 2, paddingLeft: 12 }}>
              <AppText style={{ color: color.mutedStrong, fontSize, fontStyle: "italic", lineHeight }}>{tokens(block.text, mentions, currentUserId, agentRead, fontSize)}</AppText>
            </View>
          );
        }
        if (block.kind === "list") {
          return (
            <AppText key={index} style={{ color: color.ink, fontSize, lineHeight }}>{`• `}{tokens(block.text, mentions, currentUserId, agentRead, fontSize)}</AppText>
          );
        }
        return (
          <AppText key={index} style={{ color: color.ink, fontSize, lineHeight }}>
            {block.pieces.map((piece, pieceIndex) => inlinePiece(piece, pieceIndex, mentions, currentUserId, agentRead, fontSize))}
          </AppText>
        );
      })}
    </View>
  );
}

function inlinePiece(
  piece: MarkdownPiece,
  index: number,
  mentions: MessageMention[] | undefined,
  currentUserId: string | undefined,
  agentRead: ((agentId: string) => boolean | null) | undefined,
  fontSize: number,
) {
  if (piece.type === "bold") return <Text key={index} style={{ fontFamily: latinFamily("700"), fontWeight: "700" }}>{tokens(piece.text, mentions, currentUserId, agentRead, fontSize)}</Text>;
  if (piece.type === "code") {
    return <Text key={index} style={{ backgroundColor: color.inlineCode, fontFamily: "SpaceMono-400", fontSize: fontSize * 0.875 }}>{piece.text}</Text>;
  }
  if (piece.type === "link") {
    return (
      <Text
        key={index}
        onPress={() => {
          if (piece.url.startsWith("https://") || piece.url.startsWith("http://")) void Linking.openURL(piece.url);
        }}
        style={{ color: color.link, fontFamily: latinFamily(), textDecorationColor: color.link, textDecorationLine: "underline" }}
      >
        {piece.text}
      </Text>
    );
  }
  if (piece.type === "text") return <Text key={index} style={{ fontFamily: latinFamily() }}>{tokens(piece.text, mentions, currentUserId, agentRead, fontSize)}</Text>;
  return null;
}

function tokens(
  text: string,
  mentions: MessageMention[] | undefined,
  currentUserId: string | undefined,
  agentRead: ((agentId: string) => boolean | null) | undefined,
  fontSize: number,
) {
  return inlineTokens(text, mentions, currentUserId).map((token, index) => chip(token, index, agentRead, fontSize));
}

function chip(
  token: InlineToken,
  index: number,
  agentRead: ((agentId: string) => boolean | null) | undefined,
  fontSize: number,
) {
  if (token.kind === "text") return <Text key={index} style={{ fontFamily: latinFamily() }}>{token.text}</Text>;
  const read = token.kind === "mention" && token.type === "agent" ? agentRead?.(token.id ?? "") : null;
  const background = token.kind === "mention" && token.self
    ? color.yellow
    : token.kind === "channel"
      ? color.pinkChip
      : token.kind === "thread"
        ? color.cyanSoft
        : token.kind === "task"
          ? color.yellowSoft
          : undefined;
  const bordered = background !== undefined;
  return (
    <Text
      key={index}
      style={{
        backgroundColor: background,
        borderColor: bordered ? color.border : undefined,
        borderRadius: bordered ? 4 : 0,
        borderWidth: bordered ? 1 : 0,
        fontFamily: latinFamily("700"),
        fontSize: bordered ? fontSize * 0.875 : undefined,
        fontWeight: "700",
        textDecorationLine: token.kind === "mention" && !token.self ? "underline" : "none",
      }}
    >
      {token.text}
      {read === null || read === undefined ? "" : read ? " ●" : " ○"}
    </Text>
  );
}

function blockPieces(pieces: MarkdownPiece[]): Block[] {
  const blocks: Block[] = [];
  let paragraph: MarkdownPiece[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", pieces: paragraph });
    paragraph = [];
  };
  for (const piece of pieces) {
    if (piece.type === "text" && piece.text === "\n") {
      flush();
      continue;
    }
    if (piece.type === "heading") {
      flush();
      blocks.push({ kind: "heading", level: piece.level, text: piece.text });
      continue;
    }
    if (piece.type === "quote" || piece.type === "list" || piece.type === "codeBlock") {
      flush();
      blocks.push({ kind: piece.type, text: piece.text });
      continue;
    }
    paragraph.push(piece);
  }
  flush();
  return blocks;
}

const codeBlock = {
  backgroundColor: color.codeSurface,
  borderColor: color.border,
  borderWidth: 2,
  marginVertical: 4,
  padding: 12,
} as const;
