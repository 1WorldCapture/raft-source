import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// ../../node_modules/.pnpm/@earendil-works+pi-ai@0.85.1_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@earendil-works/pi-ai/dist/utils/sanitize-unicode.js
function sanitizeSurrogates(text) {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

export {
  sanitizeSurrogates
};
