import { Text } from "react-native";
import { markdownPieces } from "../model/markdown";
import { mentionSegments } from "../model/mentions";
import type { MessageMention } from "../model/messages";
import { colors } from "./theme";

export function RichText({
  content,
  mentions,
  mine,
}: {
  content: string;
  mentions?: MessageMention[];
  mine?: boolean;
}) {
  const segments = mentionSegments(content, mentions);
  return (
    <Text style={{ color: mine ? "#fff" : colors.ink, fontSize: 16, lineHeight: 22 }}>
      {segments.map((segment, index) => segment.mention ? (
        <Text key={index} style={{ color: mine ? "#fff" : colors.accent, fontWeight: "700", textDecorationLine: mine ? "underline" : "none" }}>
          {segment.text}
        </Text>
      ) : (
        <Text key={index}>{inline(segment.text, mine)}</Text>
      ))}
    </Text>
  );
}

function inline(text: string, mine?: boolean) {
  return markdownPieces(text).map((piece, index) => {
    if (piece.type === "bold") return <Text key={index} style={{ fontWeight: "700" }}>{piece.text}</Text>;
    if (piece.type === "code") return <Text key={index} style={{ fontFamily: "Menlo", backgroundColor: mine ? "#1e3a8a" : "#f3f4f6" }}>{piece.text}</Text>;
    if (piece.type === "link") return <Text key={index} style={{ textDecorationLine: "underline" }}>{piece.text}</Text>;
    if (piece.type === "list") return <Text key={index}>{`\n• ${piece.text}`}</Text>;
    return <Text key={index}>{piece.text}</Text>;
  });
}
