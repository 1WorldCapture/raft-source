import { StyleSheet, Text, type TextProps, type TextStyle } from "react-native";
import { cjkFamily, latinFamily } from "./fonts";
import { runFontFamily } from "./runFont";

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

function runs(value: string): Array<{ text: string; cjk: boolean }> {
  const parts: Array<{ text: string; cjk: boolean }> = [];
  let buffer = "";
  let cjk = false;
  for (const char of value) {
    const next = CJK.test(char);
    if (buffer && next !== cjk) {
      parts.push({ text: buffer, cjk });
      buffer = "";
    }
    cjk = next;
    buffer += char;
  }
  if (buffer) parts.push({ text: buffer, cjk });
  return parts;
}

export function AppText({ style, children, ...rest }: TextProps) {
  const flat = (StyleSheet.flatten(style) ?? {}) as TextStyle;
  const mono = flat.fontFamily === "mono";
  const family = latinFamily(typeof flat.fontWeight === "string" ? flat.fontWeight : undefined, mono);
  if (typeof children !== "string") {
    return <Text {...rest} style={[style, { fontFamily: family }]}>{children}</Text>;
  }
  return (
    <Text {...rest} style={[style, { fontFamily: family }]}>
      {runs(children).map((run, index) => (
        <Text key={`${index}-${run.cjk}`} style={{ fontFamily: runFontFamily(run.cjk, family, cjkFamily) }}>{run.text}</Text>
      ))}
    </Text>
  );
}
