import { Text } from "react-native";
import { markdownPieces } from "../model/markdown";
import { mentionSegments } from "../model/mentions";
import type { MessageMention } from "../model/messages";
import { colors } from "./theme";
import { color } from "./tokens";

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
    <Text style={{ color: mine ? color.white : colors.ink, fontSize: 16, lineHeight: 22 }}>
      {segments.map((segment, index) => segment.mention ? (
        <Text key={index} style={{ color: mine ? color.white : colors.accent, fontWeight: "700", textDecorationLine: mine ? "underline" : "none" }}>
          {segment.text}
        </Text>
      ) : (
        <Text key={index}>{inline(segment.text)}</Text>
      ))}
    </Text>
  );
}

function inline(text: string) {
  return markdownPieces(text).map((piece, index) => {
    if (piece.type === "bold") return <Text key={index} style={{ fontWeight: "700" }}>{piece.text}</Text>;
    if (piece.type === "code") return <Text key={index} style={{ fontFamily: "SpaceMono-400", backgroundColor: color.codeSurface, color: color.codeForeground }}>{piece.text}</Text>;
    if (piece.type === "link") return <Text key={index} style={{ color: color.link, textDecorationColor: color.link, textDecorationLine: "underline" }}>{piece.text}</Text>;
    if (piece.type === "list") return <Text key={index}>{`\n• ${piece.text}`}</Text>;
    return <Text key={index}>{piece.text}</Text>;
  });
}
