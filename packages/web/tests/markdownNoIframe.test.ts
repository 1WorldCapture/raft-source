import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import MarkdownContent from "../src/components/markdown/MarkdownContent";
import {
  escapeUserRawHtmlForMessageMarkdown,
  messageMarkdownSanitizeSchema,
} from "../src/components/message/messageMarkdownSecurity";

// Desktop's embedded-app CSP allows `frame-src https:` so the HTML-attachment
// preview can be framed. That is only safe while no message/Markdown surface can
// produce an <iframe>: the only iframe JSX in the app is ui/SandboxedPreviewFrame
// (HTML/PDF preview, Mermaid viewer), all with an explicit sandbox.
const PAYLOADS = [
  '<iframe src="https://evil.example/phish"></iframe>',
  '<IFRAME SRC="https://evil.example/phish"></IFRAME>',
  'before <iframe srcdoc="<script>alert(1)</script>"></iframe> after',
  '<div><iframe src="https://evil.example"/></div>',
  "<object data=\"https://evil.example\"></object><embed src=\"https://evil.example\">",
];

for (const payload of PAYLOADS) {
  test(`no <iframe>/<object>/<embed> from message or Markdown rendering: ${payload.slice(0, 40)}`, () => {
    const outputs = [
      // Chat message path: user raw HTML is escaped, then rehypeRaw + the message allowlist.
      renderToStaticMarkup(createElement(ReactMarkdown, {
        children: escapeUserRawHtmlForMessageMarkdown(payload),
        rehypePlugins: [rehypeRaw, [rehypeSanitize, messageMarkdownSanitizeSchema]],
      })),
      // Even if a surface forgot the escape step, the allowlist drops the tags.
      renderToStaticMarkup(createElement(ReactMarkdown, {
        children: payload,
        rehypePlugins: [rehypeRaw, [rehypeSanitize, messageMarkdownSanitizeSchema]],
      })),
      // Default MarkdownContent (rehypeSanitize, no rehypeRaw).
      renderToStaticMarkup(createElement(MarkdownContent, { source: payload })),
    ];
    for (const html of outputs) {
      assert.doesNotMatch(html, /<(iframe|object|embed)\b/i, html);
    }
  });
}
