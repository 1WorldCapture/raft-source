import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// ../../node_modules/.pnpm/@earendil-works+pi-ai@0.84.4_@modelcontextprotocol+sdk@1.29.0_zod@4.3.6__ws@8.20.0_zod@4.3.6/node_modules/@earendil-works/pi-ai/dist/utils/headers.js
function headersToRecord(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}
function providerHeadersToRecord(headers) {
  if (!headers)
    return void 0;
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== null)
      result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : void 0;
}

export {
  headersToRecord,
  providerHeadersToRecord
};
